import { sampleAt, SAMPLE_MS } from './track.js'

export const DEFAULT_ZOOM = {
  scale: 2, // the ceiling — only actually reached after the cursor stays settled for a while
  lead: 0.45, // start zooming slightly before the click lands
  hold: 1.9, // minimum time to stay in after the last click, and the cap on cluster-merging gap
  ramp: 1.4, // ease-in duration — matches the ~1.5s push-in timed off a reference capture
  // (adiuHrc53Fu2hqt5.mp4: rest at t=0.5s, fully pushed in by t≈2.0s).
  rampOut: 2.4, // ease-out duration — was 3.2s; retimed to the ~2.3s pull-back-out measured on
  // the same reference (tight at t=4.0s, fully rested again by t≈6.3s) — still a deliberate,
  // considered exit, just not as long a hang time as the previous tuning pass landed on.
}

// How far the cursor may drift before the camera bothers to follow, in
// normalized source units. Without it, every hand tremor moves the whole
// frame — and at 2x magnification that reads as jitter. Kept small: too wide
// and the camera visibly loses the cursor before it starts chasing it.
const DEAD_ZONE = 0.028
// The follow strength ramps from 0 to full across this much *extra* distance
// past DEAD_ZONE, instead of snapping straight to "on" the instant the cursor
// crosses it. A hard on/off edge is what actually caused the zigzag: with
// residual hand tremor, the distance-to-target hovers right around DEAD_ZONE
// and keeps re-crossing it, and each crossing fired a fresh burst of motion —
// a soft ramp has no edge left to chatter across.
const FEATHER = 0.05
// Spring constant per 8ms sample: ~0.075 gives a ~100ms time constant — a
// cinematic glide rather than a snap, while still not falling behind a
// deliberate move.
const FOLLOW_K = 0.075

// "Frame" mode (project.frameFillOnZoom) asked for the cursor to actually
// stay centred on screen, not just glide toward roughly where it is — with
// the recording bled to fill the whole canvas, any lag between the cursor
// and true centre is far more visible than it is inside the small padded
// frame the default glide was tuned for. A noticeably smaller dead zone and
// stronger spring, used only for Frame-mode segments (see the `tight` param
// threaded through buildCameraPath/cameraAt below) — still smoothed, just
// not as forgiving of drift, since "cover the whole canvas" is already a
// much bigger, more attention-grabbing move than the default's gentle push in.
const DEAD_ZONE_TIGHT = 0.01
const FOLLOW_K_TIGHT = 0.16
// How much Frame mode pulls the follow *target itself* back toward true
// centre before the spring above even chases it — 0 would be pure
// cursor-follow (today's default-mode behaviour), 1 would ignore the cursor
// outright and always sit dead-centre. Was bumped 0.5 -> 0.75 chasing
// feedback that the halfway blend still tracked the cursor too much, but
// 0.75 crushed the follow target into a band only ±12.5% of the frame wide
// around centre regardless of where the cursor actually was — reported back
// as the camera not following the cursor's path at all, staying centred
// whether the cursor was at the left edge or the right. 0.2 keeps most of
// the actual cursor position (the camera clearly tracks toward an edge when
// the cursor is there) while still pulling a fifth of the way toward centre,
// so Frame mode doesn't shove content all the way to the frame's edge either.
const CENTER_BIAS_TIGHT = 0.2

// --------------------------------------------------------------- hold time
// After the last click in a cluster, don't just count down a fixed timer —
// keep following for as long as the cursor is actually doing something, and
// only start the walk back out once it genuinely settles. A user still
// dragging a selection or hunting through a menu two seconds after the click
// hasn't finished with that click yet.
const SETTLE_LEVEL = 0.12 // activity below this counts as "stopped"
const SETTLE_FOR = 0.4 // must read as stopped continuously this long to trust it (seconds)
// Long enough that a click followed by instant stillness still gets the full
// scale creep below (SCALE_CREEP_AFTER + SCALE_CREEP_TIME, from roughly when
// activity actually decays past the click) to reach the deeper zoom levels
// before the hold is even eligible to end — otherwise the zoom snaps back out
// the instant it arrived, which is the exact complaint this replaced.
const MIN_HOLD = 3.2 // never leave before this even if the cursor is instantly still
const MAX_HOLD = 5.5 // never hold forever if it just never fully settles

