import { SAMPLE_MS } from './track.js'

export const DEFAULT_ZOOM = {
  scale: 2,
  lead: 0.45, // start zooming slightly before the click lands
  hold: 1.9, // clicks closer together than this share one zoom
  ramp: 1.4, // push-in duration (seconds)
  rampOut: 2.4, // pull-back duration (seconds)
}

const MAX_SCALE = 6

// ------------------------------------------------------------ camera follow
// The camera doesn't chase every movement: it only moves once the cursor
// leaves a dead zone around where it's already pointing, with the pull
// feathered in (no on/off edge for tremor to chatter across). It aims at where
// the cursor is about to be (LOOKAHEAD — possible because the whole recording
// is known), which cancels the follower's own lag, and the result is then
// Gaussian-smoothed so the pan has no kinks at all.
const FOLLOW = {
  deadZone: 0.028,
  feather: 0.05,
  k: 0.075, // per 8ms sample: ~110ms time constant
  lookaheadMs: 110,
  sigmaMs: 110,
  centerBias: 0,
}
// Frame mode (project.frameFillOnZoom): the recording fills the whole canvas,
// so the cursor is kept closer to true centre.
const FOLLOW_TIGHT = {
  deadZone: 0.01,
  feather: 0.035,
  k: 0.16,
  lookaheadMs: 60,
  sigmaMs: 70,
  centerBias: 0.2,
}

// --------------------------------------------------------------- hold time
// After a cluster's last click, keep the zoom for as long as the cursor is
// still doing something, and only pull back once it has genuinely settled.
const SETTLE_LEVEL = 0.12
const SETTLE_FOR = 0.4
const MIN_HOLD = 3.2
const MAX_HOLD = 5.5

// Auto segments closer than this are bridged into one continuous zoom, so a
// burst of clicking doesn't pump in and out.
const SEGMENT_GAP_MERGE = 2.2

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

let seq = 0
export const newId = () => `z${Date.now().toString(36)}${(seq++).toString(36)}`

// Quintic smootherstep: zero velocity *and* acceleration at both ends.
const ease = (k) => {
  const x = clamp(k, 0, 1)
  return x * x * x * (x * (x * 6 - 15) + 10)
}

function settleEnd(activity, lastClick, duration) {
  const fallback = Math.min(duration, lastClick + DEFAULT_ZOOM.hold)
  if (!activity || activity.length === 0) return fallback

  const startIdx = Math.max(0, Math.floor((lastClick * 1000) / SAMPLE_MS))
  const minIdx = startIdx + Math.round((MIN_HOLD * 1000) / SAMPLE_MS)
  const maxIdx = Math.min(activity.length - 1, startIdx + Math.round((MAX_HOLD * 1000) / SAMPLE_MS))
  const settleSamples = Math.round((SETTLE_FOR * 1000) / SAMPLE_MS)

  let quietRun = 0
  for (let i = startIdx; i <= maxIdx; i++) {
    if (activity[i] < SETTLE_LEVEL) {
      quietRun++
      if (i >= minIdx && quietRun >= settleSamples) return Math.min(duration, (i * SAMPLE_MS) / 1000)
    } else {
      quietRun = 0
    }
  }
  return Math.min(duration, (maxIdx * SAMPLE_MS) / 1000)
}

/**
 * Groups clicks that happen close together into one sustained zoom, so a
 * double-click or a burst of clicks doesn't cause a pumping effect.
 */
export function autoZooms(path, opts = {}) {
  const { scale, lead, hold, ramp, rampOut } = { ...DEFAULT_ZOOM, ...opts }
  const clusters = []

  for (const click of path.clicks) {
    const last = clusters[clusters.length - 1]
    if (last && click.t - last.lastClick < hold) {
      last.lastClick = click.t
      last.points.push(click)
    } else {
      clusters.push({ firstClick: click.t, lastClick: click.t, points: [click] })
    }
  }

  const segments = clusters.map((c) => ({
    id: newId(),
    start: Math.max(0, c.firstClick - lead),
    end: settleEnd(path.activity, c.lastClick, path.duration),
    scale,
    ramp,
    rampOut,
    follow: true,
    x: c.points.reduce((s, p) => s + p.x, 0) / c.points.length,
    y: c.points.reduce((s, p) => s + p.y, 0) / c.points.length,
    auto: true,
  }))

  return normalizeSegments(segments, path.duration, SEGMENT_GAP_MERGE)
}

// Keeps segments sorted, non-overlapping and long enough to ease. `mergeGap`
// also bridges segments within that many seconds of each other (auto only —
// manual edits are never silently glued together).
export function normalizeSegments(segments, duration, mergeGap = 0) {
  const sorted = [...segments].sort((a, b) => a.start - b.start)
  const out = []
  for (const seg of sorted) {
    const s = { ...seg }
    s.start = Math.max(0, Math.min(s.start, duration))
    s.end = Math.max(s.start + 0.3, Math.min(s.end, duration))
    const prev = out[out.length - 1]
    if (prev && s.start < prev.end + mergeGap) {
      prev.end = Math.max(prev.end, s.end)
      prev.scale = Math.max(prev.scale, s.scale)
      continue
    }
    out.push(s)
  }
  return out
}

const segScale = (seg) => clamp(seg.scale ?? DEFAULT_ZOOM.scale, 1, MAX_SCALE)

// The viewport centre must keep a 1/scale-wide window inside the frame.
// Clamping the *target* (rather than the final crop) means the smoothed path
// never runs into a hard edge stop.
const clampCenter = (v, scale) => clamp(v, 0.5 / scale, 1 - 0.5 / scale)

/**
 * Follow target for one segment, over its own sample range. Pure function of
 * (path, segment, mode) so preview, scrubbing and export always agree.
 */
