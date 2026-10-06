import { cameraAt } from './zoom.js'
import { sampleAt, sampleScalar, exactCursorAt } from './track.js'

export const GRADIENTS = {
  midnight: ['#1e3a8a', '#0f172a'],
  sunset: ['#f97316', '#be185d'],
  mint: ['#34d399', '#0f766e'],
  slate: ['#475569', '#1e293b'],
  cotton: ['#fbcfe8', '#a5b4fc'],
  ember: ['#facc15', '#dc2626'],
}

// Named "webcam" internally (not "camera") to keep it unambiguous next to
// zoom.js's cameraAt/cameraPath, which is a wholly different thing — the
// virtual pan/zoom camera, not a physical device.
export const DEFAULT_WEBCAM = {
  enabled: false, // independent of whether the take *has* a recording, so toggling it off is non-destructive
  shape: 'round', // 'round' | 'square' — square's own corner radius is adjustable (see `radius`)
  corner: 'bottom-right', // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' — only used while `position` is unset
  size: 0.24, // fraction of the shorter content-rect edge
  margin: 0.035, // gap from the content edge, same units as size — only used while `position` is unset
  radius: 0, // px at 1080p, scaled with output — the 'square' shape's own corner rounding, 0 = actually square
  // Free placement — {x, y}, the fraction of the content rect the pill's
  // *centre* sits at, dragged directly on the canvas. null (the default)
  // means "follow `corner`" instead — an explicit position always wins once
  // set; picking a corner preset again clears it back to auto-follow.
  position: null,
  strokeWidth: 4, // px at 1080p
  strokeColor: '#ffffff',
  mirror: true, // flip horizontally, like a selfie camera
  animate: true, // ease the pill to its new spot when corner/size/margin change, in the live preview only
}

// Per-layer visibility/lock, shown as eye/lock toggles on each timeline
// track. Cursor has no entry here — it's a single global toggle
// (project.showCursor), not a timeline layer with its own blocks. The
// recorded video, the read-only Audio waveform, and the Camera track (whose
// entry is synthesized from project.webcam.enabled in Editor.jsx, not
// stored here — it already has its own toggle) only ever get a visible
// flag: they're fixed, whole-take tracks with nothing to lock against being
// dragged or trimmed.
export const DEFAULT_LAYERS = {
  video: { visible: true },
  zoom: { visible: true, locked: false },
  background: { visible: true, locked: false },
  text: { visible: true, locked: false },
  shapes: { visible: true, locked: false },
  elements: { visible: true, locked: false },
  audio: { visible: true },
}

