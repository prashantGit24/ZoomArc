import { useEffect, useRef, useState } from 'react'
import logo from '../assets/logo.png'
import ThemeToggle from '../components/ThemeToggle.jsx'
import RecordingScreen, { CountdownScreen } from '../components/RecordingScreen.jsx'

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
        {s.thumbnail ? <img src={s.thumbnail} alt="" /> : <span className="screen-placeholder">{s.name}</span>}
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
  const startWallRef = useRef(0)
  const modeRef = useRef('native') // 'native' | 'browser'
  const activeRef = useRef(false)
  const pendingRef = useRef(null)
  const pendingTimerRef = useRef(null)

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
      activeRef.current = false
      releaseStreams()
      window.api.cancelRecording()
    }
  }

  // Physical capture resolution for the selected screen — bounds are in DIPs,
  // so the DPI scale factor has to be folded back in to land on the real
  // pixel count, or getDisplayMedia may hand back a downscaled feed.
  function nativeResolution() {
    const bounds = selected?.display?.bounds
    const scale = selected?.display?.scaleFactor || 1
    if (!bounds) return null
    return { width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) }
  }

  // Cursor-as-data: the OS cursor is never composited into recorded frames;
  // it's drawn at render time from the separately recorded cursor track.
  //
  // Primary path (Windows): the native module records the monitor/window
  // straight to a hardware-encoded 60fps MP4 and samples the real cursor on
  // the same clock (see native/wgc-capture). This picks what to record.
  async function nativeTarget() {
    if (!(await window.api.nativeCaptureSupported().catch(() => false))) return null
    if (selected.kind === 'window') {
      // Electron window-source ids are `window:<HWND>:0` on Windows.
      const match = /^window:(\d+):/.exec(selected.id)
      if (!match) return null
      const b = await window.api.nativeCaptureGetWindowBounds(match[1]).catch(() => null)
      return { kind: 'window', handle: match[1], width: b?.width, height: b?.height }
    }
    const monitors = await window.api.nativeCaptureListMonitors().catch(() => [])
    if (!monitors.length) return null
    const exact = monitors.find((m) => m.handle === selected.monitor)
    if (exact) return { kind: 'monitor', handle: exact.handle, width: exact.width, height: exact.height }
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
    return { kind: 'monitor', handle: target.handle, width: target.width, height: target.height }
  }

  // Fallback (no native module): getDisplayMedia with cursor:'never'. Never
  // assume the constraint was honoured — the negotiated track's own settings
  // are the only trustworthy answer, and recording with the OS cursor baked
  // in is not a supported mode.
  async function captureDisplayStream() {
    const native = nativeResolution()
    await window.api.armCapture(selected.id)
    const video = { cursor: 'never', frameRate: { ideal: 60, max: 60 } }
    if (native) {
      video.width = { ideal: native.width }
      video.height = { ideal: native.height }
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video })
    if (stream.getVideoTracks()[0]?.getSettings()?.cursor === 'never') return stream
    stream.getTracks().forEach((t) => t.stop())
    throw new Error(
      "Your system can't currently exclude the cursor from screen recordings. This needs a " +
        'Windows Graphics Capture-capable setup (Windows 10 2004+ with an up-to-date graphics ' +
        'driver). Update Windows and your GPU driver, then try again.',
    )
  }

  // H.264 first: VP9 has no hardware encoder on most GPUs and can't sustain
  // 1080p60 in software.
  function pickVideoMimeType() {
    for (const type of ['video/webm;codecs=h264', 'video/webm;codecs=vp9']) {
      if (MediaRecorder.isTypeSupported(type)) return type
    }
    return 'video/webm'
  }

  // Base numbers track YouTube's recommended 60fps upload bitrates; the
  // capture-quality multiplier (header picker) scales them up from there.
  function bitrateFor(width, height) {
    const mult = CAPTURE_QUALITIES.find((q) => q.id === captureQuality)?.mult || 1
    const px = (width || 1920) * (height || 1080)
    if (px <= 1920 * 1080) return 16_000_000 * mult
    if (px <= 2560 * 1440) return 24_000_000 * mult
    if (px <= 3840 * 2160) return 50_000_000 * mult
    return 70_000_000 * mult
  }

  async function openMic() {
    if (!micId) return null
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micId } } })
    } catch (e) {
      console.warn('mic unavailable:', e.message)
      return null
    }
  }

  // The webcam is its own capture so the editor can restyle/reposition it
  // without ever re-encoding the screen recording.
  async function openCamera() {
    if (!cameraId) return null
    try {
      const resOpt = CAMERA_RESOLUTIONS.find((r) => r.id === cameraRes) || CAMERA_RESOLUTIONS[0]
      // `ideal` only — most webcams top out at 30fps and a `min` would reject them.
      const constraints = { deviceId: { exact: cameraId }, frameRate: { ideal: 60 } }
      if (resOpt.w) {
        constraints.width = { ideal: resOpt.w }
        constraints.height = { ideal: resOpt.h }
      } else if (cameraCaps) {
        constraints.width = { ideal: cameraCaps.maxW }
        constraints.height = { ideal: cameraCaps.maxH }
      }
      const stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false })
      return { stream, settings: stream.getVideoTracks()[0]?.getSettings() || null }
    } catch (e) {
      console.warn('camera unavailable:', e.message)
      return null
    }
  }

  function makeRecorder(stream, options, chunks) {
    const rec = new MediaRecorder(stream, options)
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.onstop = maybeFinalize
    return rec
  }

  function releaseStreams() {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    cameraStreamRef.current = null
  }

  async function startCapture() {
    const target = await nativeTarget()
    // Browser mode needs its screen stream up front: it *is* the video.
    const display = target ? null : await captureDisplayStream()
    const mic = await openMic()
    const cam = await openCamera()

    chunksRef.current = []
    cameraChunksRef.current = []
    let rec = null
    if (display) {
      mic?.getAudioTracks().forEach((t) => display.addTrack(t))
      const s = display.getVideoTracks()[0]?.getSettings() || {}
      rec = makeRecorder(display, { mimeType: pickVideoMimeType(), videoBitsPerSecond: bitrateFor(s.width, s.height) }, chunksRef.current)
    } else if (mic) {
      // Native mode: the video is recorded natively; only the mic is here.
      rec = makeRecorder(mic, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 192_000 }, chunksRef.current)
    }
    streamRef.current = display || mic
    recorderRef.current = rec
    cameraStreamRef.current = cam?.stream || null
    cameraRecorderRef.current = cam
      ? makeRecorder(
          cam.stream,
          {
            mimeType: pickVideoMimeType(),
            videoBitsPerSecond: 6_000_000 * (CAPTURE_QUALITIES.find((q) => q.id === captureQuality)?.mult || 1),
          },
          cameraChunksRef.current,
        )
      : null
    modeRef.current = target ? 'native' : 'browser'

    const cameraDevice = cameraId ? cameras.find((d) => d.deviceId === cameraId) : null
    let t0
    try {
      ;({ t0 } = await window.api.startRecording({
        sourceId: selected.id,
        name: selected.name,
        kind: selected.kind,
        display: selected.display,
        native: target
          ? { kind: target.kind, handle: target.handle, bitrate: bitrateFor(target.width, target.height) }
          : null,
        mic: !!mic,
        micLabel: mics.find((d) => d.deviceId === micId)?.label || null,
        projectName,
        cursorHidden: true,
        hideWindow: true,
      }))
    } catch (e) {
      releaseStreams()
      throw e
    }
    startedRef.current = performance.now()
    rec?.start(1000)
    cameraRecorderRef.current?.start(1000)
    // Date.now() is the clock both main's tracker (t0) and the native
    // module's frame-0 stamp are on, so this aligns mic/webcam/cursor.
    startWallRef.current = Date.now()
    offsetRef.current = Math.max(0, startWallRef.current - t0)
    cameraMetaRef.current = cameraDevice
      ? {
          deviceId: cameraDevice.deviceId,
          label: cameraDevice.label || 'Camera',
          width: cam?.settings?.width || null,
          height: cam?.settings?.height || null,
          mirror: true,
        }
      : null
    activeRef.current = true
    setState('recording')
  }

  // Uses refs only: it's also called from the global stop hotkey's handler,
  // which was registered once and would otherwise see stale state.
  function stop() {
    if (!activeRef.current) return
    activeRef.current = false
    setState('saving')
    const running = [recorderRef.current, cameraRecorderRef.current].filter((r) => r && r.state !== 'inactive')
    if (!running.length) {
      finalize()
      return
    }
    running.forEach((r) => r.stop())
  }

  // The recorders' 'stop' events land separately — finalize once none is running.
  function maybeFinalize() {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') return
    if (cameraRecorderRef.current && cameraRecorderRef.current.state !== 'inactive') return
    finalize()
  }

  async function finalize() {
    const settings = modeRef.current === 'browser' ? streamRef.current?.getVideoTracks()[0]?.getSettings() || {} : {}
    releaseStreams()

    const buffer = chunksRef.current.length ? await new Blob(chunksRef.current).arrayBuffer() : null
    const cameraBuffer = cameraChunksRef.current.length ? await new Blob(cameraChunksRef.current).arrayBuffer() : null
    try {
      const take = await window.api.finishRecording({
        buffer, // browser mode: screen video (+mic); native mode: mic only, or null
        durationMs: performance.now() - startedRef.current,
        videoSize: { width: settings.width || 1920, height: settings.height || 1080 },
        offsetMs: offsetRef.current,
        startWallMs: startWallRef.current,
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

  const micLabel = micId ? mics.find((d) => d.deviceId === micId)?.label || 'Microphone' : null
  const cameraLabel = cameraId ? cameras.find((d) => d.deviceId === cameraId)?.label || 'Camera' : null

  if (state === 'counting') return <CountdownScreen count={count} source={selected} mic={micLabel} camera={cameraLabel} />

  if (state === 'recording' || state === 'saving') {
    return (
      <RecordingScreen
        saving={state === 'saving'}
        startedAt={startedRef.current}
        source={selected}
        mic={micLabel}
        camera={cameraLabel}
        stopHotkey={platform.stopHotkey}
        onStop={stop}
      />
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