// Timeline time -> recording time. Outside any clip (a gap) the nearest clip
// edge is used, so the camera holds rather than jumping.
function toSource(t, clips) {
  if (!clips?.length) return t
  let best = null
  let bestD = Infinity
  for (const c of clips) {
    if (t >= c.start && t < c.end) return c.sourceStart + (t - c.start)
    const d = t < c.start ? c.start - t : t - c.end
    if (d < bestD) {
      bestD = d
      best = t < c.start ? c.sourceStart : c.sourceEnd ?? c.sourceStart + (c.end - c.start)
    }
  }
  return best ?? t
}

// Follow data is indexed on the *timeline* sample grid of the segment; the
// cursor it reads is looked up on the recording's own clock.
function buildFollow(path, seg, cfg, clips) {
  const n = path.length
  const from = Math.max(0, Math.floor((seg.start * 1000) / SAMPLE_MS))
  const to = Math.max(from, Math.ceil((seg.end * 1000) / SAMPLE_MS))
  const len = to - from + 1
  const S = segScale(seg)
  const lazy = path.lazy

  const target = (i) => {
    const src = toSource((i * SAMPLE_MS + cfg.lookaheadMs) / 1000, clips)
    const j = clamp(Math.round((src * 1000) / SAMPLE_MS), 0, n - 1)
    let x = lazy[j * 2]
    let y = lazy[j * 2 + 1]
    x += (0.5 - x) * cfg.centerBias
    y += (0.5 - y) * cfg.centerBias
    return [x, y]
  }

  // Start on the segment's anchor (the click) so the push-in heads straight
  // for what was clicked rather than wherever the cursor was mid-travel.
  let cx = seg.x ?? target(from)[0]
  let cy = seg.y ?? target(from)[1]
  const buf = new Float32Array(len * 2)
  for (let i = 0; i < len; i++) {
    const [tx, ty] = target(from + i)
    const dx = tx - cx
    const dy = ty - cy
    const dist = Math.hypot(dx, dy)
    if (dist > cfg.deadZone) {
      const s = ease((dist - cfg.deadZone) / cfg.feather)
      cx += dx * s * cfg.k
      cy += dy * s * cfg.k
    }
    buf[i * 2] = clampCenter(cx, S)
    buf[i * 2 + 1] = clampCenter(cy, S)
  }

  return { from, to, data: gaussianRange(buf, len, cfg.sigmaMs / SAMPLE_MS) }
}

function gaussianRange(src, n, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3))
  const k = new Float32Array(r * 2 + 1)
  for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma))
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

// Memo keyed by (path, segments, mode): cameraAt runs every frame, but the
// follow paths only change when the recording or the segments do.
const cache = {
  loose: { path: null, segments: null, clips: null, map: null },
  tight: { path: null, segments: null, clips: null, map: null },
}
function followFor(path, segments, seg, tight, clips) {
  const slot = tight ? cache.tight : cache.loose
  if (slot.path !== path || slot.segments !== segments || slot.clips !== clips) {
    slot.path = path
    slot.segments = segments
    slot.clips = clips
    slot.map = new Map()
  }
  let f = slot.map.get(seg)
  if (!f) {
    f = buildFollow(path, seg, tight ? FOLLOW_TIGHT : FOLLOW, clips)
    slot.map.set(seg, f)
  }
  return f
}

function sampleFollow(f, t) {
  const idx = (t * 1000) / SAMPLE_MS - f.from
  const last = f.to - f.from
  const i = clamp(Math.floor(idx), 0, last)
  const j = Math.min(last, i + 1)
  const u = clamp(idx - i, 0, 1)
  return {
    x: f.data[i * 2] + (f.data[j * 2] - f.data[i * 2]) * u,
    y: f.data[i * 2 + 1] + (f.data[j * 2 + 1] - f.data[i * 2 + 1]) * u,
  }
}

/**
 * Camera at time t: zoom level and viewport centre (normalized), so it's
 * resolution independent.
 *
 * Zoom is interpolated in log space (scale = S^k), which reads as a constant,
 * even push rather than one that accelerates as it goes in. The centre is tied
 * to the zoom by w = (1 - 1/s) / (1 - 1/S): the point of interest glides from
 * where it sits on screen to the centre in lockstep with the zoom, so pan and
 * zoom are one motion instead of two competing ones, and the viewport can
 * never leave the frame.
 */
export function cameraAt(t, segments, path, tight = false, clips = null) {
  const seg = segments.find((s) => t >= s.start && t <= s.end)
  if (!seg) return { scale: 1, x: 0.5, y: 0.5 }

  const half = (seg.end - seg.start) / 2
  const rampIn = Math.max(1e-3, Math.min(seg.ramp ?? DEFAULT_ZOOM.ramp, half))
  const rampOut = Math.max(1e-3, Math.min(seg.rampOut ?? DEFAULT_ZOOM.rampOut, half))
  let k = 1
  if (t < seg.start + rampIn) k = ease((t - seg.start) / rampIn)
  else if (t > seg.end - rampOut) k = ease((seg.end - t) / rampOut)

  const S = segScale(seg)
  if (S <= 1.0001) return { scale: 1, x: 0.5, y: 0.5 }

  const focus =
    seg.follow && path?.lazy
      ? sampleFollow(followFor(path, segments, seg, tight, clips), t)
      : { x: clampCenter(seg.x ?? 0.5, S), y: clampCenter(seg.y ?? 0.5, S) }

  const scale = Math.pow(S, k)
  const w = (1 - 1 / scale) / (1 - 1 / S)
  return {
    scale,
    x: 0.5 + (focus.x - 0.5) * w,
    y: 0.5 + (focus.y - 0.5) * w,
  }
}