export const DEFAULT_PROJECT = {
  background: { type: 'gradient', preset: 'midnight' },
  backgroundClips: [], // timed overrides: { id, start, end, bg, fadeIn, fadeOut }
  padding: 0.09, // fraction of the shorter output edge — was 0.06; widened to match the
  // ~10% margin measured on a reference capture (adiuHrc53Fu2hqt5.mp4) at rest.
  radius: 14, // px at 1080p, scaled with output
  shadow: 0.5,
  // When true, a Zoom segment pushes the recording past its own padded/
  // rounded frame to fill the whole canvas edge-to-edge as it zooms in —
  // "Frame" mode in the transport bar's toggle, vs "Video" (the recording
  // always stays inside the frame exactly as the Padding/Corner radius/
  // Shadow controls set it, zoomed or not). Defaults on: every zoomed-in shot
  // in the reference capture above bleeds edge-to-edge with no rounded
  // corner/shadow in sight — staying boxed in the padded frame while
  // actively zoomed never happens there, so that's the default motion now,
  // not an opt-in. See the bleed interpolation in renderFrame() below.
  frameFillOnZoom: true,
  clickHighlight: true,
  showCursor: false, // the OS cursor is already in the capture unless it was hidden
  cursorSmoothing: 0, // 0 = the real cursor's exact recorded motion
  cursorSize: 1,
  cursorImage: null, // data URL of a user-uploaded cursor graphic; null draws the built-in arrow
  // Where the uploaded image's own pointer tip actually is, as a fraction of
  // its width/height — picked by clicking the upload preview once. Defaults
  // to the top-left corner, a safe fallback for most simple sprite shapes
  // (an arrow's tip is usually near there) — unused while cursorImage is null.
  cursorHotspot: { x: 0, y: 0 },
  segments: [],
  texts: [], // { id, start, end, x, y, text, size, color, weight, align }
  shapes: [], // { id, start, end, type, x, y, w, h, color, strokeWidth, fill }
  elements: [], // { id, start, end, x, y, size, src, opacity }
  // { id, start, end, sourceStart, sourceEnd } — start/end place the clip on
  // the *timeline*; sourceStart/sourceEnd are the in/out points it plays
  // from the *source recording*. Editor.jsx seeds each with one clip
  // spanning the whole take (a fresh take has nothing trimmed yet); an empty
  // array here is what a fully-deleted track looks like, not "untrimmed".
  videoClips: [],
  cameraClips: [],
  webcam: DEFAULT_WEBCAM,
  layers: DEFAULT_LAYERS,
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const clamp01 = (v) => clamp(v, 0, 1)

// Matches --font-sans in styles.css — canvas can't read CSS custom
// properties, so the stack is duplicated here once, in one place.
const FONT_STACK = "'Archivo', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"

/**
 * Maps a timeline instant to a moment in the source recording, given the
 * clip(s) currently placed on that track (trimmed in/out points, and moved
 * to wherever they've been dragged) — the same idea as any NLE's video
 * track. Returns null when no clip covers `t` — a gap: the track has
 * nothing to show at this instant, whether because it was trimmed, split
 * and one half deleted, or the whole thing removed.
 */
export function clipTimeAt(t, clips) {
  const active = (clips || []).find((c) => t >= c.start && t < c.end)
  return active ? active.sourceStart + (t - active.start) : null
}

export function backgroundAt(t, project) {
  const clip = (project.backgroundClips || []).find((c) => t >= c.start && t < c.end)
  return clip ? clip.bg : project.background
}

/**
 * Which background(s) are on screen at `t`, and how far into a crossfade —
 * `a` alone outside any fade window, blending toward `b` by `mix` (0..1)
 * inside one. `fadeIn`/`fadeOut` live on the clip itself (seconds); the
 * "toward" side just re-asks backgroundAt() a moment outside the clip's own
 * span, so it naturally lands on whatever's actually adjacent — another
 * clip, or the base background — with no separate adjacency bookkeeping.
 */
export function backgroundTransitionAt(t, project) {
  const active = (project.backgroundClips || []).find((c) => t >= c.start && t < c.end)
  if (!active) return { a: backgroundAt(t, project), b: null, mix: 0 }

  const span = active.end - active.start
  const fadeIn = Math.min(active.fadeIn || 0, span / 2)
  const fadeOut = Math.min(active.fadeOut || 0, span / 2)

  if (fadeIn > 0 && t < active.start + fadeIn) {
    const before = backgroundAt(Math.max(0, active.start - 0.001), project)
    return { a: before, b: active.bg, mix: clamp01((t - active.start) / fadeIn) }
  }
  if (fadeOut > 0 && t > active.end - fadeOut) {
    const after = backgroundAt(active.end + 0.001, project)
    return { a: active.bg, b: after, mix: clamp01((t - (active.end - fadeOut)) / fadeOut) }
  }
  return { a: active.bg, b: null, mix: 0 }
}

/**
 * Endpoints of a linear gradient at `angle` degrees, CSS convention: 0 points
 * up, 90 points right. The line is extended so the gradient always covers the
 * whole box, whatever the angle.
 */
function gradientLine(angle, w, h) {
  const rad = ((angle ?? 135) * Math.PI) / 180
  const dx = Math.sin(rad)
  const dy = -Math.cos(rad)
  const len = Math.abs(w * dx) + Math.abs(h * dy)
  return [w / 2 - (dx * len) / 2, h / 2 - (dy * len) / 2, w / 2 + (dx * len) / 2, h / 2 + (dy * len) / 2]
}

// Presets are just a shortcut for a two-stop gradient; once a stop is edited the
// clip carries its own from/to and stops tracking the preset.
export function gradientStops(bg) {
  if (bg?.from && bg?.to) return [bg.from, bg.to]
  return GRADIENTS[bg?.preset] || GRADIENTS.midnight
}

function paintBackground(ctx, bg, w, h, images) {
  // 'none' leaves the canvas transparent — that is what an alpha export keeps.
  if (!bg || bg.type === 'none') {
    ctx.clearRect(0, 0, w, h)
    return
  }
  if (bg.type === 'solid') {
    ctx.fillStyle = bg.color || '#101014'
    ctx.fillRect(0, 0, w, h)
    return
  }
  if (bg.type === 'image') {
    const img = images?.get(bg.src)
    if (img?.complete && img.naturalWidth) {
      // 'contain' letterboxes onto the fill colour; 'cover' crops to fill.
      const pick = bg.fit === 'contain' ? Math.min : Math.max
      if (bg.fit === 'contain') {
        ctx.fillStyle = bg.color || '#101014'
        ctx.fillRect(0, 0, w, h)
      }
      const s = pick(w / img.naturalWidth, h / img.naturalHeight)
      const dw = img.naturalWidth * s
      const dh = img.naturalHeight * s
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
      return
    }
    ctx.fillStyle = bg.color || '#101014'
    ctx.fillRect(0, 0, w, h)
    return
  }

  const [from, to] = gradientStops(bg)
  const g = ctx.createLinearGradient(...gradientLine(bg.angle, w, h))
  g.addColorStop(0, from)
  g.addColorStop(1, to)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}

function roundedPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** Where the video sits inside the output frame, after padding. */
export function contentRect(project, videoAspect, w, h) {
  const pad = (project.padding ?? 0) * Math.min(w, h)
  const availW = w - pad * 2
  const availH = h - pad * 2
  let cw = availW
  let ch = cw / videoAspect
  if (ch > availH) {
    ch = availH
    cw = ch * videoAspect
  }
  return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch }
}

