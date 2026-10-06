/**
 * Cursor motion engine: turns raw OS-space mouse events into a uniformly
 * resampled, smoothed path in normalized video space (0..1), plus clicks.
 *
 * Everything here is zero-phase (centered Gaussian kernels over the whole,
 * already-known recording), so smoothing never adds lag, never overshoots,
 * and preview, scrubbing and export all read the exact same trajectory.
 */

export const SAMPLE_MS = 8 // resample grid, ~120Hz

// Cursor smoothing adapts to speed: heavy while nearly still (hand tremor),
// light while travelling (stays accurate, but still rounds off the corners
// that irregular OS event timing leaves in a fast move).
const CURSOR_SIGMA_SLOW_MS = 45
const CURSOR_SIGMA_FAST_MS = 11
// Around a click the cursor must sit exactly on what was clicked.
const CURSOR_SIGMA_CLICK_MS = 4
const CLICK_SNAP_MS = 140 // how far either side of a click the snap blends out over
const SPEED_SIGMA_MS = 40 // speed estimate is itself smoothed so tremor doesn't read as travel
const SPEED_REF = 0.15 // normalized units/second that counts as fully "travelling"

// Camera-follow target: a calm, heavily smoothed version of the path.
const LAZY_SIGMA_MS = 140

// Activity level feeding auto-zoom decisions (zoom.js): ~0 at rest, ~1 at a brisk move.
const ACTIVITY_SIGMA_MS = 110
const ACTIVITY_REF = 1.25 // normalized units/second

