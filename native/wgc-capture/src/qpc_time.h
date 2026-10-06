#pragma once

#include <windows.h>
#include <cstdint>

// QueryPerformanceCounter in 100ns units — the same timebase as WGC's
// Direct3D11CaptureFrame.SystemRelativeTime(), so cursor samples and video
// frames share one clock.
inline int64_t QpcNow100ns() {
  static const int64_t freq = [] {
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    return f.QuadPart;
  }();
  LARGE_INTEGER now;
  QueryPerformanceCounter(&now);
  return (now.QuadPart / freq) * 10'000'000 + (now.QuadPart % freq) * 10'000'000 / freq;
}

// Unix epoch milliseconds (same clock as JS Date.now()), sub-ms precise.
inline double WallNowMs() {
  FILETIME ft;
  GetSystemTimePreciseAsFileTime(&ft);
  ULARGE_INTEGER u;
  u.LowPart = ft.dwLowDateTime;
  u.HighPart = ft.dwHighDateTime;
  return static_cast<double>(u.QuadPart - 116444736000000000ULL) / 10'000.0;
}