/**
 * Draws one fully composited frame. Used identically by the live preview and
 * the offline export, so what you scrub is what you ship.
 */
export function renderFrame(ctx, opts) {
  const { source, t, project, path, width: w, height: h, images } = opts
  const vw = opts.videoWidth || source.videoWidth || source.width
  const vh = opts.videoHeight || source.videoHeight || source.height
  if (!vw || !vh) return

  const layers = project.layers || DEFAULT_LAYERS

  ctx.save()
  ctx.clearRect(0, 0, w, h)
  if (layers.background?.visible !== false) {
    const { a, b, mix } = backgroundTransitionAt(t, project)
    paintBackground(ctx, a, w, h, images)
    if (b && mix > 0) {
      ctx.save()
      ctx.globalAlpha = mix
      paintBackground(ctx, b, w, h, images)
      ctx.restore()
    }
  }

  const rect = contentRect(project, vw / vh, w, h)
  const zoomOn = layers.zoom?.visible !== false
  // Frame mode's tighter, more-centred cursor follow (see DEAD_ZONE_TIGHT/
  // FOLLOW_K_TIGHT in zoom.js) — the recording fills the whole canvas in
  // that mode, so any lag off true centre reads much more than it does
  // inside the default's small padded frame.
  const cam = cameraAt(t, zoomOn ? project.segments || [] : [], path, !!project.frameFillOnZoom, project.videoClips)
  // Cursor data is on the recording's own clock; after a trim/split/move the
  // timeline time no longer equals it.
  const sourceT = clipTimeAt(t, project.videoClips)

  const scale = Math.min(w, h) / 1080

  // "Frame" mode (project.frameFillOnZoom): as a zoom pushes in, the
  // recording bleeds past its own padded/rounded frame to fill the whole
  // canvas edge-to-edge — bleedT ramps 0->1 over the first 30% of extra
  // zoom (cam.scale 1.0 -> 1.3) so it eases in smoothly alongside the zoom
  // itself, not as a cut. 0 the rest of the time — "Video" mode, or simply
  // not zoomed — so the frame stays exactly what the Padding/Corner
  // radius/Shadow controls set. videoRect/videoRadius (not the plain
  // rect/radius) are what the recording, its shadow, and the click/cursor
  // overlays glued to it actually draw into; the webcam pill and the other
  // overlay layers below stay anchored to the untouched, un-bled rect.
  const bleedT = project.frameFillOnZoom ? clamp01((cam.scale - 1) / 0.3) : 0
  const videoRect =
    bleedT > 0
      ? {
          x: rect.x + (0 - rect.x) * bleedT,
          y: rect.y + (0 - rect.y) * bleedT,
          w: rect.w + (w - rect.w) * bleedT,
          h: rect.h + (h - rect.h) * bleedT,
        }
      : rect
  const radius = (project.radius ?? 0) * scale * 2 * (1 - bleedT)

  // Zoom by cropping the source rather than scaling the destination: the
  // result stays pixel-sharp and clamps cleanly at the frame edges. The crop
  // starts out at the source's own aspect ratio (vw/vh) — but videoRect's
  // aspect ratio drifts away from that as Frame mode bleeds toward the
  // *output* frame's aspect ratio (which the aspect-ratio picker can set to
  // anything, independent of the recording's own shape). Drawing an
  // unmodified-aspect crop into a differently-shaped destination is exactly
  // what stretches/squeezes the picture, so the crop's aspect is adjusted to
  // match videoRect's — a cover-style crop (like CSS object-fit: cover), not
  // a stretch — cropping away extra source on whichever axis is now too
  // generous rather than distorting the image to fit.
  let sw = vw / cam.scale
  let sh = vh / cam.scale
  const destAspect = videoRect.w / videoRect.h
  if (sw / sh > destAspect) sw = sh * destAspect
  else sh = sw / destAspect
  const sx = clamp(cam.x * vw - sw / 2, 0, vw - sw)
  const sy = clamp(cam.y * vh - sh / 2, 0, vh - sh)

  // Hiding the Video layer, or landing in a gap the video track's clips
  // don't cover (trimmed off, or between two clips), skips the recording —
  // and, with it, the click ripples/cursor drawn on top of it, neither of
  // which mean anything without the footage under them — but leaves the
  // background and every overlay layer showing, e.g. to hold on just a
  // background/text title card.
  if (layers.video?.visible !== false && sourceT != null) {
    if (project.shadow > 0 && project.padding > 0 && bleedT < 1) {
      ctx.save()
      ctx.shadowColor = `rgba(0,0,0,${0.55 * project.shadow * (1 - bleedT)})`
      ctx.shadowBlur = 60 * scale * project.shadow
      ctx.shadowOffsetY = 24 * scale * project.shadow
      ctx.fillStyle = '#000'
      roundedPath(ctx, videoRect.x, videoRect.y, videoRect.w, videoRect.h, radius)
      ctx.fill()
      ctx.restore()
    }

    ctx.save()
    roundedPath(ctx, videoRect.x, videoRect.y, videoRect.w, videoRect.h, radius)
    ctx.clip()
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, sx, sy, sw, sh, videoRect.x, videoRect.y, videoRect.w, videoRect.h)

    const crop = { sx, sy, sw, sh, fullW: vw, fullH: vh }
    if (project.clickHighlight && path) {
      drawClicks(ctx, sourceT, path, videoRect, crop, scale)
    }
    if (project.showCursor && path) {
      drawCursor(ctx, sourceT, path, videoRect, crop, project, images, scale)
    }
    ctx.restore()
  }

  // Outside the video's own clip, so the pill can sit proud of its rounded
  // corner instead of being cut off by it.
  const cameraClipVisible = clipTimeAt(t, project.cameraClips) != null
  drawWebcam(ctx, opts.cameraSource, project.webcam, rect, scale, opts.webcamPos, cameraClipVisible)

  // Overlay layers — positioned relative to the content rect but, like the
  // webcam pill, outside the zoom camera's crop: they stay put on screen
  // rather than swimming with the zoom, which is what makes them read as an
  // annotation layer instead of part of the recording.
  if (layers.shapes?.visible !== false) drawShapes(ctx, t, project.shapes, rect, scale)
  if (layers.elements?.visible !== false) drawElements(ctx, t, project.elements, rect, images)
  if (layers.text?.visible !== false) drawTexts(ctx, t, project.texts, rect, scale)

  ctx.restore()
}

