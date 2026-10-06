#pragma once

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <d3d11.h>

#include <atomic>
#include <mutex>
#include <string>
#include <vector>

#include "video_encoder.h"

// Records one monitor or window with Windows.Graphics.Capture straight into a
// hardware-encoded H.264 MP4. The system cursor is excluded from the pixels
// (IsCursorCaptureEnabled(false)); it is sampled separately as data (see
// CursorSampler) on the same QPC clock as the frames' SystemRelativeTime.
class CaptureEngine {
 public:
  struct Options {
    std::wstring path;
    uint32_t bitrate = 16'000'000;
    uint32_t fps = 60;
  };
  struct Result {
    bool ok = false;
    std::wstring error;
    uint32_t frames = 0;
    uint32_t arrivals = 0;  // frames Windows delivered, before the fps cap
    uint32_t width = 0;
    uint32_t height = 0;
    int64_t firstFrame100ns = 0;  // QPC time of video t=0
    int64_t stop100ns = 0;
    double firstFrameWallMs = 0;  // video t=0 on the Date.now() clock
  };

  ~CaptureEngine();

  bool StartMonitor(uint64_t monitorHandle, const Options& opts, std::wstring& error);
  bool StartWindow(uint64_t hwnd, const Options& opts, std::wstring& error);
  // Blocking: stops capture and finalizes the file.
  Result Stop();

  uint32_t Width() const { return m_width; }
  uint32_t Height() const { return m_height; }

  struct MonitorInfo {
    uint64_t handle;
    int32_t x, y, width, height;
    bool primary;
  };
  static std::vector<MonitorInfo> EnumerateMonitors();

  struct RectInfo {
    int32_t x, y, width, height;
    bool ok;
  };
  // DWM extended frame bounds (what WGC actually captures), physical pixels.
  static RectInfo GetWindowBounds(uint64_t hwnd);

  // One cursor-free frame of a monitor, downscaled to maxWidth, as BGRA —
  // for source-picker previews Chromium can't produce (e.g. monitors on the
  // other GPU of a hybrid laptop). Uses its own short-lived device so it
  // never touches a recording in progress.
  struct Thumbnail {
    bool ok = false;
    uint32_t width = 0;
    uint32_t height = 0;
    std::vector<uint8_t> bgra;
    std::wstring error;
  };
  static Thumbnail CaptureMonitorThumbnail(uint64_t monitorHandle, uint32_t maxWidth);

 private:
  bool StartWithItem(winrt::Windows::Graphics::Capture::GraphicsCaptureItem item, HMONITOR monitor,
                     const Options& opts, std::wstring& error);
  void OnFrameArrived(winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool const& sender,
                      winrt::Windows::Foundation::IInspectable const& args);
  void WritePending(int64_t until100ns);

  LUID m_adapterLuid{};
  winrt::com_ptr<ID3D11Device> m_d3dDevice;
  winrt::com_ptr<ID3D11DeviceContext> m_d3dContext;
  winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice m_device{nullptr};
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem m_item{nullptr};
  winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool m_framePool{nullptr};
  winrt::Windows::Graphics::Capture::GraphicsCaptureSession m_session{nullptr};
  winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::FrameArrived_revoker m_frameArrivedRevoker;

  std::mutex m_frameMutex;  // serializes frame handling against Stop()
  std::atomic<bool> m_running{false};
  VideoEncoder m_encoder;
  std::wstring m_error;

  uint32_t m_width = 0;
  uint32_t m_height = 0;
  int64_t m_slot100ns = 166'666;
  int64_t m_lastSlot = -1;

  // Each frame is written once the next one arrives, so its duration is the
  // real time it stayed on screen (the capture is variable-frame-rate: a
  // still screen produces no new frames).
  winrt::com_ptr<ID3D11Texture2D> m_pending;
  int64_t m_pendingTime = 0;
  int64_t m_first = -1;
  double m_firstWallMs = 0;
  uint32_t m_frames = 0;
  uint32_t m_arrivals = 0;
};
