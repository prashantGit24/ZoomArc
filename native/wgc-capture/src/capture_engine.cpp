#include "capture_engine.h"

#include <d3d10_1.h>
#include <dxgi1_2.h>
#include <dwmapi.h>
#include <windows.h>

#include <algorithm>

#include "qpc_time.h"

using namespace winrt;
using namespace winrt::Windows::Foundation;
using namespace winrt::Windows::Graphics;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;

namespace {

IDirect3DDevice CreateDirect3DDeviceFromDxgi(IDXGIDevice* dxgiDevice) {
  winrt::com_ptr<::IInspectable> inspectable;
  winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice, inspectable.put()));
  return inspectable.as<IDirect3DDevice>();
}

GraphicsCaptureItem CreateItemForMonitor(HMONITOR hmon) {
  auto interopFactory = winrt::get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  GraphicsCaptureItem item{nullptr};
  winrt::check_hresult(
      interopFactory->CreateForMonitor(hmon, winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(item)));
  return item;
}

GraphicsCaptureItem CreateItemForWindow(HWND hwnd) {
  auto interopFactory = winrt::get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  GraphicsCaptureItem item{nullptr};
  winrt::check_hresult(
      interopFactory->CreateForWindow(hwnd, winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(item)));
  return item;
}

BOOL CALLBACK MonitorEnumProc(HMONITOR hmon, HDC, LPRECT, LPARAM lparam) {
  auto* out = reinterpret_cast<std::vector<CaptureEngine::MonitorInfo>*>(lparam);
  MONITORINFO mi{};
  mi.cbSize = sizeof(mi);
  if (GetMonitorInfoW(hmon, &mi)) {
    CaptureEngine::MonitorInfo info{};
    info.handle = reinterpret_cast<uint64_t>(hmon);
    info.x = mi.rcMonitor.left;
    info.y = mi.rcMonitor.top;
    info.width = mi.rcMonitor.right - mi.rcMonitor.left;
    info.height = mi.rcMonitor.bottom - mi.rcMonitor.top;
    info.primary = (mi.dwFlags & MONITORINFOF_PRIMARY) != 0;
    out->push_back(info);
  }
  return TRUE;
}

// The GPU whose output drives this monitor. Capturing on any other GPU (hybrid
// laptops) forces a cross-adapter copy per frame, which throttles delivery.
winrt::com_ptr<IDXGIAdapter1> AdapterForMonitor(HMONITOR hmon) {
  winrt::com_ptr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), factory.put_void()))) return nullptr;
  for (UINT i = 0;; i++) {
    winrt::com_ptr<IDXGIAdapter1> adapter;
    if (factory->EnumAdapters1(i, adapter.put()) == DXGI_ERROR_NOT_FOUND) break;
    for (UINT j = 0;; j++) {
      winrt::com_ptr<IDXGIOutput> output;
      if (adapter->EnumOutputs(j, output.put()) == DXGI_ERROR_NOT_FOUND) break;
      DXGI_OUTPUT_DESC desc;
      if (SUCCEEDED(output->GetDesc(&desc)) && desc.Monitor == hmon) return adapter;
    }
  }
  return nullptr;
}

}  // namespace

std::vector<CaptureEngine::MonitorInfo> CaptureEngine::EnumerateMonitors() {
  std::vector<MonitorInfo> monitors;
  EnumDisplayMonitors(nullptr, nullptr, MonitorEnumProc, reinterpret_cast<LPARAM>(&monitors));
  return monitors;
}

CaptureEngine::RectInfo CaptureEngine::GetWindowBounds(uint64_t hwnd) {
  HWND h = reinterpret_cast<HWND>(hwnd);
  RECT r{};
  // Plain GetWindowRect includes the invisible resize border Windows 10/11
  // adds around windows, which WGC doesn't capture.
  if (FAILED(DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &r, sizeof(r)))) {
    if (!GetWindowRect(h, &r)) return {0, 0, 0, 0, false};
  }
  return {r.left, r.top, r.right - r.left, r.bottom - r.top, true};
}