/**
 * Where the pill sits, in canvas pixels — a pure function of the webcam
 * settings and the content rect, so the editor's animated preview and the
 * frame-exact export both derive it from the same math (see webcamPos below).
 */
export function webcamRect(webcam, rect) {
  const wc = { ...DEFAULT_WEBCAM, ...webcam }
  const side = Math.min(rect.w, rect.h)
  const size = side * wc.size
  if (wc.position) {
    // Free placement: `position` is the pill's centre, dragged directly on
    // the canvas — no clamp, same reasoning as the Element layer's free
    // placement (a corner preset is one click away if it drifts off frame).
    return { x: rect.x + wc.position.x * rect.w - size / 2, y: rect.y + wc.position.y * rect.h - size / 2, size }
  }
  const margin = side * wc.margin
  const [vEdge, hEdge] = wc.corner.split('-')
  const x = hEdge === 'left' ? rect.x + margin : rect.x + rect.w - margin - size
  const y = vEdge === 'top' ? rect.y + margin : rect.y + rect.h - margin - size
  return { x, y, size }
}

/**
 * The floating webcam pill. `posOverride` lets the live preview substitute an
 * eased {x,y,size} while it's animating toward a newly-changed corner/size —
 * export always uses the plain webcamRect() result, since by then editing
 * has settled.
 */
