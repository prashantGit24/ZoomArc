#include <napi.h>
#include <winrt/base.h>

#include <mutex>
#include <string>

#include "capture_engine.h"
#include "cursor_sampler.h"

namespace {

CaptureEngine g_engine;
CursorSampler g_cursor;
std::once_flag g_apartmentInit;
bool g_recording = false;

void EnsureApartment() {
  std::call_once(g_apartmentInit, [] {
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
    } catch (winrt::hresult_error const&) {
      // Electron's main thread already has a COM apartment (RPC_E_CHANGED_MODE);
      // free-threaded capture only needs one to exist.
    }
  });
}

std::wstring Widen(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), n);
  return out;
}

std::string Narrow(const std::wstring& s) {
  if (s.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0, nullptr, nullptr);
  std::string out(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), n, nullptr, nullptr);
  return out;
}

Napi::Value ListMonitors(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto monitors = CaptureEngine::EnumerateMonitors();
  Napi::Array arr = Napi::Array::New(env, monitors.size());
  for (size_t i = 0; i < monitors.size(); i++) {
    Napi::Object m = Napi::Object::New(env);
    m.Set("handle", std::to_string(monitors[i].handle));
    m.Set("x", monitors[i].x);
    m.Set("y", monitors[i].y);
    m.Set("width", monitors[i].width);
    m.Set("height", monitors[i].height);
    m.Set("primary", monitors[i].primary);
    arr.Set(static_cast<uint32_t>(i), m);
  }
  return arr;
}

Napi::Value GetWindowBounds(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "getWindowBounds(hwndString) expected").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto r = CaptureEngine::GetWindowBounds(std::stoull(info[0].As<Napi::String>().Utf8Value()));
  Napi::Object out = Napi::Object::New(env);
  out.Set("ok", r.ok);
  out.Set("x", r.x);
  out.Set("y", r.y);
  out.Set("width", r.width);
  out.Set("height", r.height);
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