CaptureEngine::Thumbnail CaptureEngine::CaptureMonitorThumbnail(uint64_t monitorHandle, uint32_t maxWidth) {
  Thumbnail out;
  try {
    const HMONITOR hmon = reinterpret_cast<HMONITOR>(monitorHandle);
    auto adapter = AdapterForMonitor(hmon);
    winrt::com_ptr<ID3D11Device> device;
    winrt::com_ptr<ID3D11DeviceContext> context;
    D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    winrt::check_hresult(D3D11CreateDevice(adapter.get(), adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE,
                                           nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, ARRAYSIZE(levels),
                                           D3D11_SDK_VERSION, device.put(), nullptr, context.put()));
    auto rtDevice = CreateDirect3DDeviceFromDxgi(device.as<IDXGIDevice>().get());

    auto item = CreateItemForMonitor(hmon);
    const auto size = item.Size();
    auto pool = Direct3D11CaptureFramePool::CreateFreeThreaded(rtDevice, DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, size);
    auto session = pool.CreateCaptureSession(item);
    if (winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
            L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsCursorCaptureEnabled")) {
      session.IsCursorCaptureEnabled(false);
    }
    // Avoid flashing the yellow "being captured" border for a preview grab.
    if (winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
            L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired")) {
      try {
        session.IsBorderRequired(false);
      } catch (...) {
      }
    }

    HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    auto revoker = pool.FrameArrived(winrt::auto_revoke, [ready](auto&&, auto&&) { SetEvent(ready); });
    session.StartCapture();
    const bool got = WaitForSingleObject(ready, 1500) == WAIT_OBJECT_0;
    CloseHandle(ready);
    auto frame = got ? pool.TryGetNextFrame() : nullptr;
    revoker.revoke();
    if (!frame) {
      session.Close();
      pool.Close();
      out.error = L"No frame arrived";
      return out;
    }

    auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    winrt::com_ptr<ID3D11Texture2D> source;
    winrt::check_hresult(access->GetInterface(winrt::guid_of<ID3D11Texture2D>(), source.put_void()));
    D3D11_TEXTURE2D_DESC desc;
    source->GetDesc(&desc);
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.MiscFlags = 0;
    winrt::com_ptr<ID3D11Texture2D> staging;
    winrt::check_hresult(device->CreateTexture2D(&desc, nullptr, staging.put()));
    context->CopyResource(staging.get(), source.get());
    frame.Close();
    session.Close();
    pool.Close();

    D3D11_MAPPED_SUBRESOURCE mapped;
    winrt::check_hresult(context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped));
    const uint32_t sw = std::min<uint32_t>(desc.Width, static_cast<uint32_t>(size.Width));
    const uint32_t sh = std::min<uint32_t>(desc.Height, static_cast<uint32_t>(size.Height));
    const uint32_t tw = std::max<uint32_t>(1, std::min(maxWidth, sw));
    const uint32_t th = std::max<uint32_t>(1, static_cast<uint32_t>(static_cast<uint64_t>(sh) * tw / sw));
    out.bgra.resize(static_cast<size_t>(tw) * th * 4);
    // Box filter: average every source pixel that lands in each target pixel.
    const uint8_t* src = static_cast<const uint8_t*>(mapped.pData);
    for (uint32_t y = 0; y < th; y++) {
      const uint32_t y0 = y * sh / th, y1 = std::max(y0 + 1, (y + 1) * sh / th);
      for (uint32_t x = 0; x < tw; x++) {
        const uint32_t x0 = x * sw / tw, x1 = std::max(x0 + 1, (x + 1) * sw / tw);
        uint32_t acc[4] = {0, 0, 0, 0};
        for (uint32_t yy = y0; yy < y1; yy++) {
          const uint8_t* row = src + static_cast<size_t>(yy) * mapped.RowPitch;
          for (uint32_t xx = x0; xx < x1; xx++) {
            for (int c = 0; c < 4; c++) acc[c] += row[xx * 4 + c];
          }
        }
        const uint32_t n = (y1 - y0) * (x1 - x0);
        uint8_t* dst = &out.bgra[(static_cast<size_t>(y) * tw + x) * 4];
        dst[0] = static_cast<uint8_t>(acc[0] / n);
        dst[1] = static_cast<uint8_t>(acc[1] / n);
        dst[2] = static_cast<uint8_t>(acc[2] / n);
        dst[3] = 255;
      }
    }
    context->Unmap(staging.get(), 0);
    out.width = tw;
    out.height = th;
    out.ok = true;
  } catch (winrt::hresult_error const& e) {
    out.error = e.message().c_str();
  }
  return out;
}

CaptureEngine::~CaptureEngine() { Stop(); }

