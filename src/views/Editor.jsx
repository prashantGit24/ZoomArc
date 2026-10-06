import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import ThemeToggle from '../components/ThemeToggle.jsx'
import Timeline from './Timeline.jsx'
import logo from '../assets/logo.png'
import { buildMousePath } from '../render/track.js'
import { autoZooms, normalizeSegments, newId, DEFAULT_ZOOM } from '../render/zoom.js'
import {
  renderFrame,
  contentRect,
  webcamRect,
  clipTimeAt,
  DEFAULT_PROJECT,
  DEFAULT_WEBCAM,
  DEFAULT_LAYERS,
  GRADIENTS,
  backgroundAt,
  gradientStops,
} from '../render/renderFrame.js'
import { decodeWaveform } from '../render/waveform.js'
import { generateThumbnails } from '../render/thumbnails.js'

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const pct = (v) => `${Math.round(v * 100)}%`
const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`

// Elements get free-form placement — no clamp on x/y (their centre can sit
// well past the frame edges, so a large image can bleed off it deliberately)
// and a wide size range (1% of the frame's short side up to 4x it).
const ELEMENT_SIZE_MIN = 0.01
const ELEMENT_SIZE_MAX = 4

// Timeline panel height — user-resizable by dragging the strip above it, and
// remembered across takes/relaunches as their standing preference.
const TIMELINE_HEIGHT_KEY = 'zoomarc.timelineHeight'
const TIMELINE_MIN_HEIGHT = 90
const TIMELINE_MAX_HEIGHT = 360
const TIMELINE_DEFAULT_HEIGHT = 132

function loadTimelineHeight() {
  const saved = Number(localStorage.getItem(TIMELINE_HEIGHT_KEY))
  return saved >= TIMELINE_MIN_HEIGHT && saved <= TIMELINE_MAX_HEIGHT ? saved : TIMELINE_DEFAULT_HEIGHT
}

// The user's own standing cursor image/hotspot, remembered across takes —
// "Set as default" below saves whatever's currently uploaded here; every new
// project then starts with it already applied instead of the built-in arrow.
// Separate from DEFAULT_PROJECT.cursorImage (which stays null: a machine
// with no saved preference yet should still get the plain built-in cursor).
const DEFAULT_CURSOR_KEY = 'zoomarc.defaultCursor'

function loadDefaultCursor() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEFAULT_CURSOR_KEY) || 'null')
    return saved?.image ? saved : null
  } catch {
    return null
  }
}

function saveDefaultCursor(image, hotspot) {
  try {
    localStorage.setItem(DEFAULT_CURSOR_KEY, JSON.stringify({ image, hotspot }))
  } catch {
    /* localStorage unavailable/full — the "Set as default" click just won't stick this time */
  }
}

// Lets the (module-level, not nested inside Editor) <Slider> component reach
// the undo-history batching helpers below without threading two more props
// through every one of its ~20 call sites — see beginHistoryBatch/
// endHistoryBatch for why a slider drag needs this at all.
const HistoryBatchContext = createContext({ beginHistoryBatch: () => {}, endHistoryBatch: () => {} })

const WEBCAM_SHAPES = [
  { id: 'round', label: 'Round' },
  { id: 'square', label: 'Square' },
]
const WEBCAM_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

const BG_MODES = [
  { id: 'gradient', label: 'Gradient' },
  { id: 'solid', label: 'Colour' },
  { id: 'image', label: 'Image' },
  { id: 'none', label: 'Transparent' },
]

const SHAPE_TYPES = [
  { id: 'rect', label: 'Rectangle' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'arrow', label: 'Arrow' },
]

// The left tool rail. 'select'/'zoom'/'text'/'shapes' arm the canvas — the
// next click places (or, for select, repositions) something, then the tool
// reverts to 'select'. 'background'/'elements'/'cursor'/'transitions' act
// immediately instead (see selectTool below), so `tool` state never actually
// becomes one of those — which is also why the rail only ever highlights
// Select/Zoom/Text/Shapes, matching a plain video editor's "armed tool" idea.
const TOOLS = [
  { id: 'select', label: 'Select', icon: 'select' },
  { id: 'zoom', label: 'Zoom', icon: 'zoom' },
  { id: 'background', label: 'Background', icon: 'background' },
  { id: 'cursor', label: 'Cursor', icon: 'pointer' },
  { id: 'text', label: 'Text', icon: 'text' },
  { id: 'shapes', label: 'Shapes', icon: 'shapes' },
  { id: 'elements', label: 'Elements', icon: 'elements' },
  { id: 'transitions', label: 'Transitions', icon: 'transitions' },
]

// Maps a selection/timeline-block kind to where it lives in the project and
// which Layers-panel entry (renderFrame.js's DEFAULT_LAYERS) governs its
// visibility/lock — the one indirection every generic (kind-agnostic)
// operation below (delete, split, drag-lock, layer toggle) is built on.
const KIND_TO_LAYER = { zoom: 'zoom', bg: 'background', text: 'text', shape: 'shapes', element: 'elements' }
const KIND_TO_ARRAY = {
  zoom: 'segments', bg: 'backgroundClips', text: 'texts', shape: 'shapes', element: 'elements',
  video: 'videoClips', camera: 'cameraClips',
}

// Export resolution presets, named after the short edge (the number a "p"
// label actually means — 1080 scanlines, whichever edge that is once an
// aspect ratio can make the frame portrait or ultrawide). 'source' exports
// at whatever was actually captured — genuinely native, no scaling either way.
const EXPORT_RESOLUTIONS = [
  { id: 'source', label: 'Source resolution' },
  { id: '1080p', label: '1080p', short: 1080 },
  { id: '1440p', label: '1440p', short: 1440 },
  { id: '4k', label: '4K UHD', short: 2160 },
]

// Output frame aspect ratio, independent of the source recording's own
// proportions. 'source' keeps today's behaviour — the frame matches the
// capture exactly, no bars. Any other ratio changes only the *frame*: the
// video itself is never cropped or stretched, it just letterboxes/pillarboxes
// inside the new shape (contentRect in renderFrame.js already fits by aspect).
const ASPECT_RATIOS = [
  { id: 'source', label: 'Source' },
  { id: '21:9', label: '21:9 · Ultrawide', ratio: 21 / 9 },
  { id: '16:9', label: '16:9 · Widescreen', ratio: 16 / 9 },
  { id: '16:10', label: '16:10', ratio: 16 / 10 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '4:3', label: '4:3 · Classic', ratio: 4 / 3 },
  { id: '5:4', label: '5:4', ratio: 5 / 4 },
  { id: '1:1', label: '1:1 · Square', ratio: 1 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '2:3', label: '2:3', ratio: 2 / 3 },
  { id: '10:16', label: '10:16', ratio: 10 / 16 },
  { id: '9:16', label: '9:16 · Vertical', ratio: 9 / 16 },
]

function resolveExportSize(resId, aspectId, sourceW, sourceH) {
  if (!sourceW || !sourceH) return { width: sourceW, height: sourceH }
  const preset = EXPORT_RESOLUTIONS.find((r) => r.id === resId)
  const custom = ASPECT_RATIOS.find((r) => r.id === aspectId && r.ratio)
  const ratio = custom?.ratio || sourceW / sourceH

  if (!preset?.short && !custom) {
    // Source resolution, source aspect — the untouched original.
    return { width: sourceW, height: sourceH }
  }

  // 'source' resolution with a custom ratio keeps the recording's own short
  // edge; a preset re-targets it. Scales up for a genuine higher-resolution
  // export, or down for a smaller one, exactly like any other video tool.
  const shortEdge = preset?.short || Math.min(sourceW, sourceH)
  let w, h
  if (ratio >= 1) {
    h = shortEdge
    w = Math.round(h * ratio)
  } else {
    w = shortEdge
    h = Math.round(w / ratio)
  }
  // Even dimensions — required by the chroma-subsampled pixel formats
  // downstream (exporter.cjs already floors again, this just keeps the
  // number shown in the UI honest).
  return { width: Math.floor(w / 2) * 2, height: Math.floor(h / 2) * 2 }
}

// Switching mode keeps whatever the new mode can reuse, so flipping back and
// forth doesn't lose the colour you just picked.
function defaultBg(type, prev) {
  if (type === 'gradient') {
    const [from, to] = gradientStops(prev)
    return { type, preset: prev.preset ?? 'midnight', from, to, angle: prev.angle ?? 135 }
  }
  if (type === 'solid') return { type, color: prev.color || gradientStops(prev)[0] }
  if (type === 'image') return { type, src: prev.src || null, fit: prev.fit || 'cover', color: prev.color || '#101014' }
  return { type: 'none' }
}

// Applies a Timeline drag's resulting {start, end} to an item, and — for
// Video/Camera clips, which also carry a sourceStart/sourceEnd in/out
// mapping into the recording — works out from the change itself whether
// that drag was a *trim* (only one edge moved: that edge's source point
// moves with it, clamped to the recording's own [0, sourceDuration] bounds,
// pulling the timeline edge back in tandem if it would go past them) or a
// *move* (both edges shifted by the same amount: the source mapping is left
// alone, since it's the same footage just playing at a different time).
// Plain items (zoom/text/shape/etc, with no source mapping) just take the
// change as-is.
function applyClipChange(item, changes, sourceDuration) {
  const next = { ...item, ...changes }
  if (item.sourceStart == null || !('start' in changes || 'end' in changes)) return next

  const dStart = (changes.start ?? item.start) - item.start
  const dEnd = (changes.end ?? item.end) - item.end
  if (dStart === dEnd) return next // a move: same footage, just relocated on the timeline

  if (dStart) {
    const wanted = item.sourceStart + dStart
    const clamped = Math.max(0, wanted)
    next.sourceStart = clamped
    next.start = item.start + dStart + (clamped - wanted) // pull the timeline edge back by whatever we clamped off
  }
  if (dEnd) {
    const wanted = item.sourceEnd + dEnd
    const clamped = Math.min(sourceDuration, wanted)
    next.sourceEnd = clamped
    next.end = item.end + dEnd + (clamped - wanted)
  }
  return next
}

const videoMime = (p) => (/\.mp4$/i.test(p) ? 'video/mp4' : 'video/webm')

export default function Editor({ take, onBack, showShortcuts, setShowShortcuts }) {
  const { track, videoPath, cameraPath } = take
  const path = useMemo(() => buildMousePath(track), [track])
  // Same formula the component's own `duration` below resolves to — needed
  // here already, to seed the Video/Camera tracks with one clip spanning
  // the whole (as yet untrimmed) take.
  const initialDuration = path.duration || track.durationMs / 1000

  const [project, setProject] = useState(() => {
    const defaultCursor = loadDefaultCursor()
    return {
      ...DEFAULT_PROJECT,
      // Only draw our cursor when the capture genuinely left the real one out,
      // otherwise the frame would show two pointers.
      showCursor: !!track.source?.cursorHidden,
      // A saved "Set as default" cursor applies to every new project from
      // here on — DEFAULT_PROJECT itself stays at the plain built-in arrow
      // (null) for machines with no saved preference yet.
      ...(defaultCursor ? { cursorImage: defaultCursor.image, cursorHotspot: defaultCursor.hotspot } : {}),
      segments: autoZooms(path),
      // On by default only when this take actually has a webcam recording.
      webcam: { ...DEFAULT_WEBCAM, enabled: !!cameraPath },
      videoClips: [{ id: newId(), start: 0, end: initialDuration, sourceStart: 0, sourceEnd: initialDuration }],
      cameraClips: cameraPath
        ? [{ id: newId(), start: 0, end: initialDuration, sourceStart: 0, sourceEnd: initialDuration }]
        : [],
    }
  })
  // Undo/redo: `past`/`future` hold whole prior project snapshots. Every
  // project mutation should go through updateProject() (not setProject
  // directly) so it's captured here — see the block of editing helpers below.
  const [history, setHistory] = useState({ past: [], future: [] })
  const [videoUrl, setVideoUrl] = useState(null)
  const [cameraUrl, setCameraUrl] = useState(null)
  const [waveform, setWaveform] = useState(null)
  const [videoThumbs, setVideoThumbs] = useState([])
  const [cameraThumbs, setCameraThumbs] = useState([])
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selected, setSelected] = useState(null)
  const [tool, setTool] = useState('select')
  const [previewZoom, setPreviewZoom] = useState(null) // null = "Fit"; otherwise a percent (25-400)
  const [timelineZoom, setTimelineZoom] = useState(1) // 1 = whole duration fits; higher = zoomed in
  const [queuing, setQueuing] = useState(false)
  const [formats, setFormats] = useState([])
  const [format, setFormat] = useState('mp4')
  const [qualities, setQualities] = useState({ presets: [], default: 'lossless', tunableFormats: [] })
  const [quality, setQuality] = useState('lossless')
  const [exportRes, setExportRes] = useState('source')
  const [aspectRatio, setAspectRatio] = useState('source')
  const [status, setStatus] = useState(null)
  const [name, setName] = useState(track.name)
  const [renaming, setRenaming] = useState(false)
  const [timelineHeight, setTimelineHeight] = useState(loadTimelineHeight)

  const videoRef = useRef(null)
  const cameraRef = useRef(null)
  const canvasRef = useRef(null)
  const frameRef = useRef(null)
  const stageRef = useRef(null)
  const cursorSectionRef = useRef(null)
  const transitionSectionRef = useRef(null)
  const elementFileRef = useRef(null)
  const hintTimerRef = useRef(null)
  const imagesRef = useRef(new Map())
  const projectRef = useRef(project)
  projectRef.current = project
  const historyRef = useRef(history)
  historyRef.current = history
  // A cursor image seeded from the user's saved default (see loadDefaultCursor
  // above) arrives as a bare data URL, not via the upload flow's readImage()
  // — which is what actually decodes an <img> and registers it in imagesRef
  // for the renderer to find. Runs once, on mount, for exactly that case;
  // every other way cursorImage changes (a fresh upload) already goes
  // through readImage itself.
  useEffect(() => {
    const src = projectRef.current.cursorImage
    if (src && !imagesRef.current.has(src)) {
      const img = new Image()
      img.onload = () => imagesRef.current.set(src, img)
      img.src = src
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // The pill's last-drawn position, eased toward the target each frame —
  // export never sees this, it always draws at the settled position.
  const webcamPosRef = useRef(null)
  // True for the duration of a canvas drag on the webcam pill — the preview
  // should track the pointer directly while dragging, not creep toward it at
  // the usual "Animate position changes" ease rate.
  const webcamDraggingRef = useRef(false)

  const duration = path.duration || track.durationMs / 1000
  const out = track.videoSize || { width: 1920, height: 1080 }

  /* --------------------------------------------------------------- layers */

  const layers = project.layers || DEFAULT_LAYERS
  const layerVisible = (key) => (layers[key]?.visible ?? DEFAULT_LAYERS[key]?.visible) !== false
  const layerLocked = (key) => !!(layers[key]?.locked ?? DEFAULT_LAYERS[key]?.locked)

  function flashHint(message) {
    setStatus({ kind: 'error', message })
    clearTimeout(hintTimerRef.current)
    hintTimerRef.current = setTimeout(() => setStatus((s) => (s?.message === message ? null : s)), 2200)
  }

  /* ------------------------------------------------------------- loading */

  useEffect(() => {
    let url
    let canceled = false
    window.api.readTakeVideo(videoPath).then((buf) => {
      if (canceled) return
      url = URL.createObjectURL(new Blob([buf], { type: videoMime(videoPath) }))
      setVideoUrl(url)
      // Only bother decoding audio when the take actually recorded a mic —
      // decodeWaveform already resolves to null on a track-less/silent take,
      // this just skips the (much more expensive) decode for one entirely.
      if (track.source?.mic) {
        decodeWaveform(buf).then((peaks) => !canceled && setWaveform(peaks))
      }
    })
    return () => {
      canceled = true
      url && URL.revokeObjectURL(url)
    }
  }, [videoPath])

  useEffect(() => {
    if (!cameraPath) return
    let url
    window.api.readTakeVideo(cameraPath).then((buf) => {
      url = URL.createObjectURL(new Blob([buf], { type: videoMime(cameraPath) }))
      setCameraUrl(url)
    })
    return () => url && URL.revokeObjectURL(url)
  }, [cameraPath])

  // Filmstrip frames for the Video/Camera tracks — generated once per take,
  // covering the *whole* original recording (initialDuration, not the
  // possibly-trimmed `duration` of individual clips) so Timeline.jsx can
  // pick whichever frames a given clip's current sourceStart/sourceEnd
  // range calls for, however that clip's since been trimmed or split.
  useEffect(() => {
    if (!videoUrl) return
    let canceled = false
    generateThumbnails(videoUrl, initialDuration).then((thumbs) => !canceled && setVideoThumbs(thumbs))
    return () => { canceled = true }
  }, [videoUrl])

  useEffect(() => {
    if (!cameraUrl) return
    let canceled = false
    generateThumbnails(cameraUrl, initialDuration).then((thumbs) => !canceled && setCameraThumbs(thumbs))
    return () => { canceled = true }
  }, [cameraUrl])

  /* ------------------------------------------------------------ preview */

  const draw = useCallback(
    (t) => {
      const canvas = canvasRef.current
      const video = videoRef.current
      if (!canvas || !video || !video.videoWidth) return

      const proj = projectRef.current
      const camera = cameraRef.current
      let webcamPos
      if (proj.webcam?.enabled && camera?.videoWidth) {
        const rect = contentRect(proj, video.videoWidth / video.videoHeight, canvas.width, canvas.height)
        const target = webcamRect(proj.webcam, rect)
        const prev = webcamPosRef.current
        // Snap instantly the first time (nothing to ease from yet), when
        // animation is turned off, or while actively being dragged (it
        // should track the pointer 1:1, not creep toward it); otherwise
        // chase the target each frame — same speed-independent-of-framerate
        // ease used for the zoom camera.
        webcamPos = !prev || !proj.webcam.animate || webcamDraggingRef.current
          ? target
          : {
              x: prev.x + (target.x - prev.x) * 0.18,
              y: prev.y + (target.y - prev.y) * 0.18,
              size: prev.size + (target.size - prev.size) * 0.18,
            }
        webcamPosRef.current = webcamPos
      } else {
        webcamPosRef.current = null
      }

      renderFrame(canvas.getContext('2d'), {
        source: video,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        cameraSource: camera,
        webcamPos,
        t,
        project: proj,
        path,
        width: canvas.width,
        height: canvas.height,
        images: imagesRef.current,
      })
    },
    [path],
  )

  // Scrubbing drives the video directly; the rAF loop repaints from it.
  const timeRef = useRef(0)
  timeRef.current = time

  useEffect(() => {
    let raf
    // The timeline's own clock — not the video element's — is authoritative
    // now that Video/Camera can be trimmed/split/moved: the recording may
    // not cover every instant (a gap plays nothing), so `t` has to keep
    // advancing through gaps on its own rather than being derived from
    // wherever the video's decoder happens to be. The video/camera elements
    // are just kept in step with wherever *this* clock says they should be,
    // playing while a clip covers `t`, paused in a gap, and only reseeked
    // when they've drifted enough to notice (a scrub, or a decode stall) —
    // reseeking every frame would visibly stutter the decode.
    let anchorWall = 0
    let anchorTime = 0
    const RESYNC = 0.15

    // While the recording is playing, the clock is phase-locked to the video
    // element's own playback clock rather than only resynced once it drifts
    // past RESYNC — otherwise the cursor/camera can run up to RESYNC ahead of
    // or behind the pixels under them. currentTime (not per-frame callbacks):
    // native captures are variable-frame-rate, so frames can be far apart.
    const lockToVideo = (t) => {
      const el = videoRef.current
      if (!el || el.paused || el.seeking || el.readyState < 2) return 0
      const media = el.currentTime
      const clip = (projectRef.current.videoClips || []).find(
        (c) => t >= c.start && t < c.end && media >= c.sourceStart - 0.1 && media <= c.sourceEnd + 0.1,
      )
      if (!clip) return 0
      const err = clip.start + (media - clip.sourceStart) - t
      return Math.abs(err) < RESYNC ? err * 0.5 : 0
    }

    const syncTrack = (el, clips) => {
      if (!el) return
      const at = clipTimeAt(timeRef.current, clips)
      if (at == null) {
        if (!el.paused) el.pause()
        return
      }
      if (playing && el.paused) el.play().catch(() => {}) // autoplay can reject; the next tick's resync covers a missed start
      if (Math.abs(el.currentTime - at) > RESYNC) el.currentTime = at
    }

    const loop = () => {
      let t = timeRef.current
      if (playing) {
        const now = performance.now() / 1000
        if (!anchorWall) {
          anchorWall = now
          anchorTime = timeRef.current
        }
        t = anchorTime + (now - anchorWall)
        const correction = lockToVideo(t)
        anchorTime += correction
        t += correction
        if (t >= duration) {
          t = duration
          setPlaying(false)
        }
        setTime(t)
        timeRef.current = t // read by syncTrack() below within this same tick
      }
      // Read via projectRef (kept fresh every render, same as draw() does)
      // rather than closing over project.videoClips/cameraClips directly —
      // those get a new array reference on every trim/split/drag edit, and
      // depending on them here would tear down and rebuild this whole rAF
      // loop on every drag tick.
      syncTrack(videoRef.current, projectRef.current.videoClips)
      syncTrack(cameraRef.current, projectRef.current.cameraClips)
      draw(t)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [draw, playing, duration])

  const seek = (t) => {
    const clamped = Math.max(0, Math.min(duration, t))
    setTime(clamped)
    const videoAt = clipTimeAt(clamped, project.videoClips)
    if (videoAt != null && videoRef.current) videoRef.current.currentTime = videoAt
    const camAt = clipTimeAt(clamped, project.cameraClips)
    if (camAt != null && cameraRef.current) cameraRef.current.currentTime = camAt
  }

  const togglePlay = () => {
    if (!videoRef.current) return
    if (playing) {
      videoRef.current.pause()
      cameraRef.current?.pause()
      setPlaying(false)
    } else {
      if (timeRef.current >= duration - 0.05) seek(0)
      setPlaying(true) // the loop above takes it from here — playing/pausing/seeking each track as its clips require
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen()
    else stageRef.current?.requestFullscreen()
  }

  // Persisted as soon as it settles, so the next take (or the next launch)
  // opens at whatever height this user last left it — a standing preference,
  // not a per-take one.
  useEffect(() => {
    localStorage.setItem(TIMELINE_HEIGHT_KEY, String(timelineHeight))
  }, [timelineHeight])

  const startTimelineResize = (e) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = timelineHeight
    const bar = e.currentTarget
    bar.classList.add('active')
    bar.setPointerCapture?.(e.pointerId)
    const move = (ev) => {
      // Dragging up (clientY decreases) grows the panel — it sits at the
      // bottom of the window, so "up" is the intuitive way to make it taller.
      const next = startH + (startY - ev.clientY)
      setTimelineHeight(Math.max(TIMELINE_MIN_HEIGHT, Math.min(TIMELINE_MAX_HEIGHT, next)))
    }
    const up = () => {
      bar.classList.remove('active')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  useEffect(() => {
    window.api.exportFormats().then(setFormats).catch(() => {})
    window.api
      .exportQualities()
      .then((q) => {
        setQualities(q)
        setQuality(q.default)
      })
      .catch(() => {})
  }, [])

  /* ---------------------------------------------------------- undo/redo */

  // Every edit goes through here instead of setProject directly, so it's
  // captured on the history stack. `updater` is the same shape React's
  // setState accepts — a value or a (prev) => next function.
  //
  // A drag or a slider fires this dozens of times for one gesture (every
  // pointermove/onChange tick), which — pushed individually — used to fill
  // up the history with near-identical mid-drag frames of the *same*
  // gesture, evicting the pre-drag state before the user ever got to it: one
  // Ctrl+Z (or fifty) would only step back a pixel at a time and never
  // actually undo the drag, which is what made undo/redo look broken.
  // `historyBatchRef` fixes that: beginHistoryBatch() (called on pointerdown,
  // before the first change) snapshots the *pre-gesture* state once; every
  // updateProject call until endHistoryBatch() (pointerup) just updates the
  // state in place without pushing another entry. So a whole drag/
  // slider-drag becomes one undo step, exactly like a single discrete edit.
  const historyBatchRef = useRef(false)
  // The pre-gesture snapshot, pushed lazily on the batch's *first* actual
  // change rather than eagerly on pointerdown — so a click that never turns
  // into a drag (no change ever made) doesn't leave a no-op entry on the
  // undo stack.
  const batchSnapshotRef = useRef(null)
  // No cap — every edit for the life of the session stays undoable. Each
  // entry is one project snapshot (JS keeps the underlying arrays/objects
  // shared via structural sharing wherever an edit didn't touch them, so this
  // is far cheaper than "N snapshots' worth of the whole project").
  // Same rule as undo/redo below: work out the new project and history first,
  // then set them — a state updater that itself pushes history would push it
  // twice whenever React double-runs updaters.
  const updateProject = useCallback((updater) => {
    const p = projectRef.current
    const next = typeof updater === 'function' ? updater(p) : updater
    if (next === p) return
    let h = historyRef.current
    if (!historyBatchRef.current) {
      h = { past: [...h.past, p], future: [] }
    } else if (batchSnapshotRef.current !== null) {
      h = { past: [...h.past, batchSnapshotRef.current], future: [] }
      batchSnapshotRef.current = null
    }
    if (h !== historyRef.current) {
      historyRef.current = h
      setHistory(h)
    }
    projectRef.current = next
    setProject(next)
  }, [])
  const beginHistoryBatch = useCallback(() => {
    if (historyBatchRef.current) return // a nested/second pointerdown before the matching pointerup — ignore it
    historyBatchRef.current = true
    batchSnapshotRef.current = projectRef.current
  }, [])
  const endHistoryBatch = useCallback(() => {
    historyBatchRef.current = false
    batchSnapshotRef.current = null
  }, [])

  // Computed up front and then applied, never inside a state updater: React
  // may run updaters twice (StrictMode), and reading projectRef in there saw
  // the already-undone project on the second run, so redo restored nothing.
  // Refs are advanced immediately so key-repeat undos chain correctly.
  const undo = useCallback(() => {
    const h = historyRef.current
    if (!h.past.length) return
    const prev = h.past[h.past.length - 1]
    const next = { past: h.past.slice(0, -1), future: [projectRef.current, ...h.future] }
    historyRef.current = next
    projectRef.current = prev
    setHistory(next)
    setProject(prev)
  }, [])

  const redo = useCallback(() => {
    const h = historyRef.current
    if (!h.future.length) return
    const restored = h.future[0]
    const next = { past: [...h.past, projectRef.current], future: h.future.slice(1) }
    historyRef.current = next
    projectRef.current = restored
    setHistory(next)
    setProject(restored)
  }, [])

  /* ------------------------------------------------------------ shortcuts */
  // The full set is listed in components/ShortcutsOverlay.jsx (press ?).

  const FRAME = 1 / 60
  const clipboardRef = useRef(null)

  const selectedItem = () => {
    if (!selected) return null
    return (projectRef.current[KIND_TO_ARRAY[selected.kind]] || []).find((it) => it.id === selected.id) || null
  }

  const selectionLocked = () => {
    const key = KIND_TO_LAYER[selected?.kind]
    if (!key || !layerLocked(key)) return false
    flashHint('That layer is locked — unlock it in Layers to edit.')
    return true
  }

  // Every item boundary on every track, for jumping between edits.
  const jumpEdit = (dir) => {
    const pts = new Set([0, duration])
    for (const key of Object.values(KIND_TO_ARRAY)) {
      for (const it of projectRef.current[key] || []) {
        pts.add(it.start)
        pts.add(it.end)
      }
    }
    const sorted = [...pts].sort((a, b) => a - b)
    const target = dir > 0 ? sorted.find((p) => p > time + 1e-3) : sorted.reverse().find((p) => p < time - 1e-3)
    if (target != null) seek(target)
  }

  const nudgeSelected = (dt) => {
    const it = selectedItem()
    if (!it || selectionLocked()) return
    const d = Math.max(-it.start, Math.min(duration - it.end, dt))
    if (d) updateItem(selected.kind, it.id, { start: it.start + d, end: it.end + d })
  }

  const trimSelected = (edge) => {
    const it = selectedItem()
    if (!it || selectionLocked()) return
    if (edge === 'start') {
      if (time >= it.end - 0.05) return flashHint("Put the playhead before the item's end to trim its start.")
      updateItem(selected.kind, it.id, { start: time })
    } else {
      if (time <= it.start + 0.05) return flashHint("Put the playhead after the item's start to trim its end.")
      updateItem(selected.kind, it.id, { end: time })
    }
  }

  // A copy of `item` starting at `start` (video/camera copies keep their
  // source mapping, so they play the same footage).
  const insertCopy = (kind, item, start) => {
    const layerKey = KIND_TO_LAYER[kind]
    if (layerKey && layerLocked(layerKey)) return flashHint('That layer is locked — unlock it in Layers to edit.')
    const len = item.end - item.start
    const s = Math.max(0, Math.min(start, duration - len))
    const copy = { ...item, id: newId(), start: s, end: Math.min(duration, s + len), ...(kind === 'zoom' ? { auto: false } : {}) }
    const key = KIND_TO_ARRAY[kind]
    updateProject((p) =>
      kind === 'zoom'
        ? { ...p, segments: normalizeSegments([...p.segments, copy], duration) }
        : { ...p, [key]: [...(p[key] || []), copy] },
    )
    setSelected({ kind, id: copy.id })
  }

  // Zoom segments can't overlap — adding, moving or pasting one onto another
  // merges them (normalizeSegments), which retires the moved one's id. Keep
  // the selection on the merged segment instead of pointing at nothing.
  useEffect(() => {
    if (selected?.kind !== 'zoom' || project.segments.some((s) => s.id === selected.id)) return
    const here = project.segments.find((s) => time >= s.start && time <= s.end)
    setSelected(here ? { kind: 'zoom', id: here.id } : null)
  }, [project.segments, selected, time])

  const copySelected = () => {
    const it = selectedItem()
    if (it) clipboardRef.current = { kind: selected.kind, item: it }
    return !!it
  }

  useEffect(() => {
    const onKey = (e) => {
      const t = e.target
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return
      const run = (fn) => {
        e.preventDefault()
        fn()
      }
      const k = e.code

      // The overlay handles its own Esc/? to close; nothing else acts meanwhile.
      if (showShortcuts) return

      if (e.ctrlKey || e.metaKey) {
        if (k === 'KeyZ') return run(() => (e.shiftKey ? redo() : undo()))
        if (k === 'KeyY') return run(redo)
        if (k === 'KeyC' && selected) return run(copySelected)
        if (k === 'KeyX' && selected) return run(() => copySelected() && removeSelected())
        if (k === 'KeyV' && clipboardRef.current) {
          const { kind, item } = clipboardRef.current
          return run(() => insertCopy(kind, item, time))
        }
        if (k === 'KeyD' && selected) {
          const it = selectedItem()
          return run(() => it && insertCopy(selected.kind, it, it.end))
        }
        if (k === 'KeyB') return run(splitSelected)
        if (k === 'KeyE') return run(runExport)
        if (k === 'Slash') return run(() => setShowShortcuts(true))
        return
      }

      if (e.altKey) {
        if (k === 'ArrowLeft') return run(() => nudgeSelected(-(e.shiftKey ? 1 : FRAME)))
        if (k === 'ArrowRight') return run(() => nudgeSelected(e.shiftKey ? 1 : FRAME))
        return
      }

      switch (k) {
        case 'Space':
        case 'KeyK':
          return run(togglePlay)
        case 'KeyJ':
          return run(() => seek(time - 5))
        case 'KeyL':
          return run(() => seek(time + 5))
        case 'ArrowLeft':
          return run(() => seek(time - (e.shiftKey ? 1 : FRAME)))
        case 'ArrowRight':
          return run(() => seek(time + (e.shiftKey ? 1 : FRAME)))
        case 'ArrowUp':
          return run(() => jumpEdit(-1))
        case 'ArrowDown':
          return run(() => jumpEdit(1))
        case 'Home':
          return run(() => seek(0))
        case 'End':
          return run(() => seek(duration))
        case 'Delete':
        case 'Backspace':
          if (selected) run(removeSelected)
          return
        case 'KeyS':
          return run(splitSelected)
        case 'BracketLeft':
          return run(() => trimSelected('start'))
        case 'BracketRight':
          return run(() => trimSelected('end'))
        case 'Escape':
          return run(() => {
            setSelected(null)
            setTool('select')
          })
        case 'KeyV':
          return run(() => setTool('select'))
        case 'KeyZ':
          return run(addZoom)
        case 'KeyT':
          return run(() => selectTool('text'))
        case 'KeyR':
          return run(() => selectTool('shapes'))
        case 'KeyB':
          return run(() => selectTool('background'))
        case 'KeyE':
          return run(() => selectTool('elements'))
        case 'KeyC':
          return run(() => selectTool('cursor'))
        case 'KeyF':
          return run(toggleFullscreen)
        case 'Equal':
        case 'NumpadAdd':
          return run(() => setTimelineZoom((z) => Math.min(8, z * 1.5)))
        case 'Minus':
        case 'NumpadSubtract':
          return run(() => setTimelineZoom((z) => Math.max(1, z / 1.5)))
        case 'Backslash':
          return run(() => setTimelineZoom(1))
        case 'Slash':
          if (e.shiftKey) run(() => setShowShortcuts(true))
          return
        default:
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // "Fit" scale: how much to shrink the frame so it sits fully inside
  // .stage's padded content box (never upscales past 1, same as the old
  // max-width:100% behaviour it replaces). Measured in JS, not CSS, because
  // the wrapper also has to give the element move/resize overlay a genuinely
  // sized box to position percentages against — an inline-block hugging a
  // max-width:100% canvas hugging an inline-block... doesn't reliably
  // resolve. A numeric preview zoom (previewZoom set) overrides this outright.
  const frameSize = resolveExportSize('source', aspectRatio, out.width, out.height)
  const [fitScale, setFitScale] = useState(1)
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const compute = () => {
      const cs = getComputedStyle(stage)
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      const availW = Math.max(1, stage.clientWidth - padX)
      const availH = Math.max(1, stage.clientHeight - padY)
      setFitScale(Math.min(1, availW / frameSize.width, availH / frameSize.height))
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [frameSize.width, frameSize.height])
  const previewScale = previewZoom ? previewZoom / 100 : fitScale

  /* ------------------------------------------------------------- editing */

  const patch = (updates) => updateProject((p) => ({ ...p, ...updates }))
  const patchWebcam = (updates) => updateProject((p) => ({ ...p, webcam: { ...p.webcam, ...updates } }))

  const toggleLayer = (key, field) => {
    // The Camera track's visibility isn't its own layer entry — it's the
    // existing "Show camera" toggle (project.webcam.enabled) wearing a
    // second hat, so there's one source of truth instead of two toggles
    // that could disagree.
    if (key === 'camera') return patchWebcam({ enabled: !project.webcam.enabled })
    updateProject((p) => {
      const base = p.layers || DEFAULT_LAYERS
      const cur = base[key] || DEFAULT_LAYERS[key] || {}
      return { ...p, layers: { ...base, [key]: { ...cur, [field]: !cur[field] } } }
    })
  }

  const updateItem = (kind, id, changes) =>
    updateProject((p) => {
      if (kind === 'zoom') {
        const segments = p.segments.map((s) => (s.id === id ? { ...s, ...changes, auto: false } : s))
        return { ...p, segments: normalizeSegments(segments, duration) }
      }
      const arrayKey = KIND_TO_ARRAY[kind]
      return {
        ...p,
        [arrayKey]: (p[arrayKey] || []).map((it) => (it.id === id ? applyClipChange(it, changes, duration) : it)),
      }
    })

  const addZoom = () => {
    if (layerLocked('zoom')) return flashHint('The Zoom layer is locked — unlock it in Layers to edit.')
    const start = time
    const end = Math.min(duration, start + 2.5)
    const seg = {
      id: newId(),
      start,
      end,
      scale: DEFAULT_ZOOM.scale,
      ramp: DEFAULT_ZOOM.ramp,
      rampOut: DEFAULT_ZOOM.rampOut,
      follow: true,
      x: 0.5,
      y: 0.5,
      auto: false,
    }
    updateProject((p) => ({ ...p, segments: normalizeSegments([...p.segments, seg], duration) }))
    setSelected({ kind: 'zoom', id: seg.id })
  }

  const addBackgroundClip = () => {
    if (layerLocked('background')) return flashHint('The Background layer is locked — unlock it in Layers to edit.')
    const clip = {
      id: newId(),
      start: time,
      end: Math.min(duration, time + 3),
      bg: { type: 'gradient', preset: 'sunset' },
      fadeIn: 0,
      fadeOut: 0,
    }
    updateProject((p) => ({ ...p, backgroundClips: [...p.backgroundClips, clip] }))
    setSelected({ kind: 'bg', id: clip.id })
  }

  const addTextAt = (x, y) => {
    if (layerLocked('text')) return flashHint('The Text layer is locked — unlock it in Layers to edit.')
    const item = {
      id: newId(),
      start: time,
      end: Math.min(duration, time + 3),
      x,
      y,
      text: 'Text',
      size: 0.06,
      color: '#ffffff',
      weight: 700,
      align: 'center',
    }
    updateProject((p) => ({ ...p, texts: [...(p.texts || []), item] }))
    setSelected({ kind: 'text', id: item.id })
  }

  const addShapeAt = (x, y) => {
    if (layerLocked('shapes')) return flashHint('The Shapes layer is locked — unlock it in Layers to edit.')
    const item = {
      id: newId(),
      start: time,
      end: Math.min(duration, time + 3),
      type: 'rect',
      x: clamp01(x - 0.08),
      y: clamp01(y - 0.06),
      w: 0.16,
      h: 0.12,
      color: '#7c5cfa',
      strokeWidth: 4,
      fill: false,
    }
    updateProject((p) => ({ ...p, shapes: [...(p.shapes || []), item] }))
    setSelected({ kind: 'shape', id: item.id })
  }

  function readImage(file, onDone) {
    const fr = new FileReader()
    fr.onload = () => {
      const src = fr.result
      const img = new Image()
      img.onload = () => imagesRef.current.set(src, img)
      img.src = src
      onDone(src)
    }
    fr.readAsDataURL(file)
  }

  const addElementFile = (file) => {
    if (layerLocked('elements')) return flashHint('The Elements layer is locked — unlock it in Layers to edit.')
    readImage(file, (src) => {
      const item = { id: newId(), start: time, end: Math.min(duration, time + 3), x: 0.5, y: 0.5, size: 0.22, src, opacity: 1 }
      updateProject((p) => ({ ...p, elements: [...(p.elements || []), item] }))
      setSelected({ kind: 'element', id: item.id })
    })
  }

  const replaceElementImage = (id, file) => {
    readImage(file, (src) => updateItem('element', id, { src }))
  }

  const removeSelected = () => {
    if (!selected) return
    const layerKey = KIND_TO_LAYER[selected.kind]
    if (layerKey && layerLocked(layerKey)) return flashHint('That layer is locked — unlock it in Layers to edit.')
    const arrayKey = KIND_TO_ARRAY[selected.kind]
    updateProject((p) => ({ ...p, [arrayKey]: (p[arrayKey] || []).filter((it) => it.id !== selected.id) }))
    setSelected(null)
  }

  // Splits whatever's selected into two items at the playhead — works the
  // same way for a zoom segment, a background clip, a text/shape/element, or
  // anything else with a start/end, via the kind→array indirection above.
  const splitSelected = () => {
    if (!selected) return
    const layerKey = KIND_TO_LAYER[selected.kind]
    if (layerKey && layerLocked(layerKey)) return flashHint('That layer is locked — unlock it in Layers to edit.')
    const arrayKey = KIND_TO_ARRAY[selected.kind]
    const arr = project[arrayKey] || []
    const item = arr.find((it) => it.id === selected.id)
    if (!item || time <= item.start + 0.05 || time >= item.end - 0.05) {
      return flashHint('Move the playhead inside the selected item to split it.')
    }
    const rightId = newId()
    // Video/Camera clips also carry a sourceStart/sourceEnd in/out mapping
    // into the recording — split that at the matching point too, so each
    // half still plays the right footage instead of both ending up mapped
    // to the original clip's full (now too-wide) source range.
    const hasSource = item.sourceStart != null
    const splitSource = hasSource ? item.sourceStart + (time - item.start) : undefined
    updateProject((p) => ({
      ...p,
      [arrayKey]: p[arrayKey]
        .map((it) => (it.id === item.id ? { ...it, end: time, ...(hasSource ? { sourceEnd: splitSource } : {}) } : it))
        .concat({ ...item, id: rightId, start: time, ...(hasSource ? { sourceStart: splitSource } : {}) }),
    }))
    setSelected({ kind: selected.kind, id: rightId })
  }

  function runAddTrack(kind) {
    if (kind === 'zoom') addZoom()
    else if (kind === 'background') addBackgroundClip()
    else if (kind === 'text') setTool('text')
    else if (kind === 'shapes') setTool('shapes')
    else if (kind === 'elements') elementFileRef.current?.click()
  }

  function selectTool(id) {
    if (id === 'background') {
      addBackgroundClip()
      setTool('select')
      return
    }
    if (id === 'elements') {
      elementFileRef.current?.click()
      return
    }
    if (id === 'cursor') {
      cursorSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    if (id === 'transitions') {
      if (selectedClip) transitionSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      else flashHint('Select a background clip on the timeline to edit its transition.')
      return
    }
    setTool(id)
  }

  function handleCanvasClick(e) {
    const box = e.currentTarget.getBoundingClientRect()
    const fx = clamp01((e.clientX - box.left) / box.width)
    const fy = clamp01((e.clientY - box.top) / box.height)

    if (tool === 'zoom') {
      if (layerLocked('zoom')) {
        flashHint('The Zoom layer is locked — unlock it in Layers to edit.')
        setTool('select')
        return
      }
      const start = time
      const end = Math.min(duration, start + 2.5)
      const seg = {
        id: newId(), start, end,
        scale: DEFAULT_ZOOM.scale, ramp: DEFAULT_ZOOM.ramp, rampOut: DEFAULT_ZOOM.rampOut,
        follow: false, x: fx, y: fy, auto: false,
      }
      updateProject((p) => ({ ...p, segments: normalizeSegments([...p.segments, seg], duration) }))
      setSelected({ kind: 'zoom', id: seg.id })
      setTool('select')
      return
    }
    if (tool === 'text') {
      addTextAt(fx, fy)
      setTool('select')
      return
    }
    if (tool === 'shapes') {
      addShapeAt(fx, fy)
      setTool('select')
      return
    }
    // 'select': reposition an anchored (non-follow) zoom segment, as before.
    if (!selectedSegment || selectedSegment.follow) return
    updateItem('zoom', selectedSegment.id, { x: fx, y: fy })
  }

  // Elements: drag the body to move it anywhere (including past the frame
  // edge — no clamp, unlike every other on-canvas placement above), drag a
  // corner to resize it at any size. `corner` is the [sx, sy] direction from
  // the element's centre to whichever corner is being dragged (e.g. top-left
  // is [-1,-1]); omitted entirely for a body drag (move).
  function startElementDrag(e, corner) {
    e.stopPropagation()
    e.preventDefault()
    if (!selectedElement || layerLocked('elements')) return
    beginHistoryBatch() // one undo step for the whole drag, not one per pointermove

    const { rect } = elementBox
    const startX = selectedElement.x
    const startY = selectedElement.y
    const startSize = selectedElement.size ?? 0.2
    const startClientX = e.clientX
    const startClientY = e.clientY

    const move = (ev) => {
      // Pointer movement in screen px -> frame px (undoes whatever CSS
      // fit/zoom scale is currently applied) -> a fraction of the content
      // rect, matching how x/y and size are actually interpreted below.
      // Re-measured every move (not cached at drag-start) in case the
      // window resizes mid-drag, same as the timeline's own drag handlers.
      const box = frameRef.current.getBoundingClientRect()
      const dxPx = ((ev.clientX - startClientX) / box.width) * frameSize.width
      const dyPx = ((ev.clientY - startClientY) / box.height) * frameSize.height

      if (!corner) {
        updateItem('element', selectedElement.id, {
          x: startX + dxPx / rect.w,
          y: startY + dyPx / rect.h,
        })
      } else {
        const [sx, sy] = corner
        const outward = (dxPx * sx + dyPx * sy) / Math.SQRT2 // movement away from centre, along this corner's diagonal
        const startBoxPx = startSize * Math.min(rect.w, rect.h)
        const nextBoxPx = Math.max(4, startBoxPx + outward * 2)
        const size = Math.max(ELEMENT_SIZE_MIN, Math.min(ELEMENT_SIZE_MAX, nextBoxPx / Math.min(rect.w, rect.h)))
        updateItem('element', selectedElement.id, { size })
      }
    }
    const up = () => {
      endHistoryBatch()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Camera pill: drag the body anywhere for a custom spot (overrides the
  // corner presets — see project.webcam.position), drag a corner to resize
  // it. Structurally the same as startElementDrag above, just against
  // patchWebcam instead of updateItem, and it also drives webcamDraggingRef
  // so the live preview tracks the pointer directly instead of easing.
  function startWebcamDrag(e, corner) {
    e.stopPropagation()
    e.preventDefault()
    if (!webcamBox) return
    beginHistoryBatch()
    webcamDraggingRef.current = true

    const { rect } = webcamBox
    const startPos = project.webcam.position || {
      x: (webcamBox.cx - rect.x) / rect.w,
      y: (webcamBox.cy - rect.y) / rect.h,
    }
    const startSize = project.webcam.size
    const startClientX = e.clientX
    const startClientY = e.clientY

    const move = (ev) => {
      const box = frameRef.current.getBoundingClientRect()
      const dxPx = ((ev.clientX - startClientX) / box.width) * frameSize.width
      const dyPx = ((ev.clientY - startClientY) / box.height) * frameSize.height

      if (!corner) {
        patchWebcam({ position: { x: startPos.x + dxPx / rect.w, y: startPos.y + dyPx / rect.h } })
      } else {
        const [sx, sy] = corner
        const outward = (dxPx * sx + dyPx * sy) / Math.SQRT2
        const side = Math.min(rect.w, rect.h)
        const startSidePx = startSize * side
        const nextSidePx = Math.max(8, startSidePx + outward * 2)
        patchWebcam({ size: Math.max(0.12, Math.min(0.45, nextSidePx / side)) })
      }
    }
    const up = () => {
      webcamDraggingRef.current = false
      endHistoryBatch()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const regenerate = () => {
    if (layerLocked('zoom')) return flashHint('The Zoom layer is locked — unlock it in Layers to edit.')
    updateProject((p) => ({ ...p, segments: autoZooms(path, { scale: p.segments[0]?.scale ?? 2 }) }))
  }

  const activeFormat = formats.find((f) => f.id === format)
  const exportSize = resolveExportSize(exportRes, aspectRatio, out.width, out.height)
  // Any 'none' background — base or clip — means the export needs an alpha format.
  const usesTransparency =
    project.background?.type === 'none' ||
    project.backgroundClips.some((c) => c.bg?.type === 'none')

  const selectedSegment = selected?.kind === 'zoom' ? project.segments.find((s) => s.id === selected.id) : null
  const selectedClip = selected?.kind === 'bg' ? project.backgroundClips.find((c) => c.id === selected.id) : null
  const selectedText = selected?.kind === 'text' ? (project.texts || []).find((it) => it.id === selected.id) : null
  const selectedShape = selected?.kind === 'shape' ? (project.shapes || []).find((it) => it.id === selected.id) : null
  const selectedElement = selected?.kind === 'element' ? (project.elements || []).find((it) => it.id === selected.id) : null

  // Geometry for the on-canvas move/resize handles below — the same
  // content-rect math drawElements() in renderFrame.js uses, so the handles
  // land exactly on the element as drawn, in Fit or in a preview-zoom.
  const elementBox = (() => {
    if (!selectedElement) return null
    const rect = contentRect(project, out.width / out.height, frameSize.width, frameSize.height)
    const img = imagesRef.current.get(selectedElement.src)
    const aspect = img?.naturalWidth ? img.naturalWidth / img.naturalHeight : 1
    const box = (selectedElement.size ?? 0.2) * Math.min(rect.w, rect.h)
    const w = aspect >= 1 ? box : box * aspect
    const h = aspect >= 1 ? box / aspect : box
    const cx = rect.x + selectedElement.x * rect.w
    const cy = rect.y + selectedElement.y * rect.h
    return {
      rect,
      left: ((cx - w / 2) / frameSize.width) * 100,
      top: ((cy - h / 2) / frameSize.height) * 100,
      width: (w / frameSize.width) * 100,
      height: (h / frameSize.height) * 100,
    }
  })()

  // Geometry for the camera pill's own move/resize handles — same idea as
  // elementBox above, built from webcamRect() (renderFrame.js) so the
  // handles land exactly on the pill as drawn.
  const webcamBox = (() => {
    if (!project.webcam?.enabled || !cameraPath) return null
    const rect = contentRect(project, out.width / out.height, frameSize.width, frameSize.height)
    const { x, y, size } = webcamRect(project.webcam, rect)
    return {
      rect,
      cx: x + size / 2,
      cy: y + size / 2,
      left: (x / frameSize.width) * 100,
      top: (y / frameSize.height) * 100,
      width: (size / frameSize.width) * 100,
      height: (size / frameSize.height) * 100,
    }
  })()

  const selectedVideoClip = selected?.kind === 'video' ? (project.videoClips || []).find((c) => c.id === selected.id) : null
  const selectedCameraClip = selected?.kind === 'camera' ? (project.cameraClips || []).find((c) => c.id === selected.id) : null

  // Background editing targets the selected clip if there is one, else the base.
  const activeBg = selectedClip ? selectedClip.bg : project.background
  const setActiveBg = (bg) =>
    selectedClip
      ? updateItem('bg', selectedClip.id, { bg })
      : patch({ background: bg })

  // Stored as a data URL, not a blob URL: blob URLs are scoped to this window
  // and would be dead by the time the export worker tried to draw them.
  const pickImage = (file) => {
    readImage(file, (src) => setActiveBg({ ...activeBg, type: 'image', src, fit: activeBg.fit || 'cover' }))
  }

  /* -------------------------------------------------------------- rename */

  async function commitRename(next) {
    setRenaming(false)
    if (next.trim() === name) return
    try {
      const saved = await window.api.renameTake(take.dir, next)
      setName(saved)
      // Keep the in-memory take in step so going back and reopening agrees.
      track.name = saved
    } catch (e) {
      setStatus({ kind: 'error', message: `Could not rename: ${e.message}` })
      setName(track.name) // put the title back to what is actually stored
    }
  }

  /* -------------------------------------------------------------- export */

  // Blob URLs are scoped to this window; the worker window gets data URLs.
  async function inlineImages(p) {
    const cache = new Map()
    const toData = async (src) => {
      if (!src || src.startsWith('data:')) return src
      if (cache.has(src)) return cache.get(src)
      const blob = await fetch(src).then((r) => r.blob())
      const data = await new Promise((resolve) => {
        const fr = new FileReader()
        fr.onload = () => resolve(fr.result)
        fr.readAsDataURL(blob)
      })
      cache.set(src, data)
      return data
    }
    const fix = async (bg) =>
      bg?.type === 'image' ? { ...bg, src: await toData(bg.src) } : bg
    return {
      ...p,
      background: await fix(p.background),
      backgroundClips: await Promise.all(
        p.backgroundClips.map(async (c) => ({ ...c, bg: await fix(c.bg) })),
      ),
      elements: await Promise.all((p.elements || []).map(async (el) => ({ ...el, src: await toData(el.src) }))),
      cursorImage: await toData(p.cursorImage),
    }
  }

  async function runExport() {
    if (queuing) return
    setQueuing(true)
    try {
      const project = await inlineImages(projectRef.current)
      const res = await window.api.enqueueExport({
        name,
        videoPath,
        cameraVideoPath: cameraPath || null,
        track,
        project,
        fps: 60,
        format,
        quality,
        durationSec: duration,
        width: exportSize.width,
        height: exportSize.height,
        audioPath: track.source?.mic && layerVisible('audio') ? videoPath : null,
      })
      if (!res.canceled) {
        setStatus({ kind: 'ok', message: 'Export queued — it keeps running if you leave this take.' })
      }
    } catch (e) {
      setStatus({ kind: 'error', message: e.message })
    } finally {
      setQueuing(false)
    }
  }

  /* ---------------------------------------------------------------- view */

  return (
    <HistoryBatchContext.Provider value={{ beginHistoryBatch, endHistoryBatch }}>
    <div className="app editor">
      <header className="titlebar">
        <img className="logo" src={logo} alt="" />
        <button className="btn ghost icon" onClick={onBack} title="Back to takes">
          <Icon name="back" />
        </button>
        {renaming ? (
          <input
            className="text-input title"
            autoFocus
            defaultValue={name}
            maxLength={80}
            onBlur={(e) => commitRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                // Escape must not save, so drop the edit before blur fires.
                e.currentTarget.value = name
                e.currentTarget.blur()
              }
            }}
          />
        ) : (
          <h1 className="title-edit" title="Click to rename" onClick={() => setRenaming(true)}>
            {name}
          </h1>
        )}
        <div className="row">
          {usesTransparency && !activeFormat?.alpha && (
            <span className="warn" title="Pick MOV or PNG sequence to keep transparency">
              ⚠ {activeFormat?.ext?.toUpperCase() || 'This format'} has no alpha
            </span>
          )}
          <select
            className="select pill"
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value)}
            title={`Frame aspect ratio — ${frameSize.width} × ${frameSize.height}`}
          >
            {ASPECT_RATIOS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id === 'source' ? `${r.label} (${out.width}:${out.height})` : r.label}
              </option>
            ))}
          </select>
          <select
            className="select pill"
            value={exportRes}
            onChange={(e) => setExportRes(e.target.value)}
            title={`Export resolution — ${exportSize.width} × ${exportSize.height}`}
          >
            {EXPORT_RESOLUTIONS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id === 'source' ? `${r.label} (${out.width}×${out.height})` : r.label}
              </option>
            ))}
          </select>
          <select
            className="select pill"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            title="Export format"
          >
            {formats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          {qualities.tunableFormats.includes(format) && (
            <select
              className="select pill"
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
              title="Export quality — trades file size for fidelity"
            >
              {qualities.presets.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.label}
                </option>
              ))}
            </select>
          )}
          <button className="btn ghost icon" disabled={!history.past.length} onClick={undo} title="Undo (Ctrl+Z)">
            <Icon name="undo" />
          </button>
          <button className="btn ghost icon" disabled={!history.future.length} onClick={redo} title="Redo (Ctrl+Shift+Z)">
            <Icon name="redo" />
          </button>
          <button className="btn ghost icon kbd-btn" onClick={() => setShowShortcuts(true)} title="Keyboard shortcuts (?)">
            ?
          </button>
          <ThemeToggle />
          <button className="btn primary export-btn" disabled={queuing} onClick={runExport}>
            <Icon name="export" />
            {queuing ? 'Queuing…' : 'Export'}
          </button>
        </div>
      </header>

      {status && (
        <div className={status.kind === 'ok' ? 'notice' : 'error'}>
          {status.message}
          {status.outPath && (
            <button className="btn ghost sm" onClick={() => window.api.reveal(status.outPath)}>
              Show in Finder
            </button>
          )}
          <button className="btn ghost sm" onClick={() => setStatus(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="stage-row">
        <aside className="tool-rail">
          <div className="rail-group">
            <h4>Tools</h4>
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`tool-btn ${tool === t.id ? 'active' : ''}`}
                onClick={() => selectTool(t.id)}
                title={t.label}
              >
                <Icon name={t.icon} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>

          <input
            ref={elementFileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              if (e.target.files[0]) addElementFile(e.target.files[0])
              e.target.value = ''
            }}
          />
        </aside>

        <div className="stage" ref={stageRef}>
          <div
            ref={frameRef}
            className="stage-frame"
            style={{ width: frameSize.width * previewScale, height: frameSize.height * previewScale }}
          >
            <canvas ref={canvasRef} width={frameSize.width} height={frameSize.height} onClick={handleCanvasClick} />
            {selectedElement && elementBox && tool === 'select' && !layerLocked('elements') && (
              <div
                className="element-frame"
                style={{
                  left: `${elementBox.left}%`,
                  top: `${elementBox.top}%`,
                  width: `${elementBox.width}%`,
                  height: `${elementBox.height}%`,
                }}
                onPointerDown={(e) => startElementDrag(e)}
              >
                {[
                  { key: 'tl', sx: -1, sy: -1 },
                  { key: 'tr', sx: 1, sy: -1 },
                  { key: 'bl', sx: -1, sy: 1 },
                  { key: 'br', sx: 1, sy: 1 },
                ].map(({ key, sx, sy }) => (
                  <span
                    key={key}
                    className={`element-handle ${key}`}
                    onPointerDown={(e) => startElementDrag(e, [sx, sy])}
                  />
                ))}
              </div>
            )}
            {webcamBox && tool === 'select' && (
              <div
                className="element-frame"
                style={{
                  left: `${webcamBox.left}%`,
                  top: `${webcamBox.top}%`,
                  width: `${webcamBox.width}%`,
                  height: `${webcamBox.height}%`,
                }}
                onPointerDown={(e) => startWebcamDrag(e)}
                title="Drag to position the camera anywhere, or its corners to resize it"
              >
                {[
                  { key: 'tl', sx: -1, sy: -1 },
                  { key: 'tr', sx: 1, sy: -1 },
                  { key: 'bl', sx: -1, sy: 1 },
                  { key: 'br', sx: 1, sy: 1 },
                ].map(({ key, sx, sy }) => (
                  <span
                    key={key}
                    className={`element-handle ${key}`}
                    onPointerDown={(e) => startWebcamDrag(e, [sx, sy])}
                  />
                ))}
              </div>
            )}
          </div>
          <video
            ref={videoRef}
            src={videoUrl || undefined}
            hidden
            muted
            onEnded={() => setPlaying(false)}
            onLoadedMetadata={() => draw(0)}
          />
          {cameraUrl && (
            // No loop: if the two recordings differ by a beat (independent
            // MediaRecorder stop timing), holding the last frame reads better
            // than snapping back to the start mid-clip.
            <video ref={cameraRef} src={cameraUrl} hidden muted onLoadedMetadata={() => draw(time)} />
          )}
        </div>

        <aside className="inspector">
          {selectedSegment ? (
            <>
              <h3>Zoom segment</h3>
              <Slider
                label="Zoom level"
                value={selectedSegment.scale}
                min={1.1}
                max={4}
                step={0.05}
                suffix="×"
                disabled={layerLocked('zoom')}
                onChange={(v) => updateItem('zoom', selectedSegment.id, { scale: v })}
              />
              <Slider
                label="Ease in"
                value={selectedSegment.ramp ?? DEFAULT_ZOOM.ramp}
                min={0.15}
                max={1.5}
                step={0.05}
                suffix="s"
                disabled={layerLocked('zoom')}
                onChange={(v) => updateItem('zoom', selectedSegment.id, { ramp: v })}
              />
              <Slider
                label="Ease out"
                value={selectedSegment.rampOut ?? DEFAULT_ZOOM.rampOut}
                min={0.3}
                max={3}
                step={0.05}
                suffix="s"
                disabled={layerLocked('zoom')}
                onChange={(v) => updateItem('zoom', selectedSegment.id, { rampOut: v })}
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={selectedSegment.follow}
                  disabled={layerLocked('zoom')}
                  onChange={(e) => updateItem('zoom', selectedSegment.id, { follow: e.target.checked })}
                />
                Follow cursor
              </label>
              {!selectedSegment.follow && (
                <p className="hint">Anchored at {(selectedSegment.x * 100).toFixed(0)}%, {(selectedSegment.y * 100).toFixed(0)}% — click the preview to move it.</p>
              )}
              <button className="btn danger sm" disabled={layerLocked('zoom')} onClick={removeSelected}>
                Delete segment
              </button>
            </>
          ) : selectedText ? (
            <>
              <h3>Text</h3>
              <label className="field-label">
                Content
                <textarea
                  className="text-input textarea"
                  rows={2}
                  value={selectedText.text}
                  disabled={layerLocked('text')}
                  onChange={(e) => updateItem('text', selectedText.id, { text: e.target.value })}
                />
              </label>
              <Slider label="Size" value={selectedText.size} min={0.02} max={0.16} step={0.005}
                format={pct} disabled={layerLocked('text')}
                onChange={(v) => updateItem('text', selectedText.id, { size: v })} />
              <div className="row between">
                <label className="swatch-field">
                  Colour
                  <input type="color" value={selectedText.color} disabled={layerLocked('text')}
                    onChange={(e) => updateItem('text', selectedText.id, { color: e.target.value })} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={selectedText.weight >= 700} disabled={layerLocked('text')}
                    onChange={(e) => updateItem('text', selectedText.id, { weight: e.target.checked ? 700 : 400 })} />
                  Bold
                </label>
              </div>
              <div className="modes">
                {['left', 'center', 'right'].map((a) => (
                  <button key={a} className={`btn sm ${selectedText.align === a ? 'primary' : 'ghost'}`}
                    disabled={layerLocked('text')}
                    onClick={() => updateItem('text', selectedText.id, { align: a })}>
                    {a[0].toUpperCase() + a.slice(1)}
                  </button>
                ))}
              </div>
              <Slider label="X position" value={selectedText.x} min={0} max={1} step={0.01} format={pct}
                disabled={layerLocked('text')} onChange={(v) => updateItem('text', selectedText.id, { x: v })} />
              <Slider label="Y position" value={selectedText.y} min={0} max={1} step={0.01} format={pct}
                disabled={layerLocked('text')} onChange={(v) => updateItem('text', selectedText.id, { y: v })} />
              <button className="btn danger sm" disabled={layerLocked('text')} onClick={removeSelected}>
                Delete text
              </button>
            </>
          ) : selectedShape ? (
            <>
              <h3>Shape</h3>
              <div className="modes">
                {SHAPE_TYPES.map((s) => (
                  <button key={s.id} className={`btn sm ${selectedShape.type === s.id ? 'primary' : 'ghost'}`}
                    disabled={layerLocked('shapes')}
                    onClick={() => updateItem('shape', selectedShape.id, { type: s.id })}>
                    {s.label}
                  </button>
                ))}
              </div>
              <Slider label="X" value={selectedShape.x} min={-0.2} max={1.2} step={0.01} format={pct}
                disabled={layerLocked('shapes')} onChange={(v) => updateItem('shape', selectedShape.id, { x: v })} />
              <Slider label="Y" value={selectedShape.y} min={-0.2} max={1.2} step={0.01} format={pct}
                disabled={layerLocked('shapes')} onChange={(v) => updateItem('shape', selectedShape.id, { y: v })} />
              <Slider label="Width" value={selectedShape.w} min={0.02} max={1.2} step={0.01} format={pct}
                disabled={layerLocked('shapes')} onChange={(v) => updateItem('shape', selectedShape.id, { w: v })} />
              <Slider label="Height" value={selectedShape.h} min={0.02} max={1.2} step={0.01} format={pct}
                disabled={layerLocked('shapes')} onChange={(v) => updateItem('shape', selectedShape.id, { h: v })} />
              <label className="swatch-field wide">
                Colour
                <input type="color" value={selectedShape.color} disabled={layerLocked('shapes')}
                  onChange={(e) => updateItem('shape', selectedShape.id, { color: e.target.value })} />
              </label>
              <Slider label="Stroke" value={selectedShape.strokeWidth} min={1} max={24} step={1} suffix="px"
                disabled={layerLocked('shapes')} onChange={(v) => updateItem('shape', selectedShape.id, { strokeWidth: v })} />
              {selectedShape.type !== 'arrow' && (
                <label className="check">
                  <input type="checkbox" checked={!!selectedShape.fill} disabled={layerLocked('shapes')}
                    onChange={(e) => updateItem('shape', selectedShape.id, { fill: e.target.checked })} />
                  Filled
                </label>
              )}
              <button className="btn danger sm" disabled={layerLocked('shapes')} onClick={removeSelected}>
                Delete shape
              </button>
            </>
          ) : selectedElement ? (
            <>
              <h3>Element</h3>
              {selectedElement.src && <img className="bg-preview" src={selectedElement.src} alt="" />}
              <label className="btn ghost sm file">
                Replace image…
                <input type="file" accept="image/*" hidden
                  onChange={(e) => e.target.files[0] && replaceElementImage(selectedElement.id, e.target.files[0])} />
              </label>
              <p className="hint">Drag the image on the canvas to move it, or its corner handles to resize it — it can go right up to (or past) the edge, at any size.</p>
              <Slider label="Size" value={selectedElement.size} min={ELEMENT_SIZE_MIN} max={ELEMENT_SIZE_MAX} step={0.01} format={pct}
                disabled={layerLocked('elements')} onChange={(v) => updateItem('element', selectedElement.id, { size: v })} />
              <Slider label="Opacity" value={selectedElement.opacity ?? 1} min={0} max={1} step={0.05} format={pct}
                disabled={layerLocked('elements')} onChange={(v) => updateItem('element', selectedElement.id, { opacity: v })} />
              <Slider label="X position" value={selectedElement.x} min={-1} max={2} step={0.01} format={pct}
                disabled={layerLocked('elements')} onChange={(v) => updateItem('element', selectedElement.id, { x: v })} />
              <Slider label="Y position" value={selectedElement.y} min={-1} max={2} step={0.01} format={pct}
                disabled={layerLocked('elements')} onChange={(v) => updateItem('element', selectedElement.id, { y: v })} />
              <button className="btn danger sm" disabled={layerLocked('elements')} onClick={removeSelected}>
                Delete element
              </button>
            </>
          ) : selectedVideoClip ? (
            <>
              <h3>Recording clip</h3>
              <p className="hint">
                Plays {fmtTime(selectedVideoClip.start)}–{fmtTime(selectedVideoClip.end)} on the timeline, showing{' '}
                {fmtTime(selectedVideoClip.sourceStart)}–{fmtTime(selectedVideoClip.sourceEnd)} of the original recording.
              </p>
              <p className="hint">Drag its edges to trim, drag its body to move it, or use Split/Delete below.</p>
              <button className="btn danger sm" onClick={removeSelected}>
                Delete clip
              </button>
            </>
          ) : selectedCameraClip ? (
            <>
              <h3>Camera clip</h3>
              <p className="hint">
                Plays {fmtTime(selectedCameraClip.start)}–{fmtTime(selectedCameraClip.end)} on the timeline, showing{' '}
                {fmtTime(selectedCameraClip.sourceStart)}–{fmtTime(selectedCameraClip.sourceEnd)} of the camera recording.
              </p>
              <p className="hint">Drag its edges to trim, drag its body to move it, or use Split/Delete below.</p>
              <button className="btn danger sm" onClick={removeSelected}>
                Delete clip
              </button>
            </>
          ) : (
            <>
              <h3>{selectedClip ? 'Background clip' : 'Background'}</h3>

              <div className="modes">
                {BG_MODES.map((m) => (
                  <button
                    key={m.id}
                    className={`btn sm ${activeBg.type === m.id ? 'primary' : 'ghost'}`}
                    disabled={layerLocked('background')}
                    onClick={() => setActiveBg(defaultBg(m.id, activeBg))}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              {activeBg.type === 'gradient' && (
                <>
                  <div className="subsection">
                    <h4>Presets</h4>
                    <div className="swatches">
                      {Object.entries(GRADIENTS).map(([name, [a, b]]) => (
                        <button
                          key={name}
                          className={`swatch ${gradientStops(activeBg).join() === [a, b].join() ? 'active' : ''}`}
                          style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}
                          title={name}
                          disabled={layerLocked('background')}
                          onClick={() => setActiveBg({ ...activeBg, type: 'gradient', preset: name, from: a, to: b })}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="row between">
                    <label className="swatch-field">
                      From
                      <input
                        type="color"
                        value={gradientStops(activeBg)[0]}
                        disabled={layerLocked('background')}
                        onChange={(e) => setActiveBg({ ...activeBg, preset: null, from: e.target.value, to: gradientStops(activeBg)[1] })}
                      />
                    </label>
                    <label className="swatch-field">
                      To
                      <input
                        type="color"
                        value={gradientStops(activeBg)[1]}
                        disabled={layerLocked('background')}
                        onChange={(e) => setActiveBg({ ...activeBg, preset: null, from: gradientStops(activeBg)[0], to: e.target.value })}
                      />
                    </label>
                  </div>
                  <Slider
                    label="Angle"
                    value={activeBg.angle ?? 135}
                    min={0}
                    max={360}
                    step={5}
                    suffix="°"
                    disabled={layerLocked('background')}
                    onChange={(v) => setActiveBg({ ...activeBg, angle: v })}
                  />
                </>
              )}

              {activeBg.type === 'solid' && (
                <label className="swatch-field wide">
                  Colour
                  <input
                    type="color"
                    value={activeBg.color || '#101014'}
                    disabled={layerLocked('background')}
                    onChange={(e) => setActiveBg({ ...activeBg, color: e.target.value })}
                  />
                </label>
              )}

              {activeBg.type === 'image' && (
                <>
                  {activeBg.src && <img className="bg-preview" src={activeBg.src} alt="" />}
                  <div className="row">
                    <label className="btn ghost sm file">
                      {activeBg.src ? 'Replace…' : 'Choose image…'}
                      <input
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={(e) => e.target.files[0] && pickImage(e.target.files[0])}
                      />
                    </label>
                    <button
                      className={`btn sm ${activeBg.fit !== 'contain' ? 'primary' : 'ghost'}`}
                      disabled={layerLocked('background')}
                      onClick={() => setActiveBg({ ...activeBg, fit: 'cover' })}
                    >
                      Cover
                    </button>
                    <button
                      className={`btn sm ${activeBg.fit === 'contain' ? 'primary' : 'ghost'}`}
                      disabled={layerLocked('background')}
                      onClick={() => setActiveBg({ ...activeBg, fit: 'contain' })}
                    >
                      Contain
                    </button>
                  </div>
                  {activeBg.fit === 'contain' && (
                    <label className="swatch-field wide">
                      Letterbox
                      <input
                        type="color"
                        value={activeBg.color || '#101014'}
                        disabled={layerLocked('background')}
                        onChange={(e) => setActiveBg({ ...activeBg, color: e.target.value })}
                      />
                    </label>
                  )}
                </>
              )}

              {activeBg.type === 'none' && (
                <p className="hint">
                  Transparent. Keep the alpha channel by exporting as{' '}
                  {formats.filter((f) => f.alpha).map((f) => f.label).join(' or ') || 'an alpha format'} —
                  MP4 and WebM have no alpha and would flatten it to black.
                </p>
              )}

              {selectedClip && (
                <div ref={transitionSectionRef} className="subsection">
                  <hr />
                  <h4>Transition</h4>
                  <Slider label="Fade in" value={selectedClip.fadeIn ?? 0} min={0} max={2} step={0.05} suffix="s"
                    disabled={layerLocked('background')} onChange={(v) => updateItem('bg', selectedClip.id, { fadeIn: v })} />
                  <Slider label="Fade out" value={selectedClip.fadeOut ?? 0} min={0} max={2} step={0.05} suffix="s"
                    disabled={layerLocked('background')} onChange={(v) => updateItem('bg', selectedClip.id, { fadeOut: v })} />
                  <button className="btn danger sm" disabled={layerLocked('background')} onClick={removeSelected}>
                    Delete clip
                  </button>
                </div>
              )}
            </>
          )}

          <hr />
          <h3>Frame</h3>
          <Slider label="Padding" value={project.padding} min={0} max={0.2} step={0.005}
            format={(v) => `${(v * 100).toFixed(1)}%`} onChange={(v) => patch({ padding: v })} />
          <Slider label="Corner radius" value={project.radius} min={0} max={40} step={1}
            onChange={(v) => patch({ radius: v })} />
          <Slider label="Shadow" value={project.shadow} min={0} max={1} step={0.05}
            onChange={(v) => patch({ shadow: v })} />
          <label className="check">
            <input
              type="checkbox"
              checked={project.clickHighlight}
              onChange={(e) => patch({ clickHighlight: e.target.checked })}
            />
            Click highlights
          </label>

          <hr />
          <div ref={cursorSectionRef} className="subsection">
            <h3>Cursor</h3>
            <label className="check">
              <input
                type="checkbox"
                checked={project.showCursor}
                onChange={(e) => patch({ showCursor: e.target.checked })}
              />
              Draw smoothed cursor
            </label>
            {project.showCursor && (
              <>
                <Slider
                  label="Smoothing"
                  value={project.cursorSmoothing}
                  min={0}
                  max={1}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => patch({ cursorSmoothing: v })}
                />
                <Slider
                  label="Size"
                  value={project.cursorSize}
                  min={0.5}
                  max={2.5}
                  step={0.1}
                  suffix="x"
                  onChange={(v) => patch({ cursorSize: v })}
                />
                {project.cursorImage && (
                  <>
                    <div
                      className="cursor-hotspot-preview"
                      title="Click where the cursor's own tip is"
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect()
                        patch({
                          cursorHotspot: {
                            x: clamp01((e.clientX - r.left) / r.width),
                            y: clamp01((e.clientY - r.top) / r.height),
                          },
                        })
                      }}
                    >
                      <img src={project.cursorImage} alt="" />
                      <span
                        className="cursor-hotspot-marker"
                        style={{
                          left: `${(project.cursorHotspot?.x ?? 0) * 100}%`,
                          top: `${(project.cursorHotspot?.y ?? 0) * 100}%`,
                        }}
                      />
                    </div>
                    <p className="hint">
                      Click the preview to mark the cursor's exact tip — that's the point that lands on the
                      recorded position, not the image's corner.
                    </p>
                  </>
                )}
                <div className="row">
                  <label className="btn ghost sm file">
                    {project.cursorImage ? 'Replace cursor image…' : 'Upload cursor image…'}
                    <input
                      type="file"
                      accept="image/*"
                      hidden
                      onChange={(e) => {
                        // A new image's tip is somewhere new too — the old hotspot fraction
                        // would just be pointing at an arbitrary spot on unrelated art.
                        if (e.target.files[0]) {
                          readImage(e.target.files[0], (src) => patch({ cursorImage: src, cursorHotspot: { x: 0, y: 0 } }))
                        }
                        e.target.value = ''
                      }}
                    />
                  </label>
                  {project.cursorImage && (
                    <button className="btn ghost sm" onClick={() => patch({ cursorImage: null, cursorHotspot: { x: 0, y: 0 } })}>
                      Use default
                    </button>
                  )}
                </div>
                {project.cursorImage && (
                  <button
                    className="btn ghost sm"
                    title="Every new recording starts with this cursor instead of the built-in arrow"
                    onClick={() => {
                      saveDefaultCursor(project.cursorImage, project.cursorHotspot ?? { x: 0, y: 0 })
                      setStatus({ kind: 'ok', message: 'Saved as your default cursor for new recordings.' })
                      clearTimeout(hintTimerRef.current)
                      hintTimerRef.current = setTimeout(() => setStatus((s) => (s?.kind === 'ok' ? null : s)), 2200)
                    }}
                  >
                    Set as default cursor
                  </button>
                )}
              </>
            )}
            {!track.source?.cursorHidden && project.showCursor && (
              <p className="hint">
                This take was recorded before capture always excluded the system cursor, so you'll
                see two pointers here. Re-record it for a single clean one — every new recording
                leaves the OS cursor out automatically now.
              </p>
            )}
          </div>

          {cameraPath && (
            <>
              <hr />
              <h3>Camera</h3>
              <label className="check">
                <input
                  type="checkbox"
                  checked={project.webcam.enabled}
                  onChange={(e) => patchWebcam({ enabled: e.target.checked })}
                />
                Show camera
              </label>

              {project.webcam.enabled && (
                <>
                  <div className="modes">
                    {WEBCAM_SHAPES.map((s) => (
                      <button
                        key={s.id}
                        className={`btn sm ${project.webcam.shape === s.id ? 'primary' : 'ghost'}`}
                        onClick={() => patchWebcam({ shape: s.id })}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>

                  <div className="row between">
                    <div className="corner-pick">
                      {WEBCAM_CORNERS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={`corner-btn ${c.replace('-', ' ')} ${!project.webcam.position && project.webcam.corner === c ? 'active' : ''}`}
                          title={c.replace('-', ' ')}
                          aria-label={`Dock camera to ${c.replace('-', ' ')}`}
                          onClick={() => patchWebcam({ corner: c, position: null })}
                        />
                      ))}
                    </div>
                    {project.webcam.position ? (
                      <button className="btn ghost sm" onClick={() => patchWebcam({ position: null })}>
                        Reset position
                      </button>
                    ) : (
                      <p className="hint">Drag the preview on the canvas for a custom spot</p>
                    )}
                  </div>

                  <Slider
                    label="Size"
                    value={project.webcam.size}
                    min={0.12}
                    max={0.45}
                    step={0.01}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onChange={(v) => patchWebcam({ size: v })}
                  />
                  {!project.webcam.position && (
                    <Slider
                      label="Margin"
                      value={project.webcam.margin}
                      min={0}
                      max={0.12}
                      step={0.005}
                      format={(v) => `${Math.round(v * 100)}%`}
                      onChange={(v) => patchWebcam({ margin: v })}
                    />
                  )}
                  {project.webcam.shape === 'square' && (
                    <Slider
                      label="Corner radius"
                      value={project.webcam.radius}
                      min={0}
                      max={80}
                      step={1}
                      onChange={(v) => patchWebcam({ radius: v })}
                    />
                  )}
                  <Slider
                    label="Stroke"
                    value={project.webcam.strokeWidth}
                    min={0}
                    max={16}
                    step={1}
                    suffix="px"
                    onChange={(v) => patchWebcam({ strokeWidth: v })}
                  />
                  {project.webcam.strokeWidth > 0 && (
                    <label className="swatch-field wide">
                      Stroke colour
                      <input
                        type="color"
                        value={project.webcam.strokeColor}
                        onChange={(e) => patchWebcam({ strokeColor: e.target.value })}
                      />
                    </label>
                  )}
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={project.webcam.mirror}
                      onChange={(e) => patchWebcam({ mirror: e.target.checked })}
                    />
                    Mirror
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={project.webcam.animate}
                      onChange={(e) => patchWebcam({ animate: e.target.checked })}
                    />
                    Animate position changes
                  </label>
                </>
              )}
            </>
          )}
        </aside>
      </div>

      <div className="controls">
        <button className="btn icon round" onClick={togglePlay}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="time">
          {time.toFixed(2)}s / {duration.toFixed(2)}s
        </span>
        <div className="row preview-tools">
          <div className="modes click-zoom-mode" title="How a Zoom segment fills the frame while it's zoomed in">
            <button
              type="button"
              className={`btn sm ${project.frameFillOnZoom ? 'primary' : 'ghost'}`}
              onClick={() => patch({ frameFillOnZoom: true })}
              title="A Zoom segment bleeds past the padded/rounded frame to fill the whole canvas as it zooms in — recording and export both, not just the preview"
            >
              Frame
            </button>
            <button
              type="button"
              className={`btn sm ${!project.frameFillOnZoom ? 'primary' : 'ghost'}`}
              onClick={() => patch({ frameFillOnZoom: false })}
              title="Default — a Zoom segment always stays inside the frame exactly as the Padding/Corner radius/Shadow controls set it"
            >
              Video
            </button>
          </div>
          <select
            className="select pill"
            value={previewZoom ?? 'fit'}
            onChange={(e) => setPreviewZoom(e.target.value === 'fit' ? null : Number(e.target.value))}
            title="Preview zoom"
          >
            <option value="fit">Fit</option>
            <option value="50">50%</option>
            <option value="100">100%</option>
            <option value="150">150%</option>
            <option value="200">200%</option>
            <option value="400">400%</option>
          </select>
          <input
            type="range"
            className="zoom-slider"
            min={25}
            max={400}
            step={5}
            // The slider always reflects the *live* scale (Fit's own current
            // percentage when nothing's been picked, not a frozen 100) — so
            // it starts wherever "Fit" actually landed instead of visibly
            // jumping the moment you nudge it.
            value={Math.round(previewScale * 100)}
            onChange={(e) => setPreviewZoom(Number(e.target.value))}
            title="Preview zoom"
          />
          {/* A live number, not just the preset dropdown above — that only
              has 5 fixed stops, so any value reached via the slider (or via
              Fit, which is rarely an exact preset) would leave it showing
              blank instead of the actual percentage. */}
          <span className="zoom-readout mono">{Math.round(previewScale * 100)}%</span>
          <button className="btn ghost icon" onClick={toggleFullscreen} title="Fullscreen">
            <Icon name="fullscreen" />
          </button>
        </div>
      </div>

      <div className="timeline-toolbar">
        <div className="row">
          <select
            className="select pill"
            value=""
            onChange={(e) => {
              runAddTrack(e.target.value)
              e.target.value = ''
            }}
            title="Add a new track"
          >
            <option value="" disabled>+ Add track</option>
            <option value="zoom">Zoom segment</option>
            <option value="background">Background clip</option>
            <option value="text">Text</option>
            <option value="shapes">Shape</option>
            <option value="elements">Element (image)…</option>
          </select>
          <button className="btn ghost sm" disabled={!selected} onClick={splitSelected}>Split</button>
          <button className="btn ghost sm" disabled={!selected} onClick={removeSelected}>Delete</button>
        </div>
        <div className="row">
          <button className="btn ghost sm icon" title="Zoom out (or Alt+scroll down on the timeline)" onClick={() => setTimelineZoom((z) => Math.max(1, z / 1.5))}>−</button>
          <button className="btn ghost sm" title="Back to the default timescale" onClick={() => setTimelineZoom(1)}>Reset zoom</button>
          <button className="btn ghost sm icon" title="Zoom in (or Alt+scroll up on the timeline)" onClick={() => setTimelineZoom((z) => Math.min(8, z * 1.5))}>+</button>
          <button className="btn ghost sm" onClick={addBackgroundClip}>+ Background</button>
          <button className="btn ghost sm" onClick={regenerate}>Re-detect clicks</button>
        </div>
      </div>

      <div
        className="timeline-resizer"
        onPointerDown={startTimelineResize}
        title="Drag to resize the timeline"
      />
      <Timeline
        duration={duration}
        time={time}
        clicks={path.clicks}
        segments={project.segments}
        videoClips={project.videoClips}
        videoThumbs={videoThumbs}
        cameraThumbs={cameraThumbs}
        cameraClips={project.cameraClips}
        backgroundClips={project.backgroundClips}
        texts={project.texts}
        shapes={project.shapes}
        elements={project.elements}
        waveform={waveform}
        hasAudio={!!track.source?.mic}
        hasCamera={!!cameraPath}
        selected={selected}
        onSelect={(sel) => { setSelected(sel); setTool('select') }}
        onChange={updateItem}
        onSeek={seek}
        height={timelineHeight}
        zoom={timelineZoom}
        onZoomChange={setTimelineZoom}
        locked={(kind) => layerLocked(KIND_TO_LAYER[kind])}
        layers={{ ...layers, camera: { visible: !!project.webcam.enabled } }}
        onToggleLayer={toggleLayer}
        onDragStart={beginHistoryBatch}
        onDragEnd={endHistoryBatch}
      />
    </div>
    </HistoryBatchContext.Provider>
  )
}

function Slider({ label, value, min, max, step, onChange, suffix = '', format, disabled }) {
  // A drag fires onChange dozens of times — batched into one undo step (see
  // beginHistoryBatch/endHistoryBatch in Editor.jsx) instead of one per tick.
  // A native range input keeps implicit pointer capture for the whole drag,
  // so pointerup reliably fires here even if the cursor drifts off the
  // track — no window-level listener needed, unlike the custom drags
  // elsewhere in this file.
  const { beginHistoryBatch, endHistoryBatch } = useContext(HistoryBatchContext)
  // Drives the CSS fill gradient below — with the track fully custom-styled
  // (appearance: none), the browser no longer paints a filled portion on its
  // own the way it does for a native/auto-appearance slider (that's what
  // accent-color relied on), so the position of the boundary between "filled"
  // and "unfilled" has to be computed here instead.
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <label className={`slider ${disabled ? 'disabled' : ''}`}>
      <span>
        {label}
        <em>{format ? format(value) : value.toFixed(2) + suffix}</em>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={{ '--pct': `${pct}%` }}
        onPointerDown={beginHistoryBatch}
        onPointerUp={endHistoryBatch}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  )
}

const ICON_COMMON = {
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
}

function Icon({ name }) {
  switch (name) {
    case 'back':
      return <svg {...ICON_COMMON}><path d="M15 5l-7 7 7 7" /></svg>
    case 'select':
      return <svg {...ICON_COMMON}><path d="M5 3l6.5 16 2-6.5L20 10.5 5 3z" fill="currentColor" stroke="none" /></svg>
    case 'zoom':
      return <svg {...ICON_COMMON}><circle cx="10.5" cy="10.5" r="6.5" /><path d="M21 21l-4.3-4.3" /></svg>
    case 'background':
      return <svg {...ICON_COMMON}><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M3 15l5-5 4 4 5-6 4 5" /></svg>
    case 'pointer':
      return <svg {...ICON_COMMON}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
    case 'text':
      return <svg {...ICON_COMMON}><path d="M5 5h14M12 5v14" /></svg>
    case 'shapes':
      return <svg {...ICON_COMMON}><rect x="3" y="10" width="9" height="9" rx="1.5" /><circle cx="16.5" cy="7.5" r="4.5" /></svg>
    case 'elements':
      return <svg {...ICON_COMMON}><path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3z" fill="currentColor" stroke="none" /></svg>
    case 'transitions':
      return <svg {...ICON_COMMON}><path d="M4 8h13M13 4l4 4-4 4" /><path d="M20 16H7M11 12l-4 4 4 4" /></svg>
    case 'undo':
      return <svg {...ICON_COMMON}><path d="M8 7L4 11l4 4" /><path d="M4 11h10a6 6 0 010 12h-2" /></svg>
    case 'redo':
      return <svg {...ICON_COMMON}><path d="M16 7l4 4-4 4" /><path d="M20 11H10a6 6 0 000 12h2" /></svg>
    case 'fullscreen':
      return <svg {...ICON_COMMON}><path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M8 21H5a2 2 0 01-2-2v-3M16 21h3a2 2 0 002-2v-3" /></svg>
    case 'export':
      return <svg {...ICON_COMMON}><path d="M12 3v12M7 8l5-5 5 5" /><path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" /></svg>
    default:
      return null
  }
}