function drawWebcam(ctx, cameraSource, webcam, rect, scale, posOverride, clipVisible = true) {
  if (!cameraSource || !webcam?.enabled || !clipVisible) return
  if (!cameraSource.videoWidth || !cameraSource.videoHeight) return
  const wc = { ...DEFAULT_WEBCAM, ...webcam }
  const { x, y, size } = posOverride || webcamRect(wc, rect)
  const radius = wc.shape === 'round' ? size / 2 : (wc.radius ?? DEFAULT_WEBCAM.radius) * scale

  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.35)'
  ctx.shadowBlur = 18 * scale
  ctx.shadowOffsetY = 5 * scale
  ctx.fillStyle = '#000'
  roundedPath(ctx, x, y, size, size, radius)
  ctx.fill()
  ctx.restore()

  ctx.save()
  roundedPath(ctx, x, y, size, size, radius)
  ctx.clip()
  ctx.imageSmoothingQuality = 'high'

  // Cover-fit crop from the source feed into the square pill.
  const vw = cameraSource.videoWidth
  const vh = cameraSource.videoHeight
  let sw, sh, sx, sy
  if (vw > vh) {
    sh = vh
    sw = vh
    sy = 0
    sx = (vw - sw) / 2
  } else {
    sw = vw
    sh = vw
    sx = 0
    sy = (vh - sh) / 2
  }

  ctx.translate(x + size / 2, y + size / 2)
  if (wc.mirror) ctx.scale(-1, 1)
  ctx.drawImage(cameraSource, sx, sy, sw, sh, -size / 2, -size / 2, size, size)
  ctx.restore()

  if (wc.strokeWidth > 0) {
    ctx.save()
    roundedPath(ctx, x, y, size, size, radius)
    ctx.lineWidth = wc.strokeWidth * scale
    ctx.strokeStyle = wc.strokeColor || DEFAULT_WEBCAM.strokeColor
    ctx.stroke()
    ctx.restore()
  }
}