// ------------------------------------------------------------------ scale
// The zoom level is no longer one fixed number — how comfortable a given
// magnification is depends on how the cursor is behaving. Pushing in to 2x
// while the hand is still moving fast turns ordinary mouse motion into a
// nauseating high-speed pan; the same 2x is perfectly calm once the cursor
// has actually stopped. So scale is itself a signal sampled over time, not a
// constant: it opens to a modest level immediately, then — only if the
// cursor stays calm — creeps the rest of the way to the segment's ceiling.
const SCALE_FAST = 1.3 // ceiling while the cursor is moving briskly
const SCALE_STEADY = 1.5 // reached quickly once movement is calm/natural
const SCALE_ACTIVITY_LO = 0.15 // at/below this activity, treat motion as "calm"
const SCALE_ACTIVITY_HI = 0.6 // at/above this, treat it as "fast"
const SCALE_CREEP_AFTER = 0.7 // seconds of continuous calm before creeping toward the ceiling
const SCALE_CREEP_TIME = 1.3 // how long that creep takes once it starts
// A single sample ticking back over SCALE_ACTIVITY_LO used to zero the calm
// timer outright — but real "calm" cursor activity hovers right around that
// line (hand tremor, a slow deliberate move), so the timer kept getting wiped
// mid-climb and the target scale sawtoothed: creep in, get cut off, drop back,
// try again — reading as the zoom fighting itself between in and out. Draining
// it instead of zeroing it means one stray blip barely dents the climb, while
// a real resumption of movement still drains it out within a fraction of a
// second (it drains STEADY_DECAY times faster than it accumulates).
const STEADY_DECAY = 4

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

let seq = 0
export const newId = () => `z${Date.now().toString(36)}${(seq++).toString(36)}`

/**
 * Quintic smootherstep. Like the cubic it replaces it is flat at both ends, but
 * it spreads the movement far more evenly: peak velocity is 1.87 vs the cubic's
 * 2.99, so the push-in never has a fast middle to snap through. Paired with the
 * longer default ramp, the peak rate of change drops ~2.6x.
 */
const easeInOut = (k) => k * k * k * (k * (k * 6 - 15) + 10)

// Smoothstep: zero value *and* zero slope at t=0, so a ramp built from it
// starts clean with no kink for noise to catch on.
const smoothstep = (t) => t * t * (3 - 2 * t)

/**
 * Where a click cluster's hold actually ends: the first moment, after its
 * last click, that cursor activity has read as settled for SETTLE_FOR
 * straight — clamped to [MIN_HOLD, MAX_HOLD] after that last click so a
 * click followed by instant stillness still gets a beat to register, and a
 * cursor that never truly stops doesn't hold the zoom forever.
 */
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
      if (i >= minIdx && quietRun >= settleSamples) {
        return Math.min(duration, (i * SAMPLE_MS) / 1000)
      }
    } else {
      quietRun = 0
    }
  }
  // Never settled inside the window — bail out at the hard cap rather than
  // holding indefinitely.
  return Math.min(duration, (maxIdx * SAMPLE_MS) / 1000)
}

// Two click-clusters whose zoom segments land this close together get
// bridged into one continuous hold instead of each running its own full
// zoom-out-then-back-in. That back-to-back in/out cycling — a burst of
// ordinary clicking (working through a menu, a form, a toolbar) each
// triggering a *separate* complete zoom — is what actually reads as
// "constantly zooming", far more than any single hold does. A gap wider
// than this still means the cursor genuinely paused, so the camera still
// eases all the way back out, as before. Sized to comfortably clear a full
// ramp + rampOut at the slower speed above, so a bridge never gets cut off
// mid-transition by a segment that was about to start anyway.
const SEGMENT_GAP_MERGE = 2.2

/**
 * Groups clicks that happen close together into one sustained zoom, so a
 * double-click or a burst of typing clicks doesn't cause a pumping effect.
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
    follow: true, // camera tracks the cursor while held in
    // Anchor on the cluster's mean click position, used before follow kicks in.
    x: c.points.reduce((s, p) => s + p.x, 0) / c.points.length,
    y: c.points.reduce((s, p) => s + p.y, 0) / c.points.length,
    auto: true,
  }))

  return normalizeSegments(segments, path.duration, SEGMENT_GAP_MERGE)
}

// Keeps segments sorted, non-overlapping and long enough to actually ease.
// `mergeGap` additionally bridges segments that don't overlap but sit within
// that many seconds of each other — defaulted to 0 (merge on overlap only)
// so manual edits in the editor never get silently glued together; autoZooms
// opts into the wider bridge above since that's specifically about auto-
// generated segments from the same burst of activity.
export function normalizeSegments(segments, duration, mergeGap = 0) {
  const sorted = [...segments].sort((a, b) => a.start - b.start)
  const out = []
  for (const seg of sorted) {
    const s = { ...seg }
    s.start = Math.max(0, Math.min(s.start, duration))
    s.end = Math.max(s.start + 0.3, Math.min(s.end, duration))
    const prev = out[out.length - 1]
    if (prev && s.start < prev.end + mergeGap) {
      // Merge rather than drop, so hand-dragged segments can't cancel each other.
      prev.end = Math.max(prev.end, s.end)
      prev.scale = Math.max(prev.scale, s.scale)
      continue
    }
    out.push(s)
  }
  return out
}

/**
 * Precomputes where the camera is pointing for every sample on the path grid.
 *
 * Following the cursor directly is what makes a zoom feel jittery: magnified 2x,
 * a few pixels of hand tremor swings the whole frame. So the camera only starts
 * moving once the cursor has left a dead zone around where it is already
 * pointing, and then chases it with a critically damped spring rather than
 * snapping. A final symmetric smoothing pass removes the spring's lag.
 *
 * Deliberately a pure function of (path, segments, tight): the preview, a
 * scrub to an arbitrary time, and the export all have to agree on the same
 * trajectory, so it cannot be built from per-frame state.
 *
 * `tight` (Frame mode — project.frameFillOnZoom) swaps in a smaller dead
 * zone and a stronger spring, so the cursor tracks closer to true screen
 * centre — see DEAD_ZONE_TIGHT/FOLLOW_K_TIGHT above for why that trade
 * (less forgiving of hand tremor, but noticeably less lag) is the right one
 * once the recording fills the whole canvas instead of a small padded frame.
 */
