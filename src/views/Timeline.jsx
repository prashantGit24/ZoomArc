import { useEffect, useRef, useState } from 'react'
import { useTheme } from '../theme.js'

const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`

// A fixed timescale, like any real NLE's timeline — the ruler/lanes are
// this many pixels per second (times the zoom multiplier), not a fraction
// of however wide the window happens to be. A short take still fills the
// visible width (.timeline-inner's own min-width:100% in styles.css
// handles that), but a longer one properly runs wider than the window and
// scrolls, instead of every clip being squeezed to fit on screen at once.
const PX_PER_SEC = 30

/**
 * Draws a fixed-length peaks array into whatever box the canvas currently
 * occupies — a ResizeObserver redraws it when the lane (or the whole
 * timeline, via the height drag handle or the horizontal zoom) changes size,
 * so the waveform never has to be recomputed, only rescaled.
 */
function Waveform({ peaks }) {
  const canvasRef = useRef(null)
  // Canvas fill can't read a CSS var, so the waveform picks its own colour
  // straight off the theme instead — white bars on the (now themed)
  // .lane.audio backing in dark mode, ink bars in light mode. Re-runs the
  // draw effect on a toggle even though nothing resized.
  const [theme] = useTheme()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect()
      if (!width || !height) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      if (!peaks || !peaks.length) return

      const mid = height / 2
      const barW = width / peaks.length
      ctx.fillStyle = theme === 'light' ? 'rgba(16,16,20,0.55)' : 'rgba(255,255,255,0.55)'
      for (let i = 0; i < peaks.length; i++) {
        const [lo, hi] = peaks[i]
        const y1 = mid - hi * (mid - 2)
        const y2 = mid - lo * (mid - 2)
        ctx.fillRect(i * barW, y1, Math.max(1, barW - 0.4), Math.max(1, y2 - y1))
      }
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [peaks, theme])

  return <canvas className="waveform" ref={canvasRef} />
}

/**
 * The filmstrip inside a Video/Camera block: `thumbs` covers the *whole*
 * original recording, so this picks whichever frames fall within this
 * particular clip's current [sourceStart, sourceEnd) window — however it's
 * been trimmed or split — and tiles them, cover-cropped, across the box.
 * Same draw-on-resize pattern as Waveform above.
 */
function Filmstrip({ thumbs, sourceStart, sourceEnd }) {
  const canvasRef = useRef(null)
  const imagesRef = useRef(new Map())

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect()
      if (!width || !height) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      if (!thumbs?.length) return

      const span = Math.max(0.01, sourceEnd - sourceStart)
      const slots = Math.max(1, Math.min(24, Math.round(width / 46)))
      const slotW = width / slots

      for (let i = 0; i < slots; i++) {
        const wanted = sourceStart + ((i + 0.5) / slots) * span
        let nearest = thumbs[0]
        let best = Infinity
        for (const th of thumbs) {
          const d = Math.abs(th.t - wanted)
          if (d < best) {
            best = d
            nearest = th
          }
        }

        let img = imagesRef.current.get(nearest.src)
        if (!img) {
          img = new Image()
          img.onload = draw // this slot's frame wasn't decoded yet — redraw once it is
          img.src = nearest.src
          imagesRef.current.set(nearest.src, img)
        }
        if (!img.complete || !img.naturalWidth) continue

        // Cover-fit crop into the slot, so a portrait/ultrawide recording
        // still fills each tile rather than leaving bars.
        const scale = Math.max(slotW / img.naturalWidth, height / img.naturalHeight)
        const dw = img.naturalWidth * scale
        const dh = img.naturalHeight * scale
        ctx.drawImage(img, i * slotW - (dw - slotW) / 2, (height - dh) / 2, dw, dh)
      }
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [thumbs, sourceStart, sourceEnd])

  return <canvas className="filmstrip" ref={canvasRef} />
}

function EyeIcon({ off }) {
  return off ? (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A10.9 10.9 0 0112 5c6 0 9.5 6 9.9 7a13.6 13.6 0 01-3 3.9M6.2 6.2C3.6 7.9 2.1 10.6 2.1 11c0 1 3.5 7 9.9 7 1 0 2-.2 2.9-.5" />
      <path d="M9.9 9.9a3 3 0 004.2 4.2" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.1 12S5.6 5 12 5s9.9 7 9.9 7-3.5 7-9.9 7-9.9-7-9.9-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function LockIcon({ locked }) {
  return locked ? (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 018 0v4" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 017.5-2" />
    </svg>
  )
}

// The little "this clip is a linked source" glyph on a Video/Camera block's
// caption bar — purely decorative here (there's nothing to actually link),
// matching the convention every NLE uses when naming a clip after its source.
function LinkIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 15l6-6" />
      <path d="M11 5l1-1a4 4 0 015.5 5.8L16 11" />
      <path d="M13 19l-1 1a4 4 0 01-5.5-5.8L8 13" />
    </svg>
  )
}

/**
 * One row in the fixed left column — a track header, the way an NLE's
 * timeline separates "which track is this" from the scrollable clip area,
 * rather than overlaying the name on the clips themselves. Its height is
 * matched to the corresponding .lane purely by both being flex:1 siblings
 * in same-length, same-order lists (see laneDefs below) — no pixel math.
 */
function LaneLabel({ label, badge, color, layerKey, layers, onToggleLayer, lockable = true }) {
  const state = layers?.[layerKey] || {}
  const hidden = state.visible === false
  const isLocked = !!state.locked
  return (
    <div className={`lane-label ${hidden ? 'dim' : ''}`} style={{ '--lane-color': color }}>
      <span className="lane-badge">{badge}</span>
      <span className="lane-label-name">{label}</span>
      <div className="lane-label-actions">
        <button
          type="button"
          className="lane-icon-btn"
          title={hidden ? 'Show layer' : 'Hide layer'}
          onClick={() => onToggleLayer(layerKey, 'visible')}
        >
          <EyeIcon off={hidden} />
        </button>
        {lockable && (
          <button
            type="button"
            className="lane-icon-btn"
            title={isLocked ? 'Unlock layer' : 'Lock layer'}
            onClick={() => onToggleLayer(layerKey, 'locked')}
          >
            <LockIcon locked={isLocked} />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Lanes over a shared time axis — the recording itself (Video/Camera),
 * zoom segments, background clips, and (once something's been placed)
 * text/shapes/elements/audio. Blocks can be dragged to move and grabbed by
 * either edge to resize (which, for Video/Camera, trims the in/out point it
 * plays from the source recording rather than just repositioning it),
 * unless their layer is locked, in which case they can still be selected
 * but not touched.
 *
 * Layout is two columns: a fixed, non-scrolling .timeline-labels rail (the
 * track headers) beside the horizontally-scrollable/zoomable clip area —
 * the same split a video editor's timeline always has, rather than naming
 * each lane on top of its own clips.
 */
export default function Timeline({
  duration,
  time,
  clicks,
  segments,
  videoClips,
  cameraClips,
  videoThumbs,
  cameraThumbs,
  backgroundClips,
  texts,
  shapes,
  elements,
  waveform,
  hasAudio,
  hasCamera,
  selected,
  onSelect,
  onChange,
  onSeek,
  height,
  zoom = 1,
  onZoomChange,
  locked,
  layers,
  onToggleLayer,
  onDragStart,
  onDragEnd,
}) {
  const trackRef = useRef(null)
  const scrollRef = useRef(null)
  const pct = (t) => `${(t / Math.max(duration, 0.001)) * 100}%`
  const isLocked = (kind) => !!locked?.(kind)
  // Time position of the guide line flashed while a drag is actively
  // snapped to something (a neighbour's edge, the playhead, or 0/duration)
  // — null the rest of the time, so snapping is felt as a real "click into
  // place" instead of a silent, unverifiable adjustment.
  const [snapGuide, setSnapGuide] = useState(null)

  // Drives both the label column and the lane column, in lockstep — same
  // entries, same order — so row N always lines up with lane N. Track order
  // bottom-to-top: Background, Video, Zoom, Element, Text, Shape — so
  // top-to-bottom (the order this array is actually in) is Shapes, Text,
  // Elements, Zoom, Video, Background, then Camera/Audio (when this take has
  // them) trailing below Background. Video/Camera/Audio aren't lockable
  // (there's nothing else that would touch them), but are otherwise
  // ordinary trimmable/draggable clips.
  const laneDefs = [
    shapes?.length > 0 && { key: 'shapes', label: 'Shapes', badge: 'SH', color: '#ec4899' },
    texts?.length > 0 && { key: 'text', label: 'Text', badge: 'TX', color: '#f59e0b' },
    elements?.length > 0 && { key: 'elements', label: 'Elements', badge: 'EL', color: '#38bdf8' },
    { key: 'zoom', label: 'Zoom', badge: 'ZM', color: '#7c5cfa' },
    { key: 'video', label: 'Video', badge: 'VD', color: '#60a5fa', lockable: false },
    { key: 'background', label: 'Background', badge: 'BG', color: '#0d9488' },
    hasCamera && { key: 'camera', label: 'Camera', badge: 'CM', color: '#f472b6', lockable: false },
    hasAudio && { key: 'audio', label: 'Audio', badge: 'AU', color: '#94a3b8', lockable: false },
  ].filter(Boolean)

  const timeFromEvent = (e) => {
    const box = trackRef.current.getBoundingClientRect()
    return Math.max(0, Math.min(duration, ((e.clientX - box.left) / box.width) * duration))
  }

  // Alt+scroll zooms the timeline horizontally — up to zoom in, down to zoom
  // out — the same modifier every NLE uses for this. Left as a plain scroll
  // (no preventDefault, nothing intercepted) when Alt isn't held.
  function onWheelZoom(e) {
    if (!e.altKey || !onZoomChange) return
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    onZoomChange((z) => Math.max(1, Math.min(8, z * factor)))
  }

  // Keeps the playhead centred in the visible window whenever the zoom level
  // changes — from the wheel above or the toolbar's +/−/Reset buttons alike —
  // so zooming always feels anchored on "where the playhead already is"
  // instead of leaving the view wherever it happened to be scrolled to.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const playheadPx = time * PX_PER_SEC * zoom
    el.scrollLeft = Math.max(0, playheadPx - el.clientWidth / 2)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-centres on
    // a zoom change only; `time` is deliberately excluded so scrubbing
    // doesn't fight the user's own manual scrolling the rest of the time.
  }, [zoom])

  // Scrubbing: seeks immediately on press, then keeps following the pointer
  // until release — used by the ruler, the lane background, and the playhead
  // itself (line + handle), so all of them are draggable the same way.
  function startScrub(e) {
    e.stopPropagation()
    e.preventDefault()
    onSeek(timeFromEvent(e))
    const move = (ev) => onSeek(timeFromEvent(ev))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // On-screen pixels within which a dragged edge snaps to a nearby clip edge,
  // the playhead, or the timeline's own start/end — converted to a time
  // distance via the current px/sec so it feels the same at any zoom level.
  const SNAP_PX = 8
  const snapThreshold = SNAP_PX / (PX_PER_SEC * zoom)

  function startDrag(e, item, kind, mode, siblings = []) {
    e.stopPropagation()
    e.preventDefault()
    onSelect({ kind, id: item.id })
    if (isLocked(kind)) return // selectable, but not draggable, while its layer is locked
    onDragStart?.() // one undo step for the whole drag, not one per pointermove

    const origin = timeFromEvent(e)
    const start0 = item.start
    const end0 = item.end
    const MIN = 0.3

    // Collision bounds: whichever clip in this same track sits immediately
    // before/after this one *at drag start* — found once, not re-derived
    // live, since a clip can't hop over a neighbour it's continuously
    // clamped against anyway. This is what keeps clips in one track from
    // ever overlapping, for every kind (zoom/background/text/shape/element/
    // video/camera alike), not just the zoom-segment merge that already
    // existed.
    const others = siblings.filter((s) => s.id !== item.id)
    const leftNeighbor = others.filter((s) => s.end <= start0).sort((a, b) => b.end - a.end)[0]
    const rightNeighbor = others.filter((s) => s.start >= end0).sort((a, b) => a.start - b.start)[0]
    const leftBound = leftNeighbor ? leftNeighbor.end : 0
    const rightBound = rightNeighbor ? rightNeighbor.start : duration

    const snap = (value, candidates) => {
      let best = value
      let bestDist = snapThreshold
      for (const c of candidates) {
        const d = Math.abs(value - c)
        if (d < bestDist) {
          bestDist = d
          best = c
        }
      }
      return best
    }

    const move = (ev) => {
      const delta = timeFromEvent(ev) - origin
      let start = start0
      let end = end0
      let guide = null
      if (mode === 'move') {
        const width = end0 - start0
        start = Math.max(leftBound, Math.min(rightBound - width, start0 + delta))
        const snappedStart = snap(start, [leftBound, 0, time])
        if (snappedStart !== start) {
          start = snappedStart
          guide = start
        } else {
          const snappedEnd = snap(start + width, [rightBound, duration, time])
          if (snappedEnd !== start + width) {
            start = snappedEnd - width
            guide = snappedEnd
          }
        }
        end = start + width
      } else if (mode === 'left') {
        const raw = Math.max(leftBound, Math.min(end0 - MIN, start0 + delta))
        start = snap(raw, [leftBound, 0, time])
        if (start !== raw) guide = start
      } else {
        const raw = Math.min(rightBound, Math.max(start0 + MIN, end0 + delta))
        end = snap(raw, [rightBound, duration, time])
        if (end !== raw) guide = end
      }
      setSnapGuide(guide)
      onChange(kind, item.id, { start, end })
    }
    const up = () => {
      setSnapGuide(null)
      onDragEnd?.()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // `siblings` is every item in this same track (self included) — passed
  // straight to startDrag so it can find this item's neighbours and enforce
  // no-overlap/snapping without needing its own copy of the project state.
  const block = (item, kind, label, siblings) => {
    const isMedia = kind === 'video' || kind === 'camera'
    return (
      <div
        key={item.id}
        className={`block ${kind} ${selected?.id === item.id ? 'sel' : ''} ${isLocked(kind) ? 'locked' : ''}`}
        style={{ left: pct(item.start), width: pct(item.end - item.start) }}
        onPointerDown={(e) => startDrag(e, item, kind, 'move', siblings)}
        title={`${fmt(item.start)} → ${fmt(item.end)}`}
      >
        {isMedia && (
          <Filmstrip
            thumbs={kind === 'video' ? videoThumbs : cameraThumbs}
            sourceStart={item.sourceStart}
            sourceEnd={item.sourceEnd}
          />
        )}
        <span className="handle l" onPointerDown={(e) => startDrag(e, item, kind, 'left', siblings)} />
        {isMedia ? (
          // A solid caption bar pinned to the bottom, not centred text over
          // the filmstrip — same convention as naming a clip in any NLE.
          <div className="block-caption">
            <LinkIcon />
            <span>{label}</span>
          </div>
        ) : (
          <span className="label">{label}</span>
        )}
        <span className="handle r" onPointerDown={(e) => startDrag(e, item, kind, 'right', siblings)} />
      </div>
    )
  }

  function laneBody(key) {
    switch (key) {
      case 'camera':
        return cameraClips.map((c) => block(c, 'camera', 'Camera', cameraClips))
      case 'video':
        return videoClips.map((c) => block(c, 'video', 'Recording', videoClips))
      case 'zoom':
        return (
          <>
            {clicks.map((c, i) => (
              <span key={i} className="click" style={{ left: pct(c.t) }} title={`click @ ${fmt(c.t)}`} />
            ))}
            {segments.map((s) => block(s, 'zoom', `${s.scale.toFixed(1)}×${s.follow ? ' follow' : ''}`, segments))}
          </>
        )
      case 'background':
        return backgroundClips.map((c) => block(c, 'bg', c.bg.type === 'gradient' ? c.bg.preset : c.bg.type, backgroundClips))
      case 'text':
        return texts.map((it) => block(it, 'text', it.text?.slice(0, 24) || 'Text', texts))
      case 'shapes':
        return shapes.map((it) => block(it, 'shape', it.type, shapes))
      case 'elements':
        return elements.map((it) => block(it, 'element', 'Image', elements))
      case 'audio':
        return <Waveform peaks={waveform} />
      default:
        return null
    }
  }

  return (
    <div className="timeline" style={height ? { height } : undefined}>
      <div className="timeline-body">
        <div className="timeline-labels">
          <div className="ruler-spacer" />
          <div className="lane-labels">
            {laneDefs.map((d) => (
              <LaneLabel
                key={d.key}
                label={d.label}
                badge={d.badge}
                color={d.color}
                layerKey={d.key}
                layers={layers}
                onToggleLayer={onToggleLayer}
                lockable={d.lockable !== false}
              />
            ))}
          </div>
        </div>

        <div className="timeline-scroll" ref={scrollRef} onWheel={onWheelZoom}>
          <div className="timeline-inner" style={{ width: `${duration * PX_PER_SEC * zoom}px` }}>
            <div className="ruler" onPointerDown={startScrub}>
              {Array.from({ length: Math.ceil(duration) + 1 }, (_, i) => (
                <span key={i} className="tick" style={{ left: pct(i) }}>
                  {i % 5 === 0 ? `${i}s` : ''}
                </span>
              ))}
              <div
                className="playhead-handle"
                style={{ left: pct(time) }}
                onPointerDown={startScrub}
                title="Drag to scrub"
              />
            </div>

            <div className="lanes" ref={trackRef} onPointerDown={startScrub}>
              {laneDefs.map((d) => (
                <div
                  key={d.key}
                  className={`lane ${d.key === 'audio' ? 'audio' : ''} ${layers?.[d.key]?.visible === false ? 'dim' : ''}`}
                >
                  {laneBody(d.key)}
                </div>
              ))}

              <div
                className="playhead"
                style={{ left: pct(time) }}
                onPointerDown={startScrub}
                title="Drag to scrub"
              />
              {snapGuide != null && <div className="snap-guide" style={{ left: pct(snapGuide) }} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
