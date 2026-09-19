#pragma once

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <d3d11.h>
#include <wrl/client.h>
#include <functional>
#include <mutex>
#include <atomic>

// One captured frame, already staged to CPU memory and converted to
// tightly-packed RGBA8 (top-down) so the JS side can hand it straight to
// a canvas ImageData / captureStream() without any further conversion.
struct CapturedFrame {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<uint8_t> rgba;
};

// Wraps a single Windows.Graphics.Capture session against one monitor.
// Cursor exclusion is requested via GraphicsCaptureSession.IsCursorCaptureEnabled(false)
// when the running OS build exposes that property (Windows 10 2004 / build 19041+).
// This is the whole reason this module exists: unlike getDisplayMedia's cursor:'never'
// constraint (which Chromium may silently fail to honor depending on which capture
// backend it picks), this talks to Windows Graphics Capture directly, so cursor
// exclusion does not depend on Chromium's backend-selection heuristics at all.
class CaptureEngine {
 public:
  using FrameCallback = std::function<void(const CapturedFrame&)>;

  ~CaptureEngine();

  // Starts capturing the monitor identified by its HMONITOR value (see
  // EnumerateMonitors). Returns false (with errorOut set) if the current
  // Windows build/driver stack cannot create a capture session at all —
  // this is a hard capability check, not a "hope for the best" attempt.
  bool Start(uint64_t monitorHandle, FrameCallback onFrame, std::wstring& errorOut);

  // Starts capturing a single window by its HWND. Window sources go through
  // Chromium's own getDisplayMedia capture path fine on this hardware class —
  // it's full-screen sources that fail to honor cursor:'never' — but
  // Chromium's own window capturer (also WGC-backed) has been observed
  // failing ProcessFrame calls (E_FAIL) and papering over it by re-delivering
  // the last good frame, which reads as the recording freezing on one frame
  // while the real window keeps changing. Routing windows through this same,
  // already-hardened capture engine sidesteps that unreliable code path
  // entirely rather than trying to detect a frozen stream after the fact.
  bool StartWindow(uint64_t hwnd, FrameCallback onFrame, std::wstring& errorOut);
  void Stop();

  bool IsCursorExclusionSupported() const { return m_cursorExclusionSupported; }

  struct MonitorInfo {
    uint64_t handle;
    int32_t x, y, width, height;
    bool primary;
  };
  static std::vector<MonitorInfo> EnumerateMonitors();

 private:
  // Shared by Start() and StartWindow() — everything past item creation
  // (device, frame pool, cursor-exclusion, session) is identical for a
  // monitor item and a window item.
  bool StartWithItem(winrt::Windows::Graphics::Capture::GraphicsCaptureItem item,
                      FrameCallback onFrame, std::wstring& errorOut);

  void OnFrameArrived(
      winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool const& sender,
      winrt::Windows::Foundation::IInspectable const& args);
  // Fully-qualified everywhere this type appears: the Windows SDK headers
  // pulled in for D3D11/DXGI interop also declare a raw COM ::IInspectable,
  // and an unqualified `IInspectable` under `using namespace
  // winrt::Windows::Foundation` is ambiguous between the two.

  winrt::com_ptr<ID3D11Device> m_d3dDevice;
  winrt::com_ptr<ID3D11DeviceContext> m_d3dContext;
  winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice m_device{nullptr};
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem m_item{nullptr};
  winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool m_framePool{nullptr};
  winrt::Windows::Graphics::Capture::GraphicsCaptureSession m_session{nullptr};
  winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::FrameArrived_revoker m_frameArrivedRevoker;

  FrameCallback m_onFrame;
  bool m_cursorExclusionSupported = false;
  std::atomic<bool> m_running{false};
};