export function buildCameraPath(path, segments, tight = false) {
  const n = path.length
  const out = new Float32Array(n * 2)
  if (n === 0) return out

  const deadZone = tight ? DEAD_ZONE_TIGHT : DEAD_ZONE
  const followK = tight ? FOLLOW_K_TIGHT : FOLLOW_K

  // Sample index -> the follow segment covering it, if any.
  const segAt = new Array(n).fill(null)
  for (const seg of segments) {
    if (!seg.follow) continue
    const from = Math.max(0, Math.floor((seg.start * 1000) / SAMPLE_MS))
    const to = Math.min(n - 1, Math.ceil((seg.end * 1000) / SAMPLE_MS))
    for (let i = from; i <= to; i++) segAt[i] = seg
  }

  let cx = 0.5
  let cy = 0.5
  for (let i = 0; i < n; i++) {
    const seg = segAt[i]
    if (seg) {
      let tx = path.lazy[i * 2]
      let ty = path.lazy[i * 2 + 1]
      if (tight) {
        // Pull the follow target itself partway back to true centre before
        // the spring below chases it — see CENTER_BIAS_TIGHT.
        tx += (0.5 - tx) * CENTER_BIAS_TIGHT
        ty += (0.5 - ty) * CENTER_BIAS_TIGHT
      }
      const dx = tx - cx
      const dy = ty - cy
      const dist = Math.hypot(dx, dy)
      if (dist > deadZone) {
        // Ramp from 0 to full strength over FEATHER, so crossing the dead
        // zone is never a discontinuity for tremor to chatter across.
        const strength = smoothstep(Math.min(1, (dist - deadZone) / FEATHER))
        cx += dx * strength * followK
        cy += dy * strength * followK
      }
    } else {
      // Outside a follow segment, ease back to centre at the same rate.
      cx += (0.5 - cx) * followK
      cy += (0.5 - cy) * followK
    }
    out[i * 2] = cx
    out[i * 2 + 1] = cy
  }

  // Softened alongside the dead-zone fix above — this pass was doing extra
  // duty smoothing over the old hard-edge chatter, so it had been pushed
  // tighter (0.14) than is actually comfortable now that the chatter itself
  // is gone at the source.
  return smoothPass(out, n, 0.1)
}

/**
 * Precomputes the *target* zoom scale for every sample of every follow
 * segment — see the SCALE_* constants above. Single-channel counterpart to
 * buildCameraPath, same reasoning for why it has to be a pure function of
 * (path, segments): scrubbing, live preview and export all read the same
 * trajectory or they'd disagree with each other.
 */
export function buildScaleTrack(path, segments) {
  const n = path.length
  const out = new Float32Array(n)
  if (n === 0) return out

  const activity = path.activity
  let steadyFor = 0
  for (const seg of segments) {
    if (!seg.follow) continue
    const from = Math.max(0, Math.floor((seg.start * 1000) / SAMPLE_MS))
    const to = Math.min(n - 1, Math.ceil((seg.end * 1000) / SAMPLE_MS))
    const ceiling = Math.min(seg.scale ?? DEFAULT_ZOOM.scale, DEFAULT_ZOOM.scale)
    steadyFor = 0
    for (let i = from; i <= to; i++) {
      const a = activity ? activity[i] : 0
      // Blend the "resting" level between the fast and steady ceilings by
      // how active the cursor currently reads.
      const fastness = clamp01((a - SCALE_ACTIVITY_LO) / (SCALE_ACTIVITY_HI - SCALE_ACTIVITY_LO))
      const resting = SCALE_STEADY + (SCALE_FAST - SCALE_STEADY) * fastness

      if (a < SCALE_ACTIVITY_LO) steadyFor += SAMPLE_MS / 1000
      else steadyFor = Math.max(0, steadyFor - (SAMPLE_MS / 1000) * STEADY_DECAY)

      // The longer it's stayed calm past SCALE_CREEP_AFTER, the further it
      // eases from "resting" up toward this segment's own ceiling.
      const creepK = easeInOut(clamp01((steadyFor - SCALE_CREEP_AFTER) / SCALE_CREEP_TIME))
      out[i] = resting + (Math.max(ceiling, resting) - resting) * creepK
    }
  }

  return smoothScalar(out, n, 0.06)
}