// One recorded position -> normalized video space (0..1), unclamped.
// Native takes (track.capture) are physical pixels on the video's own pixel
// grid, relative to the captured area's origin at that moment — `origin`
// moves with a recorded window (see 'bounds' events).
function toNormalized(event, track, origin) {
  const cap = track.capture
  if (cap?.width && cap?.height) {
    const o = origin || cap.origin || { x: 0, y: 0 }
    return { x: (event.x - o.x) / cap.width, y: (event.y - o.y) / cap.height }
  }

  // Browser-path takes. Window capture: events and the window's bounds
  // (fetched once at record start) are both raw physical desktop pixels.
  const wb = track.source?.windowBounds
  if (wb && wb.width && wb.height) {
    return { x: (event.x - wb.x) / wb.width, y: (event.y - wb.y) / wb.height }
  }

  // Windows at 125%/150% (and Retina) hand us raw pixels while Electron's
  // display bounds are in DIPs; pointerScale is the measured ratio between them.
  const k = track.pointerScale || 1
  const ex = event.x / k
  const ey = event.y / k

  const b = track.source?.display?.bounds
  if (b && b.width && b.height) {
    return { x: (ex - b.x) / b.width, y: (ey - b.y) / b.height }
  }
  const { width, height } = track.videoSize || { width: 1920, height: 1080 }
  return { x: ex / width, y: ey / height }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

// Last index in sorted `times` with value <= t, or -1.
function floorIndex(times, length, t) {
  if (length === 0 || times[0] > t) return -1
  let lo = 0
  let hi = length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (times[mid] <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function buildMousePath(track) {
  const events = [...(track.events || [])].sort((a, b) => a.t - b.t)
  const native = track.clock === 'native'

  // Window recordings: where the window was at each moment.
  const bounds = events.filter((e) => e.type === 'bounds')
  const boundsT = bounds.map((e) => e.t)
  const originAt = (t) => {
    const b = bounds[Math.max(0, floorIndex(boundsT, bounds.length, t))]
    return b ? { x: b.x, y: b.y } : null
  }
  const norm = (e) => toNormalized(e, track, originAt(e.t))

  const clicks = events.filter((e) => e.type === 'down').map((e) => ({ t: e.t / 1000, ...norm(e) }))
  const exact = exactTrack(events, norm, native)

  const duration = (track.durationMs || 0) / 1000
  const n = Math.max(1, Math.ceil((duration * 1000) / SAMPLE_MS) + 1)
  const { raw, inside } = resample(exact, n)
  markHidden(events, inside, n)

  const speed = speedTrack(raw, n)
  const clickNear = clickProximity(events, n)

  return {
    duration,
    clicks,
    // The real cursor's own samples — what the drawn cursor replays 1:1.
    exact,
    raw,
    // Optional smoothed glide (the Cursor panel's Smoothing slider blends to it).
    cursor: adaptiveGaussian(raw, n, (i) => {
      const travel = smoothstep(speed[i] / SPEED_REF)
      const sigma = CURSOR_SIGMA_SLOW_MS + (CURSOR_SIGMA_FAST_MS - CURSOR_SIGMA_SLOW_MS) * travel
      return (sigma + (CURSOR_SIGMA_CLICK_MS - sigma) * clickNear[i]) / SAMPLE_MS
    }),
    // Camera-follow target (zoom.js): a quiet signal, so tremor never moves the frame.
    lazy: gaussian2(raw, n, LAZY_SIGMA_MS / SAMPLE_MS),
    activity: activityTrack(raw, n),
    // 1 while the pointer is over the recorded area and shown by the system,
    // 0 while it's off on another monitor or hidden (e.g. while typing).
    visible: gaussian1(inside, n, VISIBLE_SIGMA_MS / SAMPLE_MS),
    length: n,
  }
}

const VISIBLE_SIGMA_MS = 20
const OFFSCREEN_MARGIN = 0.004

/**
 * Every recorded cursor position, in order, normalized but unclamped.
 *
 * Samples only exist when the cursor moved, so a long gap means it sat still.
 * Interpolating straight across that gap would invent a slow drift toward
 * wherever the next movement started; instead the resting position is held
 * until one sample-interval before motion resumed.
 */
function exactTrack(events, norm, native) {
  const holdGap = native ? 3 : 30 // ms: longer than the sampler's own spacing
  const lead = native ? 0.5 : 8
  const t = []
  const x = []
  const y = []
  let last = null
  for (const e of events) {
    let p
    if (e.type === 'move' || e.type === 'down' || e.type === 'up') {
      last = e
      p = norm(e)
    } else if (e.type === 'bounds' && last) {
      // The window moved under a still pointer: same screen spot, new place
      // relative to the recording.
      p = norm({ ...last, t: e.t })
    } else continue

    const n = t.length
    if (n && e.t - t[n - 1] > holdGap) {
      t.push(e.t - lead)
      x.push(x[n - 1])
      y.push(y[n - 1])
    }
    t.push(e.t)
    x.push(p.x)
    y.push(p.y)
  }
  return { t: Float64Array.from(t), x: Float32Array.from(x), y: Float32Array.from(y), length: t.length }
}

/** Exact cursor position at time `t` (seconds), normalized and clamped. */
export function exactCursorAt(path, t) {
  const ex = path.exact
  if (!ex || ex.length === 0) return { x: 0.5, y: 0.5 }
  const ms = t * 1000
  const i = floorIndex(ex.t, ex.length, ms)
  if (i < 0) return { x: clamp01(ex.x[0]), y: clamp01(ex.y[0]) }
  if (i >= ex.length - 1) return { x: clamp01(ex.x[ex.length - 1]), y: clamp01(ex.y[ex.length - 1]) }
  const span = ex.t[i + 1] - ex.t[i]
  const f = span > 0 ? (ms - ex.t[i]) / span : 0
  return {
    x: clamp01(ex.x[i] + (ex.x[i + 1] - ex.x[i]) * f),
    y: clamp01(ex.y[i] + (ex.y[i + 1] - ex.y[i]) * f),
  }
}

// The exact track sampled onto the uniform grid that the camera, activity and
// smoothing passes work on.
function resample(exact, n) {
  const raw = new Float32Array(n * 2)
  const inside = new Float32Array(n).fill(1)
  if (exact.length === 0) {
    raw.fill(0.5)
    return { raw, inside }
  }
  let j = 0
  for (let i = 0; i < n; i++) {
    const t = i * SAMPLE_MS
    while (j < exact.length - 1 && exact.t[j + 1] <= t) j++
    const k = Math.min(j + 1, exact.length - 1)
    const span = exact.t[k] - exact.t[j]
    const f = span > 0 ? clamp01((t - exact.t[j]) / span) : 0
    const x = exact.x[j] + (exact.x[k] - exact.x[j]) * f
    const y = exact.y[j] + (exact.y[k] - exact.y[j]) * f
    const m = OFFSCREEN_MARGIN
    if (x < -m || x > 1 + m || y < -m || y > 1 + m) inside[i] = 0
    raw[i * 2] = clamp01(x)
    raw[i * 2 + 1] = clamp01(y)
  }
  return { raw, inside }
}

// The system hid its cursor (typing in many apps, fullscreen video): so do we.
function markHidden(events, inside, n) {
  let hiddenFrom = null
  const mark = (from, to) => {
    const a = Math.max(0, Math.floor(from / SAMPLE_MS))
    const b = Math.min(n - 1, Math.ceil(to / SAMPLE_MS))
    for (let i = a; i <= b; i++) inside[i] = 0
  }
  for (const e of events) {
    if (e.type === 'hide' && hiddenFrom == null) hiddenFrom = e.t
    else if (e.type === 'show' && hiddenFrom != null) {
      mark(hiddenFrom, e.t)
      hiddenFrom = null
    }
  }
  if (hiddenFrom != null) mark(hiddenFrom, n * SAMPLE_MS)
}

// Per-sample speed in normalized units/second, Gaussian-smoothed.
function speedTrack(raw, n) {
  const s = new Float32Array(n)
  for (let i = 1; i < n; i++) {
    s[i] = Math.hypot(raw[i * 2] - raw[(i - 1) * 2], raw[i * 2 + 1] - raw[(i - 1) * 2 + 1]) * (1000 / SAMPLE_MS)
  }
  s[0] = n > 1 ? s[1] : 0
  return gaussian1(s, n, SPEED_SIGMA_MS / SAMPLE_MS)
}

function activityTrack(raw, n) {
  const s = new Float32Array(n)
  for (let i = 1; i < n; i++) {
    s[i] = Math.hypot(raw[i * 2] - raw[(i - 1) * 2], raw[i * 2 + 1] - raw[(i - 1) * 2 + 1]) * (1000 / SAMPLE_MS)
  }
  const out = gaussian1(s, n, ACTIVITY_SIGMA_MS / SAMPLE_MS)
  for (let i = 0; i < n; i++) out[i] = Math.min(1, out[i] / ACTIVITY_REF)
  return out
}

// 1 at a click (down or up), easing to 0 CLICK_SNAP_MS away.
function clickProximity(events, n) {
  const out = new Float32Array(n)
  const reach = Math.ceil(CLICK_SNAP_MS / SAMPLE_MS)
  for (const e of events) {
    if (e.type !== 'down' && e.type !== 'up') continue
    const c = e.t / SAMPLE_MS
    const from = Math.max(0, Math.floor(c - reach))
    const to = Math.min(n - 1, Math.ceil(c + reach))
    for (let i = from; i <= to; i++) {
      const v = 1 - smoothstep(Math.abs(i - c) / reach)
      if (v > out[i]) out[i] = v
    }
  }
  return out
}

function kernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3))
  const k = new Float32Array(r * 2 + 1)
  const d = 2 * sigma * sigma
  for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-(i * i) / d)
  return { k, r }
}

