/**
 * Turns raw OS-space mouse events into a resampled, smoothed path in
 * normalized video space (0..1), plus a list of click times.
 */

export const SAMPLE_MS = 8 // resample grid, ~120Hz

function toNormalized(event, track) {
  // Windows at 125%/150% (and Retina) hand us raw pixels while Electron's
  // display bounds are in DIPs; pointerScale is the measured ratio between them.
  const k = track.pointerScale || 1
  const ex = event.x / k
  const ey = event.y / k

  const b = track.source?.display?.bounds
  if (b && b.width && b.height) {
    return { x: (ex - b.x) / b.width, y: (ey - b.y) / b.height }
  }
  // Window capture (or unknown display): assume the event space matches the
  // recorded frame's aspect and fall back to raw pixels over video size.
  const { width, height } = track.videoSize || { width: 1920, height: 1080 }
  return { x: ex / width, y: ey / height }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

export function buildMousePath(track) {
  const moves = (track.events || []).filter((e) => e.type === 'move')
  const clicks = (track.events || [])
    .filter((e) => e.type === 'down')
    .map((e) => ({ t: e.t / 1000, ...toNormalized(e, track) }))

  const duration = (track.durationMs || 0) / 1000
  const n = Math.max(1, Math.ceil((duration * 1000) / SAMPLE_MS) + 1)
  const raw = new Float32Array(n * 2)

  if (moves.length === 0) {
    for (let i = 0; i < n; i++) {
      raw[i * 2] = 0.5
      raw[i * 2 + 1] = 0.5
    }
  } else {
    // Step through the resample grid, advancing a cursor into the event list
    // and lerping between the two events that straddle each sample.
    let j = 0
    for (let i = 0; i < n; i++) {
      const t = (i * SAMPLE_MS) / 1000
      while (j < moves.length - 1 && moves[j + 1].t / 1000 <= t) j++
      const a = moves[j]
      const b = moves[Math.min(j + 1, moves.length - 1)]
      const ta = a.t / 1000
      const tb = b.t / 1000
      const f = tb > ta ? clamp01((t - ta) / (tb - ta)) : 0
      const pa = toNormalized(a, track)
      const pb = toNormalized(b, track)
      raw[i * 2] = clamp01(pa.x + (pb.x - pa.x) * f)
      raw[i * 2 + 1] = clamp01(pa.y + (pb.y - pa.y) * f)
    }
  }

  return {
    duration,
    clicks,
    raw,
    // Three smoothing strengths, each tuned for what reads it:
    //   cursor - speed-adaptive, for the drawn pointer
    //   tight  - click ripples, which should land where you actually clicked
    //   lazy   - camera follow, which glides rather than chasing every twitch
    cursor: smoothCursor(raw, n, 1),
    tight: smooth(raw, n, 0.25),
    // Feeds the camera-follow spring in zoom.js — it's the "glide" target, so
    // it needs to be a genuinely quiet signal. Left too twitchy (a prior
    // tightening pushed this to 0.09 chasing a "camera loses the cursor"
    // complaint), every residual hand-tremor wiggle survives into the target
    // and the follow spring dutifully chases it, reading as zigzag at 2x zoom.
    lazy: smooth(raw, n, 0.055),
    // How much the cursor is moving right now, heavily low-passed so it
    // reflects sustained motion rather than a single fast sample — the
    // auto-zoom engine (zoom.js) reads this to decide how long to keep
    // holding/following after a click, and how deep a zoom is comfortable
    // (a fast, erratic hand at 2x magnification is nauseating to watch;
    // a calm, deliberate one isn't). Roughly 0 at rest, ~1 at a brisk flick.
    activity: movementLevel(raw, n, ACTIVITY_ALPHA, ACTIVITY_REF),
    length: n,
  }
}

const ACTIVITY_ALPHA = 0.05 // low-pass strength — ~150ms time constant, well past single-sample tremor
const ACTIVITY_REF = 0.01 // normalized units/sample that reads as "1.0 = brisk, sustained motion"

// Low-passed (forward *and* backward, so it isn't lagged toward either end of
// a move) per-sample movement magnitude, normalized against `ref` and capped
// at 1. Shared shape with smoothCursor's internal speed estimate, but tuned
// with a much longer time constant — that one exists to separate tremor from
// a deliberate move within a handful of milliseconds; this one exists to
// characterize the last several hundred milliseconds of behavior.
function movementLevel(raw, n, alpha, ref) {
  const level = new Float32Array(n)
  for (let i = 1; i < n; i++) {
    level[i] = Math.hypot(raw[i * 2] - raw[(i - 1) * 2], raw[i * 2 + 1] - raw[(i - 1) * 2 + 1])
  }
  let v = 0
  for (let i = 0; i < n; i++) {
    v += (level[i] - v) * alpha
    level[i] = v
  }
  v = level[n - 1]
  for (let i = n - 1; i >= 0; i--) {
    v += (level[i] - v) * alpha
    level[i] = Math.min(1, v / ref)
  }
  return level
}

// Exponential smoothing run forwards then backwards, which removes the lag a
// single forward pass would introduce.
function smooth(raw, n, alpha) {
  const out = new Float32Array(n * 2)
  let x = raw[0]
  let y = raw[1]
  for (let i = 0; i < n; i++) {
    x += (raw[i * 2] - x) * alpha
    y += (raw[i * 2 + 1] - y) * alpha
    out[i * 2] = x
    out[i * 2 + 1] = y
  }
  x = out[(n - 1) * 2]
  y = out[(n - 1) * 2 + 1]
  for (let i = n - 1; i >= 0; i--) {
    x += (out[i * 2] - x) * alpha
    y += (out[i * 2 + 1] - y) * alpha
    out[i * 2] = x
    out[i * 2 + 1] = y
  }
  return out
}

/**
 * Speed-adaptive smoothing for the drawn cursor.
 *
 * A single fixed strength can't win: enough smoothing to settle the tremor of a
 * near-stationary hand also turns a fast deliberate flick into a laggy slide.
 * So the strength follows the speed — mild while slow (just enough to settle
 * hand tremor), and *off* (alpha 1, exact passthrough) once the cursor is
 * actually moving, so the drawn dot is pixel-for-pixel the recorded position —
 * no lag, no smoothing artifact — for as long as the move lasts. Only the
 * short ramp in and out of "moving" still gets any filtering at all.
 *
 * `amount` scales the whole effect; 0 passes the raw path through untouched.
 */
export function smoothCursor(raw, n, amount = 1) {
  const out = new Float32Array(n * 2)
  if (n === 0) return out
  if (amount <= 0) {
    out.set(raw)
    return out
  }

  const SLOW = 0.16 // strength when essentially still
  const FAST = 1 // strength at or above REF speed — alpha 1 is raw passthrough: zero lag while moving
  const REF = 0.0012 // normalized units per sample counted as deliberate movement
  const SPEED_ALPHA = 0.35 // low-pass on the speed estimate itself — reacts within ~1-2 samples
  // (well under one video frame) so the dot doesn't trail the first frames of a flick before
  // the speed estimate catches up and alpha ramps to FAST. The estimate is itself smoothed
  // forward *and* backward below, so this isn't even causal — it can "see" the move coming.

  // Instantaneous speed can't classify movement on its own: tremor is fast
  // sample-to-sample while going nowhere, so it would read as deliberate and
  // escape smoothing entirely. Low-passing the speed first separates real
  // travel (sustained) from tremor (fast but cancelling out).
  const speed = new Float32Array(n)
  for (let i = 1; i < n; i++) {
    speed[i] = Math.hypot(raw[i * 2] - raw[(i - 1) * 2], raw[i * 2 + 1] - raw[(i - 1) * 2 + 1])
  }
  let v = 0
  for (let i = 0; i < n; i++) {
    v += (speed[i] - v) * SPEED_ALPHA
    speed[i] = v
  }
  v = speed[n - 1]
  for (let i = n - 1; i >= 0; i--) {
    v += (speed[i] - v) * SPEED_ALPHA
    speed[i] = v
  }

  const alphaAt = (i) => {
    const a = SLOW + (FAST - SLOW) * Math.min(1, speed[i] / REF)
    // Blend back toward "no smoothing" (alpha 1) as amount drops.
    return a + (1 - a) * (1 - amount)
  }

  let x = raw[0]
  let y = raw[1]
  for (let i = 0; i < n; i++) {
    const a = alphaAt(i)
    x += (raw[i * 2] - x) * a
    y += (raw[i * 2 + 1] - y) * a
    out[i * 2] = x
    out[i * 2 + 1] = y
  }
  // Backward pass cancels the lag the forward pass introduced.
  x = out[(n - 1) * 2]
  y = out[(n - 1) * 2 + 1]
  for (let i = n - 1; i >= 0; i--) {
    const a = alphaAt(i)
    x += (out[i * 2] - x) * a
    y += (out[i * 2 + 1] - y) * a
    out[i * 2] = x
    out[i * 2 + 1] = y
  }
  return out
}

export function sampleAt(buffer, length, t) {
  const idx = (t * 1000) / SAMPLE_MS
  const i = Math.max(0, Math.min(length - 1, Math.floor(idx)))
  const j = Math.min(length - 1, i + 1)
  const f = idx - i
  return {
    x: buffer[i * 2] + (buffer[j * 2] - buffer[i * 2]) * f,
    y: buffer[i * 2 + 1] + (buffer[j * 2 + 1] - buffer[i * 2 + 1]) * f,
  }
}
