import { useEffect, useLayoutEffect, useState } from 'react'

// The card is laid out at the design's own size and scaled to the window, so
// every element keeps its exact position and proportion at any window size.
const CARD_W = 1121
const CARD_H = 632

const Svg = ({ size = 26, children, strokeWidth = 1.8 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)
const IconMonitor = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </Svg>
)
const IconWindow = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18" />
  </Svg>
)
const IconMic = () => (
  <Svg>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Svg>
)
const IconMicOff = () => (
  <Svg>
    <path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 5.1 2.1M5 11a7 7 0 0 0 11.6 5.3M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18" />
  </Svg>
)
const IconCam = () => (
  <Svg>
    <rect x="3" y="6" width="13" height="12" rx="2" />
    <path d="m16 10 5-3v10l-5-3" />
  </Svg>
)
const IconCamOff = () => (
  <Svg>
    <path d="M16 16v1a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1M9.7 6H15a1 1 0 0 1 1 1v3.3l5-3.3v10M3 3l18 18" />
  </Svg>
)
const IconGauge = () => (
  <Svg>
    <path d="M3.3 17a9 9 0 1 1 17.4 0" />
    <path d="m12 14 4.5-4.5" />
  </Svg>
)
const IconClock = () => (
  <Svg size={32} strokeWidth={2}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
)

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`
}

/* ---------------------------------------------------------------- dial */
// Geometry measured from the design, in card pixels.
const BAND = { cx: 470, cy: 280, outer: 361, inner: 300 }
const TICKS = { cx: 543, cy: 280, r: 323, len: 13, from: -56, to: 40, step: 3 }
// Minute scale: numbers sit in the design's fixed slots on a circle centred
// on the band. Slot 0 (the highlighted spot above the pointer) is the minute
// being recorded; +1/+2 are upcoming minutes, -1..-4 past ones. At each new
// minute every number glides down one slot.
const LABELS = { cx: 470, cy: 280, r: 397 }
const SLOT_DEG = { 3: -50, 2: -35, 1: -19.7, 0: -3.6, '-1': 8.6, '-2': 21.8, '-3': 34.3, '-4': 45.6, '-5': 57 }
const GLIDE_S = 0.6 // the slide happens over the last 0.6s of each minute
// Tick ring turns this many degrees per minute, so one tick passes every 12s.
const MINUTE_DEG = 15
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const rad = (deg) => (deg * Math.PI) / 180
// Point on a circle at `deg` measured from the leftward horizontal (positive = downward).
const at = (c, r, deg) => [c.cx - r * Math.cos(rad(deg)), c.cy + r * Math.sin(rad(deg))]

function bandPath(fromDeg, toDeg) {
  const [ox1, oy1] = at(BAND, BAND.outer, fromDeg)
  const [ox2, oy2] = at(BAND, BAND.outer, toDeg)
  const [ix2, iy2] = at(BAND, BAND.inner, toDeg)
  const [ix1, iy1] = at(BAND, BAND.inner, fromDeg)
  // Outer edge sweeps counter-clockwise (screen) from upper to lower, inner back.
  return `M${ox1} ${oy1} A${BAND.outer} ${BAND.outer} 0 0 0 ${ox2} ${oy2} L${ix2} ${iy2} A${BAND.inner} ${BAND.inner} 0 0 1 ${ix1} ${iy1} Z`
}

function Dial({ elapsedMs = 0 }) {
  const minutes = Math.max(0, elapsedMs) / 60000
  // Ticks scroll downward with the seconds (one tick = TICKS.step degrees of
  // the minute tape), so the dial visibly turns while recording.
  const shift = ((minutes * MINUTE_DEG) % TICKS.step + TICKS.step) % TICKS.step
  const ticks = []
  for (let base = TICKS.from - TICKS.step; base <= TICKS.to; base += TICKS.step) {
    const a = base + shift
    if (a < TICKS.from || a > TICKS.to) continue
    const [x1, y1] = at(TICKS, TICKS.r - TICKS.len / 2, a)
    const [x2, y2] = at(TICKS, TICKS.r + TICKS.len / 2, a)
    // Fade out toward the bottom end, like the design.
    const fade = a > 18 ? Math.max(0.15, 1 - (a - 18) / 26) : 1
    ticks.push(<line key={base} className="tick" x1={x1} y1={y1} x2={x2} y2={y2} style={{ opacity: fade }} />)
  }
  const [mx1, my1] = at(TICKS, TICKS.r - 15, 0)
  const [mx2, my2] = at(TICKS, TICKS.r + 15, 0)

  // Minute numbers in their slots, gliding down one slot as each minute ends.
  const current = Math.floor(minutes)
  const secondInMinute = (minutes - current) * 60
  const glide = easeInOut(Math.min(1, Math.max(0, (secondInMinute - (60 - GLIDE_S)) / GLIDE_S)))
  const activeMinute = glide > 0.5 ? current + 1 : current
  const labels = []
  for (let k = 3; k >= -4; k--) {
    const m = current + k
    if (m < 0) continue
    const angle = SLOT_DEG[k] + (SLOT_DEG[k - 1] - SLOT_DEG[k]) * glide
    const opacity = k === 3 ? glide : k === -4 ? 1 - glide : 1
    if (opacity <= 0) continue
    const [x, y] = at(LABELS, LABELS.r, angle)
    labels.push(
      <text key={m} className={m === activeMinute ? 'scale active' : 'scale'} x={x} y={y} textAnchor="middle" dominantBaseline="central" style={{ opacity }}>
        {m}
      </text>,
    )
  }
  return (
    <svg className="rec-dial" viewBox={`0 0 ${CARD_W} ${CARD_H}`} aria-hidden="true">
      <defs>
        <linearGradient id="band-upper" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4a35c9" />
          <stop offset="0.55" stopColor="#6f52ef" />
          <stop offset="1" stopColor="#8b6cff" />
        </linearGradient>
        <linearGradient id="band-lower" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d9c8ff" />
          <stop offset="0.28" stopColor="#a585ff" />
          <stop offset="0.52" stopColor="#7650f0" stopOpacity="0.9" />
          <stop offset="0.72" stopColor="#4a33b0" stopOpacity="0.35" />
          <stop offset="0.86" stopColor="#2a1d6b" stopOpacity="0" />
        </linearGradient>
        <filter id="band-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="18" />
        </filter>
      </defs>

      {/* soft glow behind the band */}
      <path d={bandPath(-80, 40)} fill="#7c5cff" opacity="0.38" filter="url(#band-glow)" />
      <path className="band upper" d={bandPath(-82, 0)} fill="url(#band-upper)" />
      {/* Runs past the card's bottom edge so its faded tail never shows an end cap. */}
      <path className="band lower" d={bandPath(0, 84)} fill="url(#band-lower)" />

      <g className="ticks">{ticks}</g>
      <line className="tick main" x1={mx1} y1={my1} x2={mx2} y2={my2} />

      {labels}
      <text className="scale-unit" x="69" y="300" textAnchor="middle" dominantBaseline="central">
        min
      </text>
      <line className="scale-mark" x1="44" y1="278" x2="94" y2="278" />
      <path className="pointer" d="M19 270 L32 278 L19 286 Z" />
    </svg>
  )
}

/* -------------------------------------------------------------- shell */
function Stage({ children }) {
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    // Never above 90% of the design size; smaller still if the window is.
    const fit = () => setScale(Math.min(0.9, (window.innerWidth - 48) / CARD_W, (window.innerHeight - 48) / CARD_H))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  return (
    <div className="rec-screen">
      <div className="rec-stage" style={{ width: CARD_W * scale, height: CARD_H * scale }}>
        <div className="rec-card2" style={{ transform: `scale(${scale})` }}>
          {children}
        </div>
      </div>
    </div>
  )
}

function Chips({ source, mic, camera }) {
  return (
    <div className="rec2-chips">
      <span className="rec2-chip strong shrink" title={source?.name}>
        {source?.kind === 'window' ? <IconWindow /> : <IconMonitor />}
        <span>{source?.name || 'Screen'}</span>
      </span>
      <span className={`rec2-chip ${mic ? 'shrink' : ''}`} title={mic || 'No microphone'}>
        {mic ? <IconMic /> : <IconMicOff />}
        <span>{mic || 'No mic'}</span>
      </span>
      <span className={`rec2-chip ${camera ? 'shrink' : ''}`} title={camera || 'No camera'}>
        {camera ? <IconCam /> : <IconCamOff />}
        <span>{camera || 'No camera'}</span>
      </span>
      <span className="rec2-chip">
        <IconGauge />
        <span>60 fps</span>
      </span>
    </div>
  )
}

function Keys({ combo }) {
  const keys = String(combo || '').split('+')
  return keys.map((k, i) => (
    <span key={k} className="rec2-keygroup">
      {i > 0 && <span className="rec2-plus">+</span>}
      <kbd>{k}</kbd>
    </span>
  ))
}

/** Countdown before capture starts. */
export function CountdownScreen({ count, source, mic, camera }) {
  return (
    <Stage>
      <div className="rec2 counting">
        <Dial elapsedMs={0} />
        <div className="rec2-top">
          <span className="rec2-badge">
            <i />
            READY
          </span>
          <span className="rec2-fps">
            <IconClock />
            60 fps
          </span>
        </div>
        <div className="rec2-timer count" key={count}>
          {count}
        </div>
        <h2 className="rec2-title">Get ready</h2>
        <p className="rec2-sub">Recording starts in a moment.</p>
        <Chips source={source} mic={mic} camera={camera} />
        <div className="rec2-stop placeholder">Starting…</div>
        <p className="rec2-hint">The app hides itself so it stays out of the shot.</p>
      </div>
    </Stage>
  )
}

/** Live recording, and the saving state right after. */
export default function RecordingScreen({ saving, startedAt, source, mic, camera, stopHotkey, onStop }) {
  const [now, setNow] = useState(() => performance.now())
  // Every frame while live, so the minute dial turns smoothly.
  useEffect(() => {
    if (saving) return undefined
    let raf = requestAnimationFrame(function tick() {
      setNow(performance.now())
      raf = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(raf)
  }, [saving])

  const what = source?.kind === 'window' ? 'window' : 'screen'
  return (
    <Stage>
      <div className={`rec2 ${saving ? 'saving' : 'live'}`}>
        <Dial elapsedMs={now - startedAt} />
        <div className="rec2-top">
          <span className="rec2-badge">
            <i />
            {saving ? 'SAVING' : 'REC'}
          </span>
          <span className="rec2-fps">
            <IconClock />
            60 fps
          </span>
        </div>
        <div className="rec2-timer">{formatElapsed(now - startedAt)}</div>
        <h2 className="rec2-title">{saving ? 'Saving' : 'Recording'}</h2>
        <p className="rec2-sub">
          {saving ? 'Finishing the video and syncing the cursor track…' : `ZoomArc is capturing your ${what}.`}
        </p>
        <Chips source={source} mic={mic} camera={camera} />
        {saving ? (
          <div className="rec2-stop placeholder">
            <span className="rec2-spinner" aria-hidden="true" />
            Saving your take…
          </div>
        ) : (
          <button type="button" className="rec2-stop" onClick={onStop}>
            <span className="rec2-stop-icon" aria-hidden="true" />
            Stop recording
          </button>
        )}
        <p className="rec2-hint">
          {saving ? (
            'This only takes a moment.'
          ) : (
            <>
              Stop from any app with <Keys combo={stopHotkey} />
            </>
          )}
        </p>
      </div>
    </Stage>
  )
}