/** A straight line with an arrowhead at (x2,y2), for the Shapes layer's arrow type. */
function drawArrow(ctx, x1, y1, x2, y2, lineWidth) {
  const headLen = Math.max(10, lineWidth * 3)
  const angle = Math.atan2(y2 - y1, x2 - x1)
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6))
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6))
  ctx.closePath()
  ctx.fill()
}

/** Rectangle / ellipse / arrow annotations placed by the Shapes tool. */
function drawShapes(ctx, t, shapes, rect, scale) {
  for (const it of shapes || []) {
    if (t < it.start || t >= it.end) continue
    const x = rect.x + it.x * rect.w
    const y = rect.y + it.y * rect.h
    const w = it.w * rect.w
    const h = it.h * rect.h
    ctx.save()
    ctx.strokeStyle = it.color || '#7c5cfa'
    ctx.fillStyle = it.color || '#7c5cfa'
    ctx.lineWidth = Math.max(1, (it.strokeWidth ?? 4) * scale)
    ctx.lineJoin = 'round'
    if (it.type === 'ellipse') {
      ctx.beginPath()
      ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, Math.PI * 2)
      it.fill ? ctx.fill() : ctx.stroke()
    } else if (it.type === 'arrow') {
      drawArrow(ctx, x, y + h, x + w, y, ctx.lineWidth)
    } else {
      it.fill ? ctx.fillRect(x, y, w, h) : ctx.strokeRect(x, y, w, h)
    }
    ctx.restore()
  }
}

/** User-uploaded image stickers/logos placed by the Elements tool. */
function drawElements(ctx, t, elements, rect, images) {
  for (const it of elements || []) {
    if (t < it.start || t >= it.end) continue
    const img = images?.get(it.src)
    if (!img?.complete || !img.naturalWidth) continue
    const box = (it.size ?? 0.2) * Math.min(rect.w, rect.h)
    const aspect = img.naturalWidth / img.naturalHeight
    const w = aspect >= 1 ? box : box * aspect
    const h = aspect >= 1 ? box / aspect : box
    const x = rect.x + it.x * rect.w - w / 2
    const y = rect.y + it.y * rect.h - h / 2
    ctx.save()
    ctx.globalAlpha = it.opacity ?? 1
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, x, y, w, h)
    ctx.restore()
  }
}

/** Caption/label text placed by the Text tool — supports \n line breaks. */
function drawTexts(ctx, t, texts, rect, scale) {
  for (const it of texts || []) {
    if (t < it.start || t >= it.end) continue
    const px = rect.x + it.x * rect.w
    const py = rect.y + it.y * rect.h
    const size = Math.max(6, (it.size ?? 0.06) * rect.h)
    const lines = String(it.text ?? '').split('\n')
    const lineHeight = size * 1.25

    ctx.save()
    ctx.font = `${(it.weight ?? 700) >= 700 ? 700 : 400} ${size}px ${FONT_STACK}`
    ctx.textAlign = it.align || 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = it.color || '#ffffff'
    ctx.shadowColor = 'rgba(0,0,0,0.5)'
    ctx.shadowBlur = size * 0.15
    ctx.shadowOffsetY = size * 0.03
    const totalH = lineHeight * (lines.length - 1)
    lines.forEach((line, i) => ctx.fillText(line, px, py - totalH / 2 + i * lineHeight))
    ctx.restore()
  }
}

const RIPPLE_MS = 600

