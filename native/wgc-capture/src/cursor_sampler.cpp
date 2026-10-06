#include "cursor_sampler.h"

#include <dwmapi.h>

#include "qpc_time.h"

namespace {

constexpr int64_t kInterval100ns = 5'000;  // 0.5ms = 2000Hz
constexpr int kBoundsEveryTicks = 16;      // window bounds at ~125Hz

#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif

bool WindowRect(HWND hwnd, RECT& r) {
  if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &r, sizeof(r)))) return true;
  return GetWindowRect(hwnd, &r) != FALSE;
}

}  // namespace

void CursorSampler::Start(HWND trackWindow) {
  Stop();
  {
    std::lock_guard<std::mutex> lock(m_mutex);
    m_events.clear();
    m_events.reserve(1 << 16);
  }
  m_window = trackWindow;
  m_polls.store(0);
  m_run.store(true);
  m_thread = std::thread(&CursorSampler::Run, this);
}

void CursorSampler::Stop() {
  if (!m_run.exchange(false)) return;
  if (m_thread.joinable()) m_thread.join();
}

std::vector<CursorSampler::Event> CursorSampler::Take() {
  std::lock_guard<std::mutex> lock(m_mutex);
  std::vector<Event> out;
  out.swap(m_events);
  return out;
}

void CursorSampler::Push(const Event& e) {
  std::lock_guard<std::mutex> lock(m_mutex);
  m_events.push_back(e);
}

void CursorSampler::Run() {
  // Physical pixels regardless of the process's DPI awareness, matching what
  // the monitor rects and DWM window bounds are reported in.
  SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);

  HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
  if (!timer) timer = CreateWaitableTimerW(nullptr, FALSE, nullptr);

  POINT last{INT_MIN, INT_MIN};
  bool lastShown = true;
  bool buttons[3] = {false, false, false};
  RECT lastBounds{0, 0, 0, 0};
  int tick = 0;
  bool swap = GetSystemMetrics(SM_SWAPBUTTON) != 0;
  int64_t deadline = QpcNow100ns();

  while (m_run.load()) {
    const int64_t t = QpcNow100ns();

    POINT p;
    if (GetCursorPos(&p) && (p.x != last.x || p.y != last.y)) {
      last = p;
      Push({t, p.x, p.y, 0, 0, Move, 0});
    }

    CURSORINFO ci{};
    ci.cbSize = sizeof(ci);
    if (GetCursorInfo(&ci)) {
      const bool shown = (ci.flags & CURSOR_SHOWING) != 0;
      if (shown != lastShown) {
        lastShown = shown;
        Push({t, last.x, last.y, 0, 0, shown ? Show : Hide, 0});
      }
    }

    // GetAsyncKeyState reports *physical* buttons; map to logical ones.
    if ((tick & 255) == 0) swap = GetSystemMetrics(SM_SWAPBUTTON) != 0;
    const int vks[3] = {swap ? VK_RBUTTON : VK_LBUTTON, swap ? VK_LBUTTON : VK_RBUTTON, VK_MBUTTON};
    for (int b = 0; b < 3; b++) {
      const bool down = (GetAsyncKeyState(vks[b]) & 0x8000) != 0;
      if (down != buttons[b]) {
        buttons[b] = down;
        Push({t, last.x, last.y, 0, 0, down ? Down : Up, static_cast<uint8_t>(b + 1)});
      }
    }

    if (m_window && tick % kBoundsEveryTicks == 0) {
      RECT r;
      if (WindowRect(m_window, r) &&
          (r.left != lastBounds.left || r.top != lastBounds.top || r.right != lastBounds.right ||
           r.bottom != lastBounds.bottom)) {
        lastBounds = r;
        Push({t, r.left, r.top, r.right - r.left, r.bottom - r.top, Bounds, 0});
      }
    }
    tick++;
    m_polls.store(tick, std::memory_order_relaxed);

    // Fixed schedule (start + tick * interval) rather than "wait 1ms after
    // each read": the read itself and timer wake-up latency would otherwise
    // add up every cycle and pull the real rate well under 1000Hz.
    deadline += kInterval100ns;
    int64_t remaining = deadline - QpcNow100ns();
    if (remaining < -5 * kInterval100ns) {
      deadline = QpcNow100ns();  // fell far behind (system stall): resync, don't burst
      remaining = 0;
    }
    if (remaining > 0) {
      if (timer) {
        LARGE_INTEGER due;
        due.QuadPart = -remaining;
        SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE);
        WaitForSingleObject(timer, 50);
      } else {
        Sleep(1);
      }
    }
  }

  if (timer) CloseHandle(timer);
}