bool CaptureEngine::StartMonitor(uint64_t monitorHandle, const Options& opts, std::wstring& error) {
  try {
    const HMONITOR hmon = reinterpret_cast<HMONITOR>(monitorHandle);
    return StartWithItem(CreateItemForMonitor(hmon), hmon, opts, error);
  } catch (winrt::hresult_error const& e) {
    error = e.message().c_str();
    return false;
  }
}

bool CaptureEngine::StartWindow(uint64_t hwnd, const Options& opts, std::wstring& error) {
  try {
    const HWND h = reinterpret_cast<HWND>(hwnd);
    return StartWithItem(CreateItemForWindow(h), MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), opts, error);
  } catch (winrt::hresult_error const& e) {
    error = e.message().c_str();
    return false;
  }
}

bool CaptureEngine::StartWithItem(GraphicsCaptureItem item, HMONITOR monitor, const Options& opts,
                                  std::wstring& error) {
  if (m_running.load()) {
    error = L"Capture already running";
    return false;
  }

  try {
    if (!GraphicsCaptureSession::IsSupported()) {
      error = L"Windows Graphics Capture is not supported on this system";
      return false;
    }
    if (!winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
            L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsCursorCaptureEnabled")) {
      error = L"This Windows build cannot exclude the cursor from Windows Graphics Capture";
      return false;
    }

    // Reused across recordings (device create/destroy churn proved unstable on
    // hybrid-GPU drivers) — only recreated when a recording needs another GPU.
    auto adapter = AdapterForMonitor(monitor);
    LUID luid{};
    if (adapter) {
      DXGI_ADAPTER_DESC1 desc;
      adapter->GetDesc1(&desc);
      luid = desc.AdapterLuid;
    }
    const bool sameAdapter = luid.LowPart == m_adapterLuid.LowPart && luid.HighPart == m_adapterLuid.HighPart;
    if (m_d3dDevice && !sameAdapter) {
      m_device = nullptr;
      m_d3dContext = nullptr;
      m_d3dDevice = nullptr;
    }
    if (!m_d3dDevice) {
      D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
      winrt::check_hresult(D3D11CreateDevice(
          adapter.get(), adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE, nullptr,
          D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, levels, ARRAYSIZE(levels),
          D3D11_SDK_VERSION, m_d3dDevice.put(), nullptr, m_d3dContext.put()));
      m_adapterLuid = luid;
      // The capture thread and the encoder (via Media Foundation) share it.
      if (auto mt = m_d3dDevice.try_as<ID3D10Multithread>()) mt->SetMultithreadProtected(TRUE);
      m_device = CreateDirect3DDeviceFromDxgi(m_d3dDevice.as<IDXGIDevice>().get());
    }

    m_item = item;
    const auto size = m_item.Size();
    // H.264 needs even dimensions.
    m_width = std::max<uint32_t>(2, static_cast<uint32_t>(size.Width) & ~1u);
    m_height = std::max<uint32_t>(2, static_cast<uint32_t>(size.Height) & ~1u);
    const uint32_t fps = opts.fps ? opts.fps : 60;
    m_slot100ns = 10'000'000 / fps;
    m_lastSlot = -1;

    m_error.clear();
    m_pending = nullptr;
    m_first = -1;
    m_frames = 0;
    m_arrivals = 0;
    if (!m_encoder.Open(m_d3dDevice.get(), opts.path, m_width, m_height, fps, opts.bitrate, error)) {
      m_item = nullptr;
      return false;
    }

    m_framePool = Direct3D11CaptureFramePool::CreateFreeThreaded(m_device, DirectXPixelFormat::B8G8R8A8UIntNormalized,
                                                                 3, size);
    m_session = m_framePool.CreateCaptureSession(m_item);
    m_session.IsCursorCaptureEnabled(false);
    // Windows 11 24H2+: let frames through as fast as the display composes
    // them (the fps grid in OnFrameArrived does the capping).
    if (winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
            L"Windows.Graphics.Capture.GraphicsCaptureSession", L"MinUpdateInterval")) {
      m_session.MinUpdateInterval(std::chrono::milliseconds(1));
    }

    m_frameArrivedRevoker = m_framePool.FrameArrived(winrt::auto_revoke, {this, &CaptureEngine::OnFrameArrived});
    m_running.store(true);
    m_session.StartCapture();
    return true;
  } catch (winrt::hresult_error const& e) {
    error = e.message().c_str();
    m_encoder.Close();
    return false;
  }
}