// Fixed-sigma Gaussian, edges handled by renormalizing (no pull toward 0).
function gaussian1(src, n, sigma) {
  if (sigma < 0.5) return Float32Array.from(src)
  const { k, r } = kernel(sigma)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    let w = 0
    const a = Math.max(0, i - r)
    const b = Math.min(n - 1, i + r)
    for (let j = a; j <= b; j++) {
      const kw = k[j - i + r]
      sum += src[j] * kw
      w += kw
    }
    out[i] = sum / w
  }
  return out
}

function gaussian2(src, n, sigma) {
  if (sigma < 0.5) return Float32Array.from(src)
  const { k, r } = kernel(sigma)
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    let sx = 0
    let sy = 0
    let w = 0
    const a = Math.max(0, i - r)
    const b = Math.min(n - 1, i + r)
    for (let j = a; j <= b; j++) {
      const kw = k[j - i + r]
      sx += src[j * 2] * kw
      sy += src[j * 2 + 1] * kw
      w += kw
    }
    out[i * 2] = sx / w
    out[i * 2 + 1] = sy / w
  }
  return out
}

// Gaussian whose width varies per output sample (sigmaAt returns samples).
function adaptiveGaussian(src, n, sigmaAt) {
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const sigma = sigmaAt(i)
    if (sigma < 0.35) {
      out[i * 2] = src[i * 2]
      out[i * 2 + 1] = src[i * 2 + 1]
      continue
    }
    const r = Math.ceil(sigma * 3)
    const d = 2 * sigma * sigma
    let sx = 0
    let sy = 0
    let w = 0
    const a = Math.max(0, i - r)
    const b = Math.min(n - 1, i + r)
    for (let j = a; j <= b; j++) {
      const o = j - i
      const kw = Math.exp(-(o * o) / d)
      sx += src[j * 2] * kw
      sy += src[j * 2 + 1] * kw
      w += kw
    }
    out[i * 2] = sx / w
    out[i * 2 + 1] = sy / w
  }
  return out
}

export function sampleScalar(buffer, length, t) {
  const idx = (t * 1000) / SAMPLE_MS
  const i = Math.max(0, Math.min(length - 1, Math.floor(idx)))
  const j = Math.min(length - 1, i + 1)
  const f = Math.max(0, Math.min(1, idx - i))
  return buffer[i] + (buffer[j] - buffer[i]) * f
}

export function sampleAt(buffer, length, t) {
  const idx = (t * 1000) / SAMPLE_MS
  const i = Math.max(0, Math.min(length - 1, Math.floor(idx)))
  const j = Math.min(length - 1, i + 1)
  const f = Math.max(0, Math.min(1, idx - i))
  return {
    x: buffer[i * 2] + (buffer[j * 2] - buffer[i * 2]) * f,
    y: buffer[i * 2 + 1] + (buffer[j * 2 + 1] - buffer[i * 2 + 1]) * f,
  }
}
