#pragma once

#include <windows.h>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <thread>
#include <vector>

// Samples the real system cursor on its own high-resolution-timer thread,
// independent of the JS thread (which can stall), stamped with QPC time so it
// lines up exactly with captured video frames.
class CursorSampler {
 public:
  enum Type : uint8_t { Move = 0, Down = 1, Up = 2, Hide = 3, Show = 4, Bounds = 5 };
  struct Event {
    int64_t t100ns;
    int32_t x, y;
    int32_t w, h;  // Bounds only
    uint8_t type;
    uint8_t button;  // 1 left, 2 right, 3 middle (logical, honours swapped buttons)
  };

  ~CursorSampler() { Stop(); }

  // hwnd != 0: also tracks that window's on-screen bounds (DWM extended frame
  // bounds), so a window recording stays correct while the window is moved.
  void Start(HWND trackWindow);
  void Stop();
  std::vector<Event> Take();
  // How many times the cursor was read since Start() (the real sample rate).
  uint64_t Polls() const { return m_polls.load(); }

 private:
  void Run();
  void Push(const Event& e);

  std::thread m_thread;
  std::atomic<bool> m_run{false};
  std::atomic<uint64_t> m_polls{0};
  HWND m_window = nullptr;
  std::mutex m_mutex;
  std::vector<Event> m_events;
};
