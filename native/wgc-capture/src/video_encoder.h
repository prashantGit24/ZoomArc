#pragma once

#include <d3d11.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <winrt/base.h>

#include <cstdint>
#include <string>

// H.264/MP4 writer fed straight from D3D11 textures: Media Foundation's sink
// writer converts BGRA on the GPU and uses the hardware encoder when present,
// so frames never touch the CPU or the JS side.
class VideoEncoder {
 public:
  bool Open(ID3D11Device* device, const std::wstring& path, uint32_t width, uint32_t height, uint32_t fps,
            uint32_t bitrate, std::wstring& error);
  // BGRA texture of exactly width x height. Times in 100ns from video start.
  bool Write(ID3D11Texture2D* texture, int64_t time100ns, int64_t duration100ns);
  bool Close();
  bool IsOpen() const { return static_cast<bool>(m_writer); }

 private:
  winrt::com_ptr<IMFSinkWriter> m_writer;
  winrt::com_ptr<IMFDXGIDeviceManager> m_manager;
  DWORD m_stream = 0;
};
