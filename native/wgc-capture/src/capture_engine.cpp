#include "capture_engine.h"

#include <dxgi1_2.h>
#include <windows.h>

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
  winrt::check_hresult(interopFactory->CreateForMonitor(
      hmon, winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(item)));
  return item;
}

GraphicsCaptureItem CreateItemForWindow(HWND hwnd) {
  auto interopFactory = winrt::get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  GraphicsCaptureItem item{nullptr};
  winrt::check_hresult(interopFactory->CreateForWindow(
      hwnd, winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(item)));
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

}  // namespace

std::vector<CaptureEngine::MonitorInfo> CaptureEngine::EnumerateMonitors() {
  std::vector<MonitorInfo> monitors;
  EnumDisplayMonitors(nullptr, nullptr, MonitorEnumProc, reinterpret_cast<LPARAM>(&monitors));
  return monitors;
}

CaptureEngine::~CaptureEngine() { Stop(); }

bool CaptureEngine::Start(uint64_t monitorHandle, FrameCallback onFrame, std::wstring& errorOut) {
  try {
    return StartWithItem(CreateItemForMonitor(reinterpret_cast<HMONITOR>(monitorHandle)),
                          std::move(onFrame), errorOut);
  } catch (winrt::hresult_error const& e) {
    errorOut = e.message().c_str();
    return false;
  }
}

bool CaptureEngine::StartWindow(uint64_t hwnd, FrameCallback onFrame, std::wstring& errorOut) {
  try {
    return StartWithItem(CreateItemForWindow(reinterpret_cast<HWND>(hwnd)), std::move(onFrame),
                          errorOut);
  } catch (winrt::hresult_error const& e) {
    errorOut = e.message().c_str();
    return false;
  }
}

bool CaptureEngine::StartWithItem(GraphicsCaptureItem item, FrameCallback onFrame,
                                   std::wstring& errorOut) {
  if (m_running.load()) {
    errorOut = L"Capture already running";
    return false;
  }

  try {
    if (!GraphicsCaptureSession::IsSupported()) {
      errorOut = L"Windows Graphics Capture is not supported on this system";
      return false;
    }

    m_item = item;

    // Created once and reused across recordings rather than per-Start(): this
    // used to create (and Stop() would tear down) a brand new D3D11 device on
    // every single recording. Repeated device create/destroy churn is a much
    // heavier, more failure-prone operation than reusing an existing device,
    // and on this class of hardware (a hybrid-GPU laptop with a known-stale
    // iGPU driver — see the driver-update investigation this whole native
    // module exists because of) repeated churn is the most likely explanation
    // for an intermittent native crash observed after several back-to-back
    // record/stop cycles in testing, with no JS-catchable error and no crash
    // dump — consistent with driver-level instability under create/destroy
    // stress rather than a logic bug in this code.
    if (!m_d3dDevice) {
      D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
      winrt::check_hresult(D3D11CreateDevice(
          nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
          levels, ARRAYSIZE(levels), D3D11_SDK_VERSION, m_d3dDevice.put(), nullptr,
          m_d3dContext.put()));

      auto dxgiDevice = m_d3dDevice.as<IDXGIDevice>();
      m_device = CreateDirect3DDeviceFromDxgi(dxgiDevice.get());
    }

    m_framePool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        m_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, m_item.Size());
    m_session = m_framePool.CreateCaptureSession(m_item);

    // The whole point of this native path: guarantee cursor exclusion instead
    // of hoping Chromium picked a backend that honors cursor:'never'. Only
    // available from Windows 10 2004 (build 19041) onward — checked at
    // runtime, never assumed from the SDK version this was compiled against.
    m_cursorExclusionSupported = winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
        L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsCursorCaptureEnabled");
    if (m_cursorExclusionSupported) {
      m_session.IsCursorCaptureEnabled(false);
    } else {
      errorOut = L"This Windows build cannot exclude the cursor from Windows Graphics Capture";
      m_framePool.Close();
      m_framePool = nullptr;
      return false;
    }

    m_onFrame = std::move(onFrame);
    m_frameArrivedRevoker = m_framePool.FrameArrived(
        winrt::auto_revoke, {this, &CaptureEngine::OnFrameArrived});

    m_session.StartCapture();
    m_running.store(true);
    return true;
  } catch (winrt::hresult_error const& e) {
    errorOut = e.message().c_str();
    return false;
  }
}

void CaptureEngine::Stop() {
  if (!m_running.exchange(false)) return;
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
  // m_d3dDevice/m_d3dContext/m_device deliberately outlive Stop() — see the
  // comment in StartWithItem on why the device is created once and reused.
}

void CaptureEngine::OnFrameArrived(
    Direct3D11CaptureFramePool const& sender, winrt::Windows::Foundation::IInspectable const&) {
  auto frame = sender.TryGetNextFrame();
  if (!frame) return;

  auto surface = frame.Surface();
  auto access = surface.as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
  winrt::com_ptr<ID3D11Texture2D> frameTexture;
  winrt::check_hresult(access->GetInterface(winrt::guid_of<ID3D11Texture2D>(), frameTexture.put_void()));

  D3D11_TEXTURE2D_DESC desc;
  frameTexture->GetDesc(&desc);

  D3D11_TEXTURE2D_DESC stagingDesc = desc;
  stagingDesc.Usage = D3D11_USAGE_STAGING;
  stagingDesc.BindFlags = 0;
  stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  stagingDesc.MiscFlags = 0;

  winrt::com_ptr<ID3D11Texture2D> staging;
  if (FAILED(m_d3dDevice->CreateTexture2D(&stagingDesc, nullptr, staging.put()))) return;
  m_d3dContext->CopyResource(staging.get(), frameTexture.get());

  D3D11_MAPPED_SUBRESOURCE mapped;
  if (FAILED(m_d3dContext->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped))) return;

  CapturedFrame out;
  out.width = desc.Width;
  out.height = desc.Height;
  out.rgba.resize(static_cast<size_t>(desc.Width) * desc.Height * 4);

  // WGC hands us BGRA8; the canvas ImageData path on the JS side wants RGBA8,
  // so swap R/B here once, on the CPU copy, rather than pushing that cost
  // (and the extra format concept) across the addon boundary.
  const uint8_t* src = static_cast<const uint8_t*>(mapped.pData);
  uint8_t* dst = out.rgba.data();
  for (uint32_t y = 0; y < desc.Height; y++) {
    const uint8_t* srow = src + static_cast<size_t>(y) * mapped.RowPitch;
    uint8_t* drow = dst + static_cast<size_t>(y) * desc.Width * 4;
    for (uint32_t x = 0; x < desc.Width; x++) {
      drow[x * 4 + 0] = srow[x * 4 + 2];  // R <- B
      drow[x * 4 + 1] = srow[x * 4 + 1];  // G
      drow[x * 4 + 2] = srow[x * 4 + 0];  // B <- R
      drow[x * 4 + 3] = srow[x * 4 + 3];  // A
    }
  }

  m_d3dContext->Unmap(staging.get(), 0);

  if (m_onFrame) m_onFrame(out);
}