void CaptureEngine::OnFrameArrived(Direct3D11CaptureFramePool const& sender,
                                   winrt::Windows::Foundation::IInspectable const&) {
  std::lock_guard<std::mutex> lock(m_frameMutex);
  auto frame = sender.TryGetNextFrame();
  if (!frame || !m_running.load()) return;
  m_arrivals++;

  const int64_t t = frame.SystemRelativeTime().count();
  // One frame per slot of a fixed fps grid: averages exactly the target rate
  // whatever the display's refresh (60/120/144Hz), unlike a minimum-gap rule.
  int64_t slot = 0;
  if (m_first >= 0) {
    slot = (t - m_first) / m_slot100ns;
    if (slot <= m_lastSlot) return;
  }

  try {
    auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    winrt::com_ptr<ID3D11Texture2D> source;
    winrt::check_hresult(access->GetInterface(winrt::guid_of<ID3D11Texture2D>(), source.put_void()));

    // The encoder reads its input asynchronously, so each frame gets its own
    // texture rather than a recycled one that could be overwritten mid-encode.
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = m_width;
    desc.Height = m_height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    winrt::com_ptr<ID3D11Texture2D> copy;
    winrt::check_hresult(m_d3dDevice->CreateTexture2D(&desc, nullptr, copy.put()));

    D3D11_TEXTURE2D_DESC srcDesc;
    source->GetDesc(&srcDesc);
    const auto content = frame.ContentSize();
    const uint32_t cw = std::min({m_width, static_cast<uint32_t>(content.Width), srcDesc.Width});
    const uint32_t ch = std::min({m_height, static_cast<uint32_t>(content.Height), srcDesc.Height});
    if (cw < m_width || ch < m_height) {
      // A window that shrank: black instead of uninitialized memory.
      winrt::com_ptr<ID3D11RenderTargetView> rtv;
      if (SUCCEEDED(m_d3dDevice->CreateRenderTargetView(copy.get(), nullptr, rtv.put()))) {
        const float black[4] = {0, 0, 0, 1};
        m_d3dContext->ClearRenderTargetView(rtv.get(), black);
      }
    }
    D3D11_BOX box{0, 0, 0, cw, ch, 1};
    m_d3dContext->CopySubresourceRegion(copy.get(), 0, 0, 0, 0, source.get(), 0, &box);

    if (m_first < 0) {
      m_first = t;
      m_firstWallMs = WallNowMs() - static_cast<double>(QpcNow100ns() - t) / 10'000.0;
    } else {
      WritePending(t);
    }
    m_pending = copy;
    m_pendingTime = t;
    m_lastSlot = slot;
    m_frames++;
  } catch (winrt::hresult_error const& e) {
    if (m_error.empty()) m_error = e.message().c_str();
  }
}

void CaptureEngine::WritePending(int64_t until100ns) {
  if (!m_pending) return;
  const int64_t duration = std::max<int64_t>(until100ns - m_pendingTime, 10'000);
  if (!m_encoder.Write(m_pending.get(), m_pendingTime - m_first, duration) && m_error.empty()) {
    m_error = L"The video encoder stopped accepting frames";
  }
  m_pending = nullptr;
}

CaptureEngine::Result CaptureEngine::Stop() {
  Result result;
  const int64_t stopAt = QpcNow100ns();
  if (!m_running.exchange(false)) return result;

  m_frameArrivedRevoker.revoke();
  if (m_session) {
    m_session.Close();
    m_session = nullptr;
  }
  if (m_framePool) {
    m_framePool.Close();
    m_framePool = nullptr;
  }
  m_item = nullptr;

  std::lock_guard<std::mutex> lock(m_frameMutex);
  // The last frame stays on screen until the moment recording stopped.
  WritePending(std::max(stopAt, m_pendingTime + 10'000));
  const bool closed = m_encoder.Close();

  result.frames = m_frames;
  result.arrivals = m_arrivals;
  result.width = m_width;
  result.height = m_height;
  result.firstFrame100ns = m_first;
  result.stop100ns = stopAt;
  result.firstFrameWallMs = m_firstWallMs;
  result.error = m_error;
  result.ok = m_frames > 0 && closed && m_error.empty();
  if (m_frames == 0 && result.error.empty()) result.error = L"No frames were captured";
  return result;
}
