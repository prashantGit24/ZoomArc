import { useEffect, useRef, useState } from 'react'
import logo from '../assets/logo.png'
import ThemeToggle from '../components/ThemeToggle.jsx'

// Small stroke-style glyphs — hand-rolled to match ThemeToggle rather than
// pulling in an icon library for a handful of uses.
const IconPencil = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)
const IconTrash = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6" />
  </svg>
)
const IconPlay = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
    <path d="M9 7.5v9l8-4.5-8-4.5Z" />
  </svg>
)

function SourceCard({ s, badge, active, onClick }) {
  return (
    <button type="button" className="src" aria-pressed={active} onClick={onClick}>
      {active && (
        <span className="armed">
          <i /> Armed
        </span>
      )}
      <span className="screen">
        <img src={s.thumbnail} alt="" />
      </span>
      <span className="meta">
        <span className="name" title={s.name}>
          {s.name}
        </span>
        <span className="kind">{badge}</span>
      </span>
    </button>
  )
}

// Camera resolution presets. 'native' requests whatever the probed device
// capability tops out at — measured per-device, not assumed — and the fixed
// options are useful when you'd rather cap file size/CPU than max out a
// high-res webcam.
const CAMERA_RESOLUTIONS = [
  { id: 'native', label: 'Native (highest)' },
  { id: '1080p', label: '1080p', w: 1920, h: 1080 },
  { id: '720p', label: '720p', w: 1280, h: 720 },
]

// Multiplies the base per-tier bitrates in bitrateFor()/the webcam recorder
// below. 'maximum' is 5x YouTube's own 60fps upload recommendation — the
// default, since file size isn't a constraint unless you make it one.
const CAPTURE_QUALITIES = [
  { id: 'standard', label: 'Standard', mult: 1 },
  { id: 'high', label: 'High', mult: 2.5 },
  { id: 'maximum', label: 'Maximum (5x)', mult: 5 },
]
const DEFAULT_CAPTURE_QUALITY = 'maximum'

