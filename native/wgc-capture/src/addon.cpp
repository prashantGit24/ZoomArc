#include <napi.h>
#include <winrt/base.h>
#include <mutex>
#include "capture_engine.h"

namespace {

CaptureEngine g_engine;
Napi::ThreadSafeFunction g_tsfn;
std::once_flag g_apartmentInit;

// Guards every use of g_tsfn. OnFrameArrived fires on a WGC-managed capture
// thread (CreateFreeThreaded), completely independent of the JS thread that
// Stop() runs on — without this, a frame delivery already in flight when
// Stop() releases g_tsfn calls into an already-torn-down ThreadSafeFunction
// and crashes the whole process (napi_call_threadsafe_function's internal
// "(func) != nullptr" assertion). g_capturing is checked under the same lock
// that Stop() uses to clear it, so the two can never interleave unsafely:
// either the frame wins the race and gets delivered before teardown, or it
// loses and sees g_capturing already false and drops the frame instead of
// touching a released tsfn.
std::mutex g_tsfnMutex;
bool g_capturing = false;

void EnsureApartment() {
  std::call_once(g_apartmentInit, [] {
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
    } catch (winrt::hresult_error const&) {
      // Electron's main thread already initializes its own COM apartment
      // (native menus/dialogs/drag-drop), so a second init here throws
      // RPC_E_CHANGED_MODE — that's fine to ignore:
      // Direct3D11CaptureFramePool::CreateFreeThreaded doesn't require the
      // calling thread itself to be MTA, only that *an* apartment exists.
    }
  });
}

// Heap copy handed across the WinRT capture thread -> JS thread boundary via
// the ThreadSafeFunction queue; freed by the callback that runs on the JS
// thread once it has built the Napi::Buffer.
struct QueuedFrame {
  uint32_t width;
  uint32_t height;
  std::vector<uint8_t> rgba;
};

void CallJs(Napi::Env env, Napi::Function callback, QueuedFrame* data) {
  if (env != nullptr && callback != nullptr) {
    auto buffer = Napi::Buffer<uint8_t>::Copy(env, data->rgba.data(), data->rgba.size());
    Napi::Object frame = Napi::Object::New(env);
    frame.Set("width", data->width);
    frame.Set("height", data->height);
    frame.Set("buffer", buffer);
    callback.Call({frame});
  }
  delete data;
}

Napi::Value ListMonitors(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  EnsureApartment();
  auto monitors = CaptureEngine::EnumerateMonitors();
  Napi::Array out = Napi::Array::New(env, monitors.size());
  for (size_t i = 0; i < monitors.size(); i++) {
    Napi::Object m = Napi::Object::New(env);
    // HMONITOR is a pointer; keep it as a decimal string so it survives the
    // JS <-> native round trip exactly regardless of JS number precision.
    m.Set("handle", std::to_string(monitors[i].handle));
    m.Set("x", monitors[i].x);
    m.Set("y", monitors[i].y);
    m.Set("width", monitors[i].width);
    m.Set("height", monitors[i].height);
    m.Set("primary", monitors[i].primary);
    out[i] = m;
  }
  return out;
}

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  EnsureApartment();
  bool supported = false;
  try {
    supported = winrt::Windows::Graphics::Capture::GraphicsCaptureSession::IsSupported() &&
                winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
                    L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsCursorCaptureEnabled");
  } catch (...) {
    supported = false;
  }
  return Napi::Boolean::New(info.Env(), supported);
}

// Shared by Start()/StartWindow() below — everything past "which kind of
// handle and which CaptureEngine method" is identical.
Napi::Value StartCommon(const Napi::CallbackInfo& info, bool isWindow) {
  Napi::Env env = info.Env();
  EnsureApartment();

  const char* usage = isWindow ? "startWindow(hwndString, onFrame) expected"
                                : "start(monitorHandleString, onFrame) expected";
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, usage).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  uint64_t handle = std::stoull(info[0].As<Napi::String>().Utf8Value());

  // maxQueueSize = 2, not 0 (unlimited): if the JS side (IPC send -> renderer
  // -> putImageData) ever falls behind the native capture rate even briefly,
  // an unbounded queue means frames pile up faster than they drain — each is
  // ~8MB at 1080p — and both memory and CPU spiral until the whole process
  // grinds to a halt. A small bound makes NonBlockingCall start returning
  // napi_queue_full once backed up, which the capture callback below already
  // treats as "drop this frame" — exactly what should happen when JS can't
  // keep up, instead of buffering an ever-growing backlog.
  g_tsfn = Napi::ThreadSafeFunction::New(
      env, info[1].As<Napi::Function>(), "wgc-capture-frame", 2, 1);

  auto onFrame = [](const CapturedFrame& f) {
    std::lock_guard<std::mutex> lock(g_tsfnMutex);
    if (!g_capturing) return;  // Stop() already won the race; drop it.
    auto* queued = new QueuedFrame{f.width, f.height, f.rgba};
    // Non-blocking: if JS can't keep up, drop this frame rather than
    // stalling the WGC capture thread. Losing an occasional frame is
    // fine; blocking the capture callback is not.
    napi_status status = g_tsfn.NonBlockingCall(queued, CallJs);
    if (status != napi_ok) delete queued;
  };

  std::wstring error;
  bool ok = isWindow ? g_engine.StartWindow(handle, onFrame, error)
                      : g_engine.Start(handle, onFrame, error);

  if (!ok) {
    g_tsfn.Release();
    Napi::Error::New(env, std::string(error.begin(), error.end())).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  {
    std::lock_guard<std::mutex> lock(g_tsfnMutex);
    g_capturing = true;
  }
  return Napi::Boolean::New(env, true);
}

Napi::Value Start(const Napi::CallbackInfo& info) { return StartCommon(info, false); }
Napi::Value StartWindow(const Napi::CallbackInfo& info) { return StartCommon(info, true); }

Napi::Value Stop(const Napi::CallbackInfo& info) {
  g_engine.Stop();
  std::lock_guard<std::mutex> lock(g_tsfnMutex);
  g_capturing = false;
  if (g_tsfn) {
    // Abort(), not Release(): Release() drains any calls still queued before
    // tearing the ThreadSafeFunction down, which means CallJs — and the JS
    // callback it invokes — can run *during* this very Stop() call, reentering
    // JS from inside the ipcMain handler that's already on the stack calling
    // Stop() in the first place. That reentrant call was the actual cause of
    // an intermittent crash right after stopping a recording (confirmed via
    // temporary diagnostic logging: CallJs firing after Stop() had already
    // completed). Abort() discards anything still queued instead — losing the
    // last frame or two right at the end of a take is unnoticeable; a
    // reentrant callback firing at an arbitrary point during teardown is not
    // something to risk for it.
    g_tsfn.Abort();
    g_tsfn = Napi::ThreadSafeFunction();
  }
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("listMonitors", Napi::Function::New(env, ListMonitors));
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("startWindow", Napi::Function::New(env, StartWindow));
  exports.Set("stop", Napi::Function::New(env, Stop));
  return exports;
}

}  // namespace

NODE_API_MODULE(wgc_capture, Init)