// startRecording({ kind: 'monitor'|'window', handle, path, bitrate?, fps? }) -> { width, height }
Napi::Value StartRecording(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  EnsureApartment();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "startRecording(options) expected").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (g_recording) {
    Napi::Error::New(env, "A recording is already running").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto o = info[0].As<Napi::Object>();
  const std::string kind = o.Get("kind").ToString().Utf8Value();
  const uint64_t handle = std::stoull(o.Get("handle").ToString().Utf8Value());
  CaptureEngine::Options opts;
  opts.path = Widen(o.Get("path").ToString().Utf8Value());
  if (o.Get("bitrate").IsNumber()) opts.bitrate = o.Get("bitrate").As<Napi::Number>().Uint32Value();
  if (o.Get("fps").IsNumber()) opts.fps = o.Get("fps").As<Napi::Number>().Uint32Value();

  const bool isWindow = kind == "window";
  // Cursor first, so there is a sample from before the very first frame.
  g_cursor.Start(isWindow ? reinterpret_cast<HWND>(handle) : nullptr);
  std::wstring error;
  const bool ok = isWindow ? g_engine.StartWindow(handle, opts, error) : g_engine.StartMonitor(handle, opts, error);
  if (!ok) {
    g_cursor.Stop();
    g_cursor.Take();
    Napi::Error::New(env, Narrow(error)).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  g_recording = true;
  Napi::Object out = Napi::Object::New(env);
  out.Set("width", g_engine.Width());
  out.Set("height", g_engine.Height());
  return out;
}

const char* TypeName(uint8_t t) {
  switch (t) {
    case CursorSampler::Down: return "down";
    case CursorSampler::Up: return "up";
    case CursorSampler::Hide: return "hide";
    case CursorSampler::Show: return "show";
    case CursorSampler::Bounds: return "bounds";
    default: return "move";
  }
}

class StopWorker : public Napi::AsyncWorker {
 public:
  explicit StopWorker(Napi::Env env) : Napi::AsyncWorker(env), m_deferred(Napi::Promise::Deferred::New(env)) {}
  Napi::Promise Promise() { return m_deferred.Promise(); }

  void Execute() override {
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
    } catch (...) {
    }
    m_result = g_engine.Stop();
    g_cursor.Stop();
    m_polls = g_cursor.Polls();
    m_events = g_cursor.Take();
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object out = Napi::Object::New(env);
    out.Set("ok", m_result.ok);
    out.Set("error", Narrow(m_result.error));
    out.Set("frames", m_result.frames);
    out.Set("arrivals", m_result.arrivals);
    out.Set("cursorPolls", static_cast<double>(m_polls));    out.Set("width", m_result.width);
    out.Set("height", m_result.height);
    out.Set("firstFrameWallMs", m_result.firstFrameWallMs);
    const double first = static_cast<double>(m_result.firstFrame100ns);
    out.Set("durationMs", (static_cast<double>(m_result.stop100ns) - first) / 10'000.0);

    // t: milliseconds on the video's own timeline (frame 0 = 0; samples from
    // just before it are negative).
    Napi::Array arr = Napi::Array::New(env, m_events.size());
    for (size_t i = 0; i < m_events.size(); i++) {
      const auto& e = m_events[i];
      Napi::Object ev = Napi::Object::New(env);
      ev.Set("t", (static_cast<double>(e.t100ns) - first) / 10'000.0);
      ev.Set("x", e.x);
      ev.Set("y", e.y);
      ev.Set("type", TypeName(e.type));
      if (e.button) ev.Set("button", e.button);
      if (e.type == CursorSampler::Bounds) {
        ev.Set("width", e.w);
        ev.Set("height", e.h);
      }
      arr.Set(static_cast<uint32_t>(i), ev);
    }
    out.Set("cursor", arr);
    m_deferred.Resolve(out);
  }

  void OnError(const Napi::Error& e) override { m_deferred.Reject(e.Value()); }

 private:
  Napi::Promise::Deferred m_deferred;
  CaptureEngine::Result m_result;
  std::vector<CursorSampler::Event> m_events;
  uint64_t m_polls = 0;
};

class ThumbnailWorker : public Napi::AsyncWorker {
 public:
  ThumbnailWorker(Napi::Env env, uint64_t monitor, uint32_t maxWidth)
      : Napi::AsyncWorker(env), m_deferred(Napi::Promise::Deferred::New(env)), m_monitor(monitor), m_maxWidth(maxWidth) {}
  Napi::Promise Promise() { return m_deferred.Promise(); }

  void Execute() override {
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
    } catch (...) {
    }
    m_thumb = CaptureEngine::CaptureMonitorThumbnail(m_monitor, m_maxWidth);
  }

  void OnOK() override {
    Napi::Env env = Env();
    if (!m_thumb.ok) {
      m_deferred.Resolve(env.Null());
      return;
    }
    Napi::Object out = Napi::Object::New(env);
    out.Set("width", m_thumb.width);
    out.Set("height", m_thumb.height);
    out.Set("bgra", Napi::Buffer<uint8_t>::Copy(env, m_thumb.bgra.data(), m_thumb.bgra.size()));
    m_deferred.Resolve(out);
  }

  void OnError(const Napi::Error& e) override { m_deferred.Reject(e.Value()); }

 private:
  Napi::Promise::Deferred m_deferred;
  uint64_t m_monitor;
  uint32_t m_maxWidth;
  CaptureEngine::Thumbnail m_thumb;
};

// captureMonitorThumbnail(handleString, maxWidth) -> Promise<{ width, height, bgra } | null>
Napi::Value CaptureMonitorThumbnail(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "captureMonitorThumbnail(handleString, maxWidth) expected").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  EnsureApartment();
  const uint64_t handle = std::stoull(info[0].As<Napi::String>().Utf8Value());
  const uint32_t maxWidth = info.Length() > 1 && info[1].IsNumber() ? info[1].As<Napi::Number>().Uint32Value() : 480;
  auto* worker = new ThumbnailWorker(env, handle, maxWidth);
  auto promise = worker->Promise();
  worker->Queue();
  return promise;
}

Napi::Value StopRecording(const Napi::CallbackInfo& info) {
  g_recording = false;
  auto* worker = new StopWorker(info.Env());
  auto promise = worker->Promise();
  worker->Queue();
  return promise;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("listMonitors", Napi::Function::New(env, ListMonitors));
  exports.Set("getWindowBounds", Napi::Function::New(env, GetWindowBounds));
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  exports.Set("startRecording", Napi::Function::New(env, StartRecording));
  exports.Set("stopRecording", Napi::Function::New(env, StopRecording));
  exports.Set("captureMonitorThumbnail", Napi::Function::New(env, CaptureMonitorThumbnail));
  return exports;
}

}  // namespace

NODE_API_MODULE(wgc_capture, Init)