const shortLen = (ms) => {
  const t = Math.round((ms || 0) / 1000)
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

function formatWhen(startedAt) {
  if (!startedAt) return ''
  const d = new Date(startedAt)
  const now = new Date()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

function ProjectRow({ t, renaming, onOpen, onStartRename, onCommitRename, onDelete }) {
  const clicks = t.track.events.filter((e) => e.type === 'down').length
  const mic = !!t.track.source?.mic
  const hasCamera = !!t.cameraPath
  const sourceName = t.track.source?.name
  const when = formatWhen(t.track.startedAt)

  const thumb = (
    <span className="proj-thumb">
      <IconPlay />
      <span className="len mono">{shortLen(t.track.durationMs)}</span>
    </span>
  )
  const stats = (
    <span className="proj-stats">
      <span className="stat">
        <b>{(t.track.durationMs / 1000).toFixed(1)}s</b>
      </span>
      <span className="stat">
        <b>{clicks}</b> clicks
      </span>
      <span className="stat">{mic ? 'Mic' : 'Silent'}</span>
      {hasCamera && <span className="stat">Camera</span>}
    </span>
  )
  const sub = (
    <span className="proj-sub">
      {sourceName ? `${sourceName} · ` : ''}
      {when}
    </span>
  )

  const info = renaming ? (
    <span className="proj-info">
      <input
        className="rename-input"
        autoFocus
        defaultValue={t.track.name}
        maxLength={80}
        onClick={(e) => e.stopPropagation()}
        onBlur={(e) => onCommitRename(t.dir, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            // Restore first so the blur handler sees no change.
            e.currentTarget.value = t.track.name
            e.currentTarget.blur()
          }
        }}
      />
      {sub}
      {stats}
    </span>
  ) : (
    <span className="proj-info">
      <span className="proj-title">{t.track.name}</span>
      {sub}
      {stats}
    </span>
  )

  return (
    <article className="proj">
      {renaming ? (
        <div className="proj-open">
          {thumb}
          {info}
        </div>
      ) : (
        <button className="proj-open" onClick={onOpen} title={`Open ${t.track.name} in the editor`}>
          {thumb}
          {info}
        </button>
      )}
      <div className="proj-acts">
        <button title="Rename" aria-label={`Rename ${t.track.name}`} onClick={onStartRename}>
          <IconPencil />
        </button>
        <button className="del" title="Delete" aria-label={`Delete ${t.track.name}`} onClick={onDelete}>
          <IconTrash />
        </button>
      </div>
    </article>
  )
}

export default function Recorder({ takes, onTake, onRefresh }) {
  const [sources, setSources] = useState([])
  const [selected, setSelected] = useState(null)
  const [captureQuality, setCaptureQuality] = useState(DEFAULT_CAPTURE_QUALITY)
  const [projectName, setProjectName] = useState('')
  const [renamingDir, setRenamingDir] = useState(null)
  const [platform, setPlatform] = useState({ platform: '', stopHotkey: 'Ctrl+Shift+2' })
  const [state, setState] = useState('idle') // idle | counting | recording | saving
  const [count, setCount] = useState(3)
  const [error, setError] = useState(null)
  const [perms, setPerms] = useState(null) // null while unknown
  const [pendingDelete, setPendingDelete] = useState(null) // { dir, name } — shown in the undo toast

  // Camera + microphone devices. deviceId '' means "None" for either.
  const [cameras, setCameras] = useState([])
  const [mics, setMics] = useState([])
  const [devicesUnlocked, setDevicesUnlocked] = useState(false) // labels are blank until permission is granted once
  const [cameraId, setCameraId] = useState('')
  const [micId, setMicId] = useState('')
  const [cameraRes, setCameraRes] = useState('native')
  const [cameraCaps, setCameraCaps] = useState(null) // { maxW, maxH } for the selected camera

  const recorderRef = useRef(null)
  const cameraRecorderRef = useRef(null)
  const chunksRef = useRef([])
  const cameraChunksRef = useRef([])
  const streamRef = useRef(null)
  const cameraStreamRef = useRef(null)
  const cameraMetaRef = useRef(null) // { deviceId, label, width, height, mirror } for the take that's recording now
  const startedRef = useRef(0)
  const offsetRef = useRef(0)
  const pendingRef = useRef(null)
  const pendingTimerRef = useRef(null)
  const nativeActiveRef = useRef(false)
  const nativeFrameUnsubRef = useRef(null)

  // Screen Recording is gated by macOS; asking desktopCapturer before it is
  // granted just returns an empty/opaque list, so check first and explain.
  async function refresh() {
    const p = await window.api.checkPermissions()
    setPerms(p)
    if (p.screen !== 'granted') {
      setSources([])
      return
    }
    try {
      const list = await window.api.listSources()
      setSources(list)
      setSelected((cur) => cur || list.find((s) => s.kind === 'screen') || list[0])
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => {
    window.api.platformInfo().then(setPlatform).catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    // Grants land while we're in the background, so re-check on refocus.
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // Device labels are blank until camera/mic permission has been granted at
  // least once — enumerate anyway (so the picker isn't empty pre-permission)
  // and flag whether what came back actually has names.
  async function refreshDevices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      const cams = list.filter((d) => d.kind === 'videoinput')
      const auds = list.filter((d) => d.kind === 'audioinput')
      setCameras(cams)
      setMics(auds)
      setDevicesUnlocked(cams.every((d) => d.label) && auds.every((d) => d.label) && (cams.length > 0 || auds.length > 0))
    } catch {
      /* mediaDevices unavailable in this context — leave the pickers empty */
    }
  }

  async function unlockDevices() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      stream.getTracks().forEach((t) => t.stop())
    } catch (e) {
      console.warn('camera/mic permission not granted:', e.message)
    }
    refreshDevices()
  }

  useEffect(() => {
    refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices)
  }, [])

  // Measured, not assumed: probe the selected camera's real capability so
  // "Native" actually means something instead of guessing a number.
  useEffect(() => {
    if (!cameraId) {
      setCameraCaps(null)
      return
    }
    let canceled = false
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: { exact: cameraId } } })
      .then((stream) => {
        const track = stream.getVideoTracks()[0]
        const caps = track.getCapabilities?.() || {}
        const settings = track.getSettings?.() || {}
        stream.getTracks().forEach((t) => t.stop())
        if (!canceled) {
          setCameraCaps({
            maxW: caps.width?.max || settings.width || 1280,
            maxH: caps.height?.max || settings.height || 720,
          })
        }
      })
      .catch((e) => {
        console.warn('could not probe camera capabilities:', e.message)
        if (!canceled) setCameraCaps(null)
      })
    return () => {
      canceled = true
    }
  }, [cameraId])

  async function commitRename(dir, next) {
    setRenamingDir(null)
    const current = takes.find((t) => t.dir === dir)?.track.name
    if (!next.trim() || next.trim() === current) return
    try {
      await window.api.renameTake(dir, next)
      onRefresh()
    } catch (e) {
      setError(`Could not rename: ${e.message}`)
      onRefresh() // drop rows that no longer exist on disk
    }
  }

  // The take stays visible-but-struck-from-the-list for a few seconds so a
  // misclick is recoverable; only committed to disk once that window lapses
  // (or immediately, if a second delete comes in first).
  function commitPendingDelete() {
    const p = pendingRef.current
    if (!p) return
    pendingRef.current = null
    setPendingDelete(null)
    window.api.deleteTake(p.dir).then(onRefresh).catch(onRefresh)
  }
  function requestDelete(t) {
    commitPendingDelete()
    const info = { dir: t.dir, name: t.track.name }
    pendingRef.current = info
    setPendingDelete(info)
    clearTimeout(pendingTimerRef.current)
    pendingTimerRef.current = setTimeout(commitPendingDelete, 6000)
  }
  function undoDelete() {
    pendingRef.current = null
    clearTimeout(pendingTimerRef.current)
    setPendingDelete(null)
  }

  // The global hotkey is the only way to stop once the window is minimized.
  useEffect(() => window.api.onStopHotkey(() => stop()), [])

  async function begin() {
    if (!selected) return
    setError(null)
    setState('counting')
    for (let i = 3; i > 0; i--) {
      setCount(i)
      await new Promise((r) => setTimeout(r, 700))
    }
    try {
      await startCapture()
    } catch (e) {
      setError(e.message)
      setState('idle')
      window.api.cancelRecording()
      if (nativeActiveRef.current) {
        nativeActiveRef.current = false
        nativeFrameUnsubRef.current?.()
        nativeFrameUnsubRef.current = null
        window.api.nativeCaptureStop().catch(() => {})
      }
    }
  }

  // Physical capture resolution for the selected screen — bounds are in DIPs,
  // so the DPI scale factor has to be folded back in to land on the real
  // pixel count. Without an explicit ideal here, getDisplayMedia is free to
  // hand back a downscaled feed on a high-DPI display; asking for the exact
  // native size is what actually makes a 4K screen record at genuine 4K
  // instead of ffmpeg later stretching a smaller capture up to fill it.
  function nativeResolution() {
    const bounds = selected?.display?.bounds
    const scale = selected?.display?.scaleFactor || 1
    if (!bounds) return null
    return { width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) }
  }

  // Cursor-as-data: the OS cursor is never composited into recorded frames,
  // under any setting — that's a capture-time guarantee, not something fixed
  // up later in editing. One path only: getDisplayMedia (routed through
  // main.cjs's setDisplayMediaRequestHandler -> desktopCapturer.getSources())
  // with cursor:'never'. There used to be a second, legacy getUserMedia path
  // (chromeMediaSource:'desktop') — the only capture mode that could never
  // exclude the OS cursor, and the direct cause of a double-cursor bug once
  // it fired. Removed outright, not migrated: recording with the OS cursor
  // baked in is not a supported mode. Cursor handling instead moves entirely
  // to render time — the editor's "Draw smoothed cursor" checkbox — where a
  // synthetic sprite drawn from the independently-captured cursor track can
  // actually be restyled, resized, or swapped after the fact.
  //
  // No catch-and-retry here either: if getDisplayMedia throws, or hands back
  // a track that didn't actually honour cursor:'never' (never assume a
  // constraint was silently satisfied — the track's own negotiated settings
  // are the only trustworthy answer), that's a hard failure. begin()'s own
  // try/catch surfaces it as a visible capture-failed error state; silently
  // retrying on the legacy path is exactly what used to re-introduce the OS
  // cursor.
  async function captureStream() {
    const native = nativeResolution()
    await window.api.armCapture(selected.id)

    // Window sources go straight to the native capture module when it's
    // available, bypassing Chromium's own window capturer entirely — on this
    // class of hardware it's been observed to fail mid-capture (Chromium's
    // own logs show WGC ProcessFrame errors) and silently re-serve the last
    // good frame instead of erroring, which reads as the recording freezing
    // on one frame while the real window keeps changing. A frozen frame is
    // indistinguishable from genuinely static content after the fact, so
    // there's no reliable way to catch this by inspecting the result — it has
    // to be avoided going in. Screen sources keep the verify-then-fallback
    // path below unchanged, since that failure mode (cursor not excluded) can
    // be checked directly from the track's own settings. On platforms
    // without the native module (non-Windows, or not built) this just falls
    // through to the normal path, where this freeze hasn't been observed.
    if (selected.kind === 'window') {
      const nativeResult = await captureStreamNativeWindow()
      if (nativeResult) return nativeResult
    }

    // 60fps target for smooth zoom/motion. `ideal` (not `min`) deliberately —
    // this constraints API rejects the whole capture outright with
    // OverconstrainedError if a `min` can't be met, e.g. on a <60Hz display;
    // `ideal` asks for the same 60 but degrades gracefully instead of failing.
    const video = { cursor: 'never', frameRate: { ideal: 60, max: 60 } }
    if (native) {
      video.width = { ideal: native.width }
      video.height = { ideal: native.height }
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video })
    const settings = stream.getVideoTracks()[0]?.getSettings() || {}
    if (settings.cursor === 'never') return { stream, cursorHidden: true }

    // getDisplayMedia didn't throw, but the negotiated track's own settings
    // say the cursor constraint wasn't actually honored — Chromium picked a
    // capture backend (DXGI Desktop Duplication) with no concept of excluding
    // the cursor. Never assume a requested constraint was silently satisfied;
    // the track's own settings are the only trustworthy answer. Don't retry
    // getDisplayMedia itself under any other flag — fall through to the
    // Windows Graphics Capture module, which talks to the OS directly instead
    // of hoping Chromium's backend selection cooperates.
    stream.getTracks().forEach((t) => t.stop())
    const nativeResult = await captureStreamNative()
    if (nativeResult) return nativeResult

    throw new Error(
      "Your system can't currently exclude the cursor from screen recordings. This needs a " +
        'Windows Graphics Capture-capable setup (Windows 10 2004+ with an up-to-date graphics ' +
        'driver). Update Windows and your GPU driver, then try again.',
    )
  }

  // Shared by captureStreamNative()/captureStreamNativeWindow() below —
  // everything past "how the capture session actually gets started" is
  // identical: an offscreen canvas fed by native frames, held back from
  // captureStream() until a real first frame lands (see the black-frame
  // comment inline), then handed back as a normal MediaStream so nothing
  // downstream has to know which capture route produced it.
  async function captureStreamFromNative(initialWidth, initialHeight, startCapture) {
    const canvas = document.createElement('canvas')
    canvas.width = initialWidth
    canvas.height = initialHeight
    const ctx = canvas.getContext('2d')

    // A freshly created canvas is blank (renders as black), and native
    // capture takes a moment to spin up (device/session creation) before its
    // first frame arrives. canvas.captureStream() starts emitting the moment
    // it's called, so if that happens before any real frame has been drawn,
    // MediaRecorder bakes a black flash into the very start of the take.
    // Wait for a real first frame before starting the stream at all — capped
    // so a native capture that never delivers a frame can't hang recording
    // forever instead of falling through to the plain-language error.
    let resolveFirstFrame
    const firstFrame = new Promise((resolve) => {
      resolveFirstFrame = resolve
    })

    const unsub = window.api.onNativeCaptureFrame(({ width, height, buffer }) => {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
      const pixels = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      ctx.putImageData(new ImageData(pixels, width, height), 0, 0)
      resolveFirstFrame?.()
      resolveFirstFrame = null
    })

    const started = await startCapture().catch((e) => {
      console.warn('native capture unavailable:', e.message)
      return false
    })
    if (!started) {
      unsub()
      return null
    }

    nativeFrameUnsubRef.current = unsub
    nativeActiveRef.current = true

    const timedOut = await Promise.race([
      firstFrame.then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), 2000)),
    ])
    if (timedOut) console.warn('native capture: no frame arrived within 2s, starting anyway')

    return { stream: canvas.captureStream(60), cursorHidden: true }
  }

  // Verified fallback for screen sources, not a silent degrade: only reached
  // once captureStream() has already proven getDisplayMedia's cursor:'never'
  // wasn't honored. Talks to Windows.Graphics.Capture directly via the native
  // addon (electron/main.cjs -> native/wgc-capture), which checks
  // IsCursorCaptureEnabled support itself and refuses to start rather than
  // silently capturing with the cursor visible.
  async function captureStreamNative() {
    const supported = await window.api.nativeCaptureSupported().catch(() => false)
    if (!supported) return null

    const monitors = await window.api.nativeCaptureListMonitors().catch(() => [])
    if (!monitors.length) return null

    const bounds = selected?.display?.bounds
    const scale = selected?.display?.scaleFactor || 1
    let target = monitors.find((m) => m.primary) || monitors[0]
    if (bounds) {
      const wantX = Math.round(bounds.x * scale)
      const wantY = Math.round(bounds.y * scale)
      target = monitors.reduce((best, m) => {
        const d = Math.abs(m.x - wantX) + Math.abs(m.y - wantY)
        const bestD = Math.abs(best.x - wantX) + Math.abs(best.y - wantY)
        return d < bestD ? m : best
      }, target)
    }

    return captureStreamFromNative(target.width, target.height, () =>
      window.api.nativeCaptureStart(target.handle),
    )
  }

  // Unconditional for window sources when the native module is available —
  // see the comment in captureStream() for why this doesn't wait to detect a
  // failure first. Electron's window-source ids are formatted
  // `window:<HWND>:0` on Windows, so the HWND is pulled straight out of the
  // id rather than needing a separate lookup.
  async function captureStreamNativeWindow() {
    const supported = await window.api.nativeCaptureSupported().catch(() => false)
    if (!supported) return null

    const match = /^window:(\d+):/.exec(selected.id)
    if (!match) return null
    const hwnd = match[1]

    return captureStreamFromNative(1920, 1080, () => window.api.nativeCaptureStartWindow(hwnd))
  }

  // H.264 first, not VP9 — VP9 has essentially no hardware encoder on most
  // GPUs (this machine's included), so MediaRecorder falls back to software
  // libvpx, which can't sustain 1080p60 encoding in real time: measured
  // capture came out around 17fps despite the stream itself being requested
  // and negotiated at 60fps — the encoder, not the capture, was the actual
  // bottleneck. H.264 has a real hardware encode path on virtually every GPU
  // built in the last decade (NVENC/Quick Sync/AMF), so MediaRecorder can
  // keep up with a genuine 60fps stream instead of quietly dropping frames.
  // Falls back to VP9 then plain webm on a machine where H.264 truly isn't
  // available — ffmpeg reads H.264-in-WebM (or -in-MP4) equally well
  // downstream either way, so nothing else in the pipeline needs to care.
  function pickVideoMimeType() {
    for (const type of ['video/webm;codecs=h264', 'video/webm;codecs=vp9']) {
      if (MediaRecorder.isTypeSupported(type)) return type
    }
    return 'video/webm'
  }

  // CRF-based encoding at export time adapts to whatever resolution it's
  // given, but MediaRecorder itself has no such thing — a fixed low bitrate
  // (this was 12 Mbps for everything, screen text included) makes a 4K
  // capture come out soft and blocky regardless of how good the source is.
  // Base numbers track YouTube's own recommended upload bitrates for 60fps;
  // captureQuality's multiplier (1x/2.5x/5x, picked in the header) scales
  // them up from there — a higher-bitrate VP9 capture also gives the
  // editor/export pipeline a cleaner source (less of its own compression
  // noise for the export's own encode to compound).
  function bitrateFor(width, height) {
    const mult = CAPTURE_QUALITIES.find((q) => q.id === captureQuality)?.mult || 1
    const px = (width || 1920) * (height || 1080)
    if (px <= 1920 * 1080) return 16_000_000 * mult
    if (px <= 2560 * 1440) return 24_000_000 * mult
    if (px <= 3840 * 2160) return 50_000_000 * mult
    return 70_000_000 * mult
  }

  async function startCapture() {
    const { stream, cursorHidden } = await captureStream()

    if (micId) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micId } } })
        mic.getAudioTracks().forEach((t) => stream.addTrack(t))
      } catch (e) {
        console.warn('mic unavailable:', e.message)
      }
    }

    streamRef.current = stream
    chunksRef.current = []

    // The actual negotiated resolution, not the requested ideal — a device
    // or display can still hand back less than asked for.
    const capturedSettings = stream.getVideoTracks()[0]?.getSettings() || {}
    const rec = new MediaRecorder(stream, {
      mimeType: pickVideoMimeType(),
      videoBitsPerSecond: bitrateFor(capturedSettings.width, capturedSettings.height),
    })
    rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data)
    rec.onstop = maybeFinalize
    recorderRef.current = rec

    // The webcam is a second, independent capture — its own stream and
    // MediaRecorder — so the editor can restyle/reposition it later without
    // ever having to re-encode the screen recording.
    let cameraTrackSettings = null
    if (cameraId) {
      try {
        const resOpt = CAMERA_RESOLUTIONS.find((r) => r.id === cameraRes) || CAMERA_RESOLUTIONS[0]
        // `ideal` only — most webcams simply top out at 30fps, and a `min`
        // here would reject the capture outright on any of them.
        const videoConstraints = { deviceId: { exact: cameraId }, frameRate: { ideal: 60 } }
        if (resOpt.w) {
          videoConstraints.width = { ideal: resOpt.w }
          videoConstraints.height = { ideal: resOpt.h }
        } else if (cameraCaps) {
          videoConstraints.width = { ideal: cameraCaps.maxW }
          videoConstraints.height = { ideal: cameraCaps.maxH }
        }
        const camStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false })
        cameraStreamRef.current = camStream
        cameraTrackSettings = camStream.getVideoTracks()[0]?.getSettings() || null
        cameraChunksRef.current = []
        const camRec = new MediaRecorder(camStream, {
          mimeType: pickVideoMimeType(),
          // Same tier system as the screen capture, base 6 Mbps.
          videoBitsPerSecond: 6_000_000 * (CAPTURE_QUALITIES.find((q) => q.id === captureQuality)?.mult || 1),
        })
        camRec.ondataavailable = (e) => e.data.size && cameraChunksRef.current.push(e.data)
        camRec.onstop = maybeFinalize
        cameraRecorderRef.current = camRec
      } catch (e) {
        console.warn('camera unavailable:', e.message)
        cameraStreamRef.current = null
        cameraRecorderRef.current = null
      }
    } else {
      cameraStreamRef.current = null
      cameraRecorderRef.current = null
    }

    const cameraDevice = cameraId ? cameras.find((d) => d.deviceId === cameraId) : null

    // Start the tracker first so mouse timestamps never precede frame zero.
    const { t0 } = await window.api.startRecording({
      sourceId: selected.id,
      name: selected.name,
      kind: selected.kind,
      display: selected.display,
      mic: !!micId,
      micLabel: mics.find((d) => d.deviceId === micId)?.label || null,
      projectName,
      cursorHidden,
      hideWindow: true,
    })
    startedRef.current = performance.now()
    rec.start(1000)
    cameraRecorderRef.current?.start(1000)
    // Date.now() shares an epoch with main's tracker clock (t0), unlike
    // performance.now() above, so this gap is the real delay between the
    // tracker's zero and the video actually starting — see record:finish.
    offsetRef.current = Math.max(0, Date.now() - t0)
    cameraMetaRef.current = cameraDevice
      ? {
          deviceId: cameraDevice.deviceId,
          label: cameraDevice.label || 'Camera',
          width: cameraTrackSettings?.width || null,
          height: cameraTrackSettings?.height || null,
          mirror: true,
        }
      : null
    setState('recording')
  }

  function stop() {
    const rec = recorderRef.current
    if (!rec || rec.state === 'inactive') return
    setState('saving')
    rec.stop()
    if (cameraRecorderRef.current?.state !== 'inactive') cameraRecorderRef.current?.stop()
  }

  // Both recorders' 'stop' events land separately (they're independent
  // MediaRecorder instances) — only finalize once neither is still running.
  function maybeFinalize() {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') return
    if (cameraRecorderRef.current && cameraRecorderRef.current.state !== 'inactive') return
    finalize()
  }

  async function finalize() {
    const stream = streamRef.current
    const settings = stream?.getVideoTracks()[0]?.getSettings() || {}
    stream?.getTracks().forEach((t) => t.stop())
    const cameraStream = cameraStreamRef.current
    cameraStream?.getTracks().forEach((t) => t.stop())
    if (nativeActiveRef.current) {
      nativeActiveRef.current = false
      nativeFrameUnsubRef.current?.()
      nativeFrameUnsubRef.current = null
      window.api.nativeCaptureStop().catch(() => {})
    }

    const blob = new Blob(chunksRef.current, { type: 'video/webm' })
    const buffer = await blob.arrayBuffer()
    let cameraBuffer = null
    if (cameraChunksRef.current.length) {
      const camBlob = new Blob(cameraChunksRef.current, { type: 'video/webm' })
      cameraBuffer = await camBlob.arrayBuffer()
    }
    try {
      const take = await window.api.finishRecording({
        buffer,
        durationMs: performance.now() - startedRef.current,
        videoSize: { width: settings.width || 1920, height: settings.height || 1080 },
        offsetMs: offsetRef.current,
        cameraBuffer,
        camera: cameraMetaRef.current,
      })
      setState('idle')
      onTake(take)
    } catch (e) {
      setError(e.message)
      setState('idle')
    }
  }

  if (state === 'counting') {
    return (
      <div className="overlay">
        <div className="count mono">{count}</div>
        <p>Get ready…</p>
      </div>
    )
  }

  if (state === 'recording' || state === 'saving') {
    return (
      <div className="overlay">
        <div className="rec-dot" />
        <h2>{state === 'saving' ? 'Saving…' : 'Recording'}</h2>
        <p>
          Press <kbd>{platform.stopHotkey}</kbd> anywhere to stop
        </p>
        {state === 'recording' && (
          <button className="btn danger" onClick={stop}>
            Stop recording
          </button>
        )}
      </div>
    )
  }

  const displays = sources.filter((s) => s.kind === 'screen')
  const windowSources = sources.filter((s) => s.kind !== 'screen')
  const visibleTakes = takes.filter((t) => t.dir !== pendingDelete?.dir)
  // The physical pixel size we'll actually request, not the DIP bounds —
  // on a scaled display those can be very different numbers.
  const native = nativeResolution()
  const formatSpec = selected?.kind === 'screen' && native
    ? `${native.width} × ${native.height}`
    : selected
      ? 'Window capture'
      : '—'

  return (
    <div className="app recorder">
      <header className="titlebar">
        <img className="logo" src={logo} alt="" />
        <div className="brandwrap">
          <h1>ZoomArc</h1>
          <small>Capture</small>
        </div>

        <label className="namefield">
          <IconPencil />
          <input
            value={projectName}
            placeholder="Untitled project"
            maxLength={80}
            onChange={(e) => setProjectName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            aria-label="Project name"
          />
        </label>

        <div className="header-controls">
          <select
            className="select"
            value={captureQuality}
            onChange={(e) => setCaptureQuality(e.target.value)}
            title="Capture bitrate — higher means a cleaner source and a bigger file, no cap on resolution either way"
          >
            {CAPTURE_QUALITIES.map((q) => (
              <option key={q.id} value={q.id}>
                {q.label}
              </option>
            ))}
          </select>
          <ThemeToggle />
        </div>
      </header>

      <div className="recorder-body">
        {error && <div className="error">{error}</div>}

        {perms && !perms.accessibility && (
          <div className="notice row between">
            <span>
              Grant <strong>Accessibility</strong> to track mouse clicks for auto-zoom.
            </span>
            <button className="btn sm" onClick={() => window.api.openPermissionSettings('accessibility')}>
              Open settings
            </button>
          </div>
        )}

        <div className="recorder-columns">
          <div className="recorder-col-main">
            {perms && perms.screen !== 'granted' ? (
              <div className="group">
                <h2>Screen recording permission</h2>
                <p className="hint">
                  macOS needs to allow this app to capture your screen. Grant it in System Settings ›
                  Privacy &amp; Security › Screen Recording, then come back — you may need to relaunch.
                </p>
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn primary" onClick={() => window.api.openPermissionSettings('screen')}>
                    Open settings
                  </button>
                  <button className="btn ghost" onClick={refresh}>
                    Re-check
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="stage-head">
                  <h1>Choose what to record</h1>
                  <p>The framed source is what ZoomArc captures.</p>
                  <button className="btn ghost sm refresh" onClick={refresh}>
                    Refresh sources
                  </button>
                </div>

                {displays.length > 0 && (
                  <div className="group">
                    <h2>Displays</h2>
                    <div className="wall">
                      {displays.map((s, i) => (
                        <SourceCard
                          key={s.id}
                          s={s}
                          badge={`Display ${i + 1}`}
                          active={selected?.id === s.id}
                          onClick={() => setSelected(s)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {windowSources.length > 0 && (
                  <div className="group">
                    <h2>Windows</h2>
                    <div className="wall">
                      {windowSources.map((s) => (
                        <SourceCard
                          key={s.id}
                          s={s}
                          badge="Window"
                          active={selected?.id === s.id}
                          onClick={() => setSelected(s)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                <div className="group">
                  <h2>Camera &amp; microphone</h2>
                  {!devicesUnlocked && (
                    <div className="notice row between">
                      <span>Grant access to see your device names.</span>
                      <button className="btn sm" onClick={unlockDevices}>
                        Enable
                      </button>
                    </div>
                  )}
                  <div className="device-grid">
                    <label className="device-field">
                      <span>Camera</span>
                      <select className="select" value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
                        <option value="">None</option>
                        {cameras.map((d, i) => (
                          <option key={d.deviceId} value={d.deviceId}>
                            {d.label || `Camera ${i + 1}`}
                          </option>
                        ))}
                        {cameras.length === 0 && <option disabled>No camera detected</option>}
                      </select>
                    </label>
                    {cameraId && (
                      <label className="device-field">
                        <span>Resolution</span>
                        <select className="select" value={cameraRes} onChange={(e) => setCameraRes(e.target.value)}>
                          {CAMERA_RESOLUTIONS.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.id === 'native' && cameraCaps
                                ? `Native (${cameraCaps.maxW}×${cameraCaps.maxH})`
                                : r.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="device-field">
                      <span>Microphone</span>
                      <select className="select" value={micId} onChange={(e) => setMicId(e.target.value)}>
                        <option value="">None</option>
                        {mics.map((d, i) => (
                          <option key={d.deviceId} value={d.deviceId}>
                            {d.label || `Microphone ${i + 1}`}
                          </option>
                        ))}
                        {mics.length === 0 && <option disabled>No microphone detected</option>}
                      </select>
                    </label>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="recorder-col-side">
            <aside className="rail">
              <div className="rail-head">
                <h3>Recorded projects</h3>
                <span className="count">{takes.length}</span>
                <button className="btn ghost sm folder" onClick={() => window.api.revealTakesFolder()}>
                  Show in folder
                </button>
              </div>

              <div className="projects">
                {visibleTakes.length === 0 ? (
                  <div className="empty-state">
                    <b>No recordings yet</b>
                    Pick a source and press Record. Finished takes land here, ready to zoom and export.
                  </div>
                ) : (
                  visibleTakes.map((t) => (
                    <ProjectRow
                      key={t.dir}
                      t={t}
                      renaming={renamingDir === t.dir}
                      onOpen={() => onTake(t)}
                      onStartRename={() => setRenamingDir(t.dir)}
                      onCommitRename={commitRename}
                      onDelete={() => requestDelete(t)}
                    />
                  ))
                )}
              </div>

              {pendingDelete && (
                <div className="undo">
                  <span>Deleted "{pendingDelete.name}"</span>
                  <button onClick={undoDelete}>Undo</button>
                </div>
              )}
            </aside>
          </div>
        </div>
      </div>

      <div className="transport">
        <div className="readout">
          <div className="field">
            <span className="k">Source</span>
            <span className="v">{selected?.name || '—'}</span>
          </div>
          <div className="sep" />
          <div className="field">
            <span className="k">Format</span>
            <span className="v mono">{formatSpec}</span>
          </div>
          <div className="sep" />
          <div className="field">
            <span className="k">Audio</span>
            <span className="v">{micId ? mics.find((d) => d.deviceId === micId)?.label || 'Microphone' : 'Silent'}</span>
          </div>
          {cameraId && (
            <>
              <div className="sep" />
              <div className="field">
                <span className="k">Camera</span>
                <span className="v">{cameras.find((d) => d.deviceId === cameraId)?.label || 'Camera'}</span>
              </div>
            </>
          )}
        </div>
        <button className="btn record" disabled={!selected || perms?.screen !== 'granted'} onClick={begin}>
          <span className="led" />
          Record
        </button>
      </div>
    </div>
  )
}
