#include "video_encoder.h"

#include <codecapi.h>
#include <mferror.h>

#include <mutex>

namespace {

std::once_flag g_mfStartup;

std::wstring HrMessage(const wchar_t* what, HRESULT hr) {
  wchar_t buf[64];
  swprintf_s(buf, L" (0x%08X)", static_cast<unsigned>(hr));
  return std::wstring(what) + buf;
}

}  // namespace

bool VideoEncoder::Open(ID3D11Device* device, const std::wstring& path, uint32_t width, uint32_t height,
                        uint32_t fps, uint32_t bitrate, std::wstring& error) {
  std::call_once(g_mfStartup, [] { MFStartup(MF_VERSION, MFSTARTUP_FULL); });

  HRESULT hr;
  UINT token = 0;
  if (FAILED(hr = MFCreateDXGIDeviceManager(&token, m_manager.put())) ||
      FAILED(hr = m_manager->ResetDevice(device, token))) {
    error = HrMessage(L"Could not share the GPU with the video encoder", hr);
    return false;
  }

  winrt::com_ptr<IMFAttributes> attrs;
  MFCreateAttributes(attrs.put(), 4);
  attrs->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
  attrs->SetUnknown(MF_SINK_WRITER_D3D_MANAGER, m_manager.get());
  // Never block the capture thread waiting on the encoder.
  attrs->SetUINT32(MF_SINK_WRITER_DISABLE_THROTTLING, TRUE);
  attrs->SetGUID(MF_TRANSCODE_CONTAINERTYPE, MFTranscodeContainerType_MPEG4);

  if (FAILED(hr = MFCreateSinkWriterFromURL(path.c_str(), nullptr, attrs.get(), m_writer.put()))) {
    error = HrMessage(L"Could not create the video file", hr);
    return false;
  }

  winrt::com_ptr<IMFMediaType> out;
  MFCreateMediaType(out.put());
  out->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  out->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
  out->SetUINT32(MF_MT_AVG_BITRATE, bitrate);
  out->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  out->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High);
  MFSetAttributeSize(out.get(), MF_MT_FRAME_SIZE, width, height);
  MFSetAttributeRatio(out.get(), MF_MT_FRAME_RATE, fps, 1);
  MFSetAttributeRatio(out.get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  if (FAILED(hr = m_writer->AddStream(out.get(), &m_stream))) {
    error = HrMessage(L"No H.264 encoder accepted this video size", hr);
    m_writer = nullptr;
    return false;
  }

  winrt::com_ptr<IMFMediaType> in;
  MFCreateMediaType(in.put());
  in->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  in->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_ARGB32);
  in->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  MFSetAttributeSize(in.get(), MF_MT_FRAME_SIZE, width, height);
  MFSetAttributeRatio(in.get(), MF_MT_FRAME_RATE, fps, 1);
  MFSetAttributeRatio(in.get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  if (FAILED(hr = m_writer->SetInputMediaType(m_stream, in.get(), nullptr))) {
    error = HrMessage(L"The video encoder rejected GPU frames", hr);
    m_writer = nullptr;
    return false;
  }

  if (FAILED(hr = m_writer->BeginWriting())) {
    error = HrMessage(L"The video encoder failed to start", hr);
    m_writer = nullptr;
    return false;
  }
  return true;
}

bool VideoEncoder::Write(ID3D11Texture2D* texture, int64_t time100ns, int64_t duration100ns) {
  if (!m_writer) return false;
  winrt::com_ptr<IMFMediaBuffer> buffer;
  if (FAILED(MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D), texture, 0, FALSE, buffer.put()))) return false;
  DWORD length = 0;
  if (auto b2 = buffer.try_as<IMF2DBuffer>()) b2->GetContiguousLength(&length);
  buffer->SetCurrentLength(length);

  winrt::com_ptr<IMFSample> sample;
  if (FAILED(MFCreateSample(sample.put()))) return false;
  sample->AddBuffer(buffer.get());
  sample->SetSampleTime(time100ns);
  sample->SetSampleDuration(duration100ns > 0 ? duration100ns : 1);
  return SUCCEEDED(m_writer->WriteSample(m_stream, sample.get()));
}

bool VideoEncoder::Close() {
  if (!m_writer) return false;
  const bool ok = SUCCEEDED(m_writer->Finalize());
  m_writer = nullptr;
  if (m_manager) m_manager = nullptr;
  return ok;
}
