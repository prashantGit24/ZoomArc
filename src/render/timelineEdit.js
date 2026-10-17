/**
 * Timeline editing rules shared by the editor and export: ripple delete,
 * clip linking (video ↔ webcam ↔ zooms), mapping recording time onto the
 * edited timeline, and where the finished video actually ends.
 */
import { newId, normalizeSegments } from './zoom.js'

const MIN_LEN = 0.05 // pieces shorter than this (seconds) are dropped
const EPS = 0.01

// Every track that lives on the timeline, in project order.
export const TRACK_KEYS = ['videoClips', 'cameraClips', 'segments', 'backgroundClips', 'texts', 'shapes', 'elements']
// Tracks that produce picture/sound — zooms only shape them, so they don't
// extend the video on their own.
const CONTENT_KEYS = ['videoClips', 'cameraClips', 'backgroundClips', 'texts', 'shapes', 'elements']

/** Where the finished video ends: the end of the last clip/overlay. */
export function contentEnd(project) {
  let end = 0
  for (const key of CONTENT_KEYS) for (const it of project[key] || []) end = Math.max(end, it.end)
  return end
}

/** Same span (within a frame) — how a webcam clip is linked to its video clip. */
export const sameSpan = (a, b) => Math.abs(a.start - b.start) < EPS && Math.abs(a.end - b.end) < EPS

/** Splits an item at timeline time `t`; source-mapped clips split their footage too. */
export function splitAt(item, t, rightId = newId()) {
  const hasSource = item.sourceStart != null
  const cut = hasSource ? item.sourceStart + (t - item.start) : undefined
  return [
    { ...item, end: t, ...(hasSource ? { sourceEnd: cut } : {}) },
    { ...item, id: rightId, start: t, ...(hasSource ? { sourceStart: cut } : {}) },
  ]
}

/**
 * Removes the timeline span [a, b] and closes the gap: everything after b
 * slides left by (b - a). Items that overlap the span lose the overlapping
 * part — source-mapped clips (webcam) are cut so each remaining piece still
 * plays the right footage; overlays and zooms just get shorter. Items left
 * shorter than MIN_LEN are removed.
 */
export function rippleDelete(project, a, b, removeId) {
  const len = b - a
  if (len <= 0) return project
  const map = (t) => (t <= a ? t : t >= b ? t - len : a)
  const next = { ...project }
  for (const key of TRACK_KEYS) {
    const items = project[key]
    if (!items) continue
    const out = []
    for (const it of items) {
      if (it.id === removeId) continue
      if (it.end <= a + EPS) {
        out.push(it)
      } else if (it.start >= b - EPS) {
        out.push({ ...it, start: it.start - len, end: it.end - len })
      } else if (it.sourceStart != null) {
        let keptLeft = false
        if (a - it.start > MIN_LEN) {
          out.push({ ...it, end: a, sourceEnd: it.sourceStart + (a - it.start) })
          keptLeft = true
        }
        if (it.end - b > MIN_LEN) {
          out.push({ ...it, id: keptLeft ? newId() : it.id, start: a, end: it.end - len, sourceStart: it.sourceStart + (b - it.start) })
        }
      } else {
        const start = map(it.start)
        const end = map(it.end)
        if (end - start > MIN_LEN) out.push({ ...it, start, end })
      }
    }
    next[key] = key === 'segments' ? normalizeSegments(out, Infinity) : out
  }
  return next
}

/**
 * Moving or trimming a video clip carries its linked webcam clip (same
 * span) with it, and a move also carries the zooms inside the clip — they
 * were placed for that footage.
 */
export function applyVideoChange(project, clip, nextClip, applyClipChange, sourceDuration) {
  const changes = { start: nextClip.start, end: nextClip.end }
  const d = nextClip.start - clip.start
  const isMove = Math.abs(d) > 1e-6 && Math.abs(nextClip.end - clip.end - d) < 1e-6
  const next = { ...project }
  next.cameraClips = (project.cameraClips || []).map((c) => (sameSpan(c, clip) ? applyClipChange(c, changes, sourceDuration) : c))
  if (isMove) {
    next.segments = normalizeSegments(
      project.segments.map((s) => (s.start >= clip.start - EPS && s.end <= clip.end + EPS ? { ...s, start: s.start + d, end: s.end + d } : s)),
      Infinity,
    )
  }
  return next
}

/**
 * Maps zoom segments placed in recording time (auto-detected from clicks)
 * onto the edited timeline: each segment is clipped to the footage each
 * video clip still shows and moved to where that footage now plays. Parts
 * covering cut footage disappear.
 */
export function segmentsToTimeline(segments, videoClips) {
  const out = []
  for (const seg of segments) {
    for (const c of videoClips || []) {
      const s = Math.max(seg.start, c.sourceStart)
      const e = Math.min(seg.end, c.sourceEnd)
      if (e - s < 0.3) continue
      out.push({ ...seg, id: out.some((o) => o.id === seg.id) ? newId() : seg.id, start: c.start + (s - c.sourceStart), end: c.start + (e - c.sourceStart) })
    }
  }
  return normalizeSegments(out, Infinity)
}
