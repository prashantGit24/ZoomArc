// Global cursor + click capture. Coordinates are in OS screen space; the editor
// maps them into video pixel space using the recorded display bounds.
let uIOhook = null
try {
  ({ uIOhook } = require('uiohook-napi'))
} catch (err) {
  console.warn('[mouse-tracker] uiohook unavailable, falling back to polling:', err.message)
}

const { screen } = require('electron')

const POLL_MS = 8 // ~120Hz, only used when uiohook is missing

// Plausible OS scaling factors; the measured ratio is snapped to the nearest.
const KNOWN_SCALES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3]

class MouseTracker {
  constructor() {
    this.events = []
    this.t0 = 0
    this.running = false
    this.timer = null
    this.onMove = null
    this.onDown = null
    this.onUp = null
    this.probes = []
    this.pointerScale = 1
  }

  /**
   * uiohook reports raw OS coordinates, but which space that is depends on the
   * platform and the display: physical pixels on a scaled Windows display,
   * points on macOS. Rather than hardcode a guess per platform, measure it —
   * compare uiohook's own numbers against Electron's DIP cursor position at the
   * same instant and snap the ratio to the nearest real scaling factor.
   */
  probeScale(event) {
    if (this.probes.length >= 12) return
    const dip = screen.getCursorScreenPoint()
    // Only trust axes far enough from the origin that the ratio is meaningful.
    const ratios = []
    if (Math.abs(dip.x) > 80) ratios.push(event.x / dip.x)
    if (Math.abs(dip.y) > 80) ratios.push(event.y / dip.y)
    for (const r of ratios) {
      if (r > 0.4 && r < 4) this.probes.push(r)
    }
    if (this.probes.length < 5) return

    const sorted = [...this.probes].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    this.pointerScale = KNOWN_SCALES.reduce((best, s) =>
      Math.abs(s - median) < Math.abs(best - median) ? s : best,
    )
  }

  start() {
    this.events = []
    this.probes = []
    this.pointerScale = 1
    this.t0 = Date.now()
    this.running = true

    if (uIOhook) {
      this.onMove = (e) => {
        this.probeScale(e)
        this.push('move', e.x, e.y)
      }
      this.onDown = (e) => this.push('down', e.x, e.y, e.button)
      this.onUp = (e) => this.push('up', e.x, e.y, e.button)
      uIOhook.on('mousemove', this.onMove)
      uIOhook.on('mousedrag', this.onMove)
      uIOhook.on('mousedown', this.onDown)
      uIOhook.on('mouseup', this.onUp)
      try {
        uIOhook.start()
      } catch (err) {
        console.warn('[mouse-tracker] uiohook start failed:', err.message)
        this.startPolling()
      }
    } else {
      this.startPolling()
    }
  }

  // Polling gives us movement but no clicks — zooms then rely on dwell instead.
  startPolling() {
    this.timer = setInterval(() => {
      const p = screen.getCursorScreenPoint()
      this.push('move', p.x, p.y)
    }, POLL_MS)
  }

  push(type, x, y, button) {
    if (!this.running) return
    const t = Date.now() - this.t0
    if (type === 'move') {
      // Drop samples that add nothing: same pixel, or closer than 4ms apart.
      const last = this.events[this.events.length - 1]
      if (last && last.type === 'move' && (t - last.t < 4 || (last.x === x && last.y === y))) return
    }
    this.events.push(button === undefined ? { t, x, y, type } : { t, x, y, type, button })
  }

  stop() {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (uIOhook && this.onMove) {
      uIOhook.off('mousemove', this.onMove)
      uIOhook.off('mousedrag', this.onMove)
      uIOhook.off('mousedown', this.onDown)
      uIOhook.off('mouseup', this.onUp)
      this.onMove = this.onDown = this.onUp = null
      try {
        uIOhook.stop()
      } catch {
        /* already stopped */
      }
    }
    return this.events
  }

  /** Divide raw event coordinates by this to reach Electron's DIP space. */
  getPointerScale() {
    return this.pointerScale
  }
}

module.exports = { MouseTracker }