function drawClicks(ctx, t, path, rect, crop, scale) {
  for (const click of path.clicks) {
    const age = (t - click.t) * 1000
    if (age < 0 || age > RIPPLE_MS) continue
    const k = age / RIPPLE_MS
    const px = rect.x + ((click.x * crop.fullW - crop.sx) / crop.sw) * rect.w
    const py = rect.y + ((click.y * crop.fullH - crop.sy) / crop.sh) * rect.h
    const r = (10 + 34 * k) * scale * (rect.w / crop.sw) * 0.6
    ctx.save()
    ctx.strokeStyle = `rgba(255,255,255,${0.55 * (1 - k)})`
    ctx.lineWidth = 3 * scale
    ctx.beginPath()
    ctx.arc(px, py, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
}

export function cursorAt(t, path, smoothing = 0) {
  // 0 = the exact recorded motion, interpolated straight from the real
  // samples; the slider crossfades toward the smoothed glide.
  const exact = exactCursorAt(path, t)
  if (smoothing <= 0) return exact
  const s = sampleAt(path.cursor, path.length, t)
  return { x: exact.x + (s.x - exact.x) * smoothing, y: exact.y + (s.y - exact.y) * smoothing }
}

// macOS-style arrow, drawn in a 1x1 space scaled to size at draw time.
const ARROW = [
  [0, 0], [0, 0.73], [0.19, 0.56], [0.31, 0.86],
  [0.44, 0.80], [0.32, 0.51], [0.56, 0.50],
]

function drawCursor(ctx, t, path, rect, crop, project, images, scale) {
  const visible = path.visible ? sampleScalar(path.visible, path.length, t) : 1
  if (visible < 0.01) return
  const pos = cursorAt(t, path, project.cursorSmoothing ?? 0)
  const px = rect.x + ((pos.x * crop.fullW - crop.sx) / crop.sw) * rect.w
  const py = rect.y + ((pos.y * crop.fullH - crop.sy) / crop.sh) * rect.h

  // Sized purely by output resolution (`scale`), deliberately NOT by the
  // current zoom magnification — a giant cursor once you're zoomed in reads
  // as a mistake, not a stylistic choice, which is why every screen-recording
  // tool keeps the drawn cursor's on-screen size constant regardless of zoom.
  // (Previously scaled with `rect.w / crop.sw`, i.e. with zoom — the earlier
  // reasoning was "matches what the real captured cursor would have looked
  // like", but that's exactly the pixel-baked-in look this cursor is
  // supposed to replace with something adjustable.)
  const size = 28 * (project.cursorSize ?? 1) * (scale ?? 1)

  // A user-uploaded cursor image takes over entirely when set. `cursorHotspot`
  // (fraction 0-1 of the image's own width/height, picked by the user at
  // upload time — see the Cursor panel) is where the image's own pointer tip
  // actually is, so it — not the image's top-left corner — is what lands on
  // the recorded coordinate; skipping this is the single most common way a
  // custom cursor ends up looking subtly disconnected from what it's
  // pointing at, especially once zoomed in.
  const img = project.cursorImage && images?.get(project.cursorImage)
  if (img?.complete && img.naturalWidth) {
    const h = size * 1.15 // custom art tends to fill its canvas more than the built-in arrow's glyph does
    const w = h * (img.naturalWidth / img.naturalHeight)
    const hotspot = project.cursorHotspot ?? { x: 0, y: 0 }
    ctx.save()
    ctx.globalAlpha *= visible
    ctx.imageSmoothingQuality = 'high'
    ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.shadowBlur = h * 0.2
    ctx.shadowOffsetY = h * 0.05
    ctx.drawImage(img, px - hotspot.x * w, py - hotspot.y * h, w, h)
    ctx.restore()
    return
  }

  ctx.save()
  ctx.globalAlpha *= visible
  ctx.translate(px, py)
  ctx.beginPath()
  ctx.moveTo(ARROW[0][0] * size, ARROW[0][1] * size)
  for (const [x, y] of ARROW.slice(1)) ctx.lineTo(x * size, y * size)
  ctx.closePath()
  ctx.shadowColor = 'rgba(0,0,0,0.45)'
  ctx.shadowBlur = size * 0.25
  ctx.shadowOffsetY = size * 0.06
  ctx.fillStyle = '#fff'
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.lineWidth = Math.max(1, size * 0.055)
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  ctx.stroke()
  ctx.restore()
}