// Forward then backward, so the smoothing adds no net lag — single-channel
// version of smoothPass, for buildScaleTrack's output.
function smoothScalar(buf, n, alpha) {
  let v = buf[0]
  for (let i = 0; i < n; i++) {
    v += (buf[i] - v) * alpha
    buf[i] = v
  }
  v = buf[n - 1]
  for (let i = n - 1; i >= 0; i--) {
    v += (buf[i] - v) * alpha
    buf[i] = v
  }
  return buf
}

function sampleScalarAt(buffer, length, t) {
  const idx = (t * 1000) / SAMPLE_MS
  const i = Math.max(0, Math.min(length - 1, Math.floor(idx)))
  const j = Math.min(length - 1, i + 1)
  const f = idx - i
  return buffer[i] + (buffer[j] - buffer[i]) * f
}

// Forward then backward, so the smoothing adds no net lag.
function smoothPass(buf, n, alpha) {
  let x = buf[0]
  let y = buf[1]
  for (let i = 0; i < n; i++) {
    x += (buf[i * 2] - x) * alpha
    y += (buf[i * 2 + 1] - y) * alpha
    buf[i * 2] = x
    buf[i * 2 + 1] = y
  }
  x = buf[(n - 1) * 2]
  y = buf[(n - 1) * 2 + 1]
  for (let i = n - 1; i >= 0; i--) {
    x += (buf[i * 2] - x) * alpha
    y += (buf[i * 2 + 1] - y) * alpha
    buf[i * 2] = x
    buf[i * 2 + 1] = y
  }
  return buf
}

// Two-entry memo (loose + tight): cameraAt is called per frame with the same
// inputs, and the trajectories only need rebuilding when the path, the
// segments, or the loose/tight choice actually changes — a live preview can
// flip project.frameFillOnZoom at any time, so both variants stay cached
// rather than one evicting the other on every toggle.
let cachedLoose = { path: null, segments: null, camera: null, scale: null }
let cachedTight = { path: null, segments: null, camera: null, scale: null }
function cameraPath(path, segments, tight) {
  const slot = tight ? cachedTight : cachedLoose
  if (slot.path !== path || slot.segments !== segments) {
    const next = {
      path,
      segments,
      camera: buildCameraPath(path, segments, tight),
      scale: buildScaleTrack(path, segments),
    }
    if (tight) cachedTight = next
    else cachedLoose = next
    return next
  }
  return slot
}

/**
 * Camera state at time t: how far zoomed in, and where the viewport is
 * centred. Returns normalized coordinates so it is resolution independent.
 * `tight` requests the Frame-mode (project.frameFillOnZoom) follow — see
 * buildCameraPath.
 */
export function cameraAt(t, segments, path, tight = false) {
  const seg = segments.find((s) => t >= s.start && t <= s.end)
  if (!seg) return { scale: 1, x: 0.5, y: 0.5 }

  const half = (seg.end - seg.start) / 2
  const rampIn = Math.min(seg.ramp ?? DEFAULT_ZOOM.ramp, half)
  const rampOut = Math.min(seg.rampOut ?? DEFAULT_ZOOM.rampOut, half)
  let k = 1
  if (t < seg.start + rampIn) k = easeInOut((t - seg.start) / rampIn)
  else if (t > seg.end - rampOut) k = easeInOut((seg.end - t) / rampOut)

  const cached = seg.follow && path ? cameraPath(path, segments, tight) : null
  const target = cached ? sampleAt(cached.camera, path.length, t) : { x: seg.x, y: seg.y }
  // Follow segments get the activity-driven scale computed above; a manually
  // placed, non-follow segment keeps the flat scale the user set for it.
  const segScale = cached ? sampleScalarAt(cached.scale, path.length, t) : seg.scale ?? DEFAULT_ZOOM.scale

  return {
    scale: 1 + (segScale - 1) * k,
    // Drift back to centre as we zoom out, so the ease never looks like a pan.
    x: 0.5 + (target.x - 0.5) * k,
    y: 0.5 + (target.y - 0.5) * k,
  }
}
