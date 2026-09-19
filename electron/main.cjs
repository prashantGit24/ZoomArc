const { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, shell, globalShortcut, systemPreferences, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { MouseTracker } = require('./mouse-tracker.cjs')
const { ExportQueue } = require('./export-queue.cjs')
const { FORMATS, QUALITY_PRESETS, DEFAULT_QUALITY } = require('./exporter.cjs')

// Windows Graphics Capture fallback: only reached when getDisplayMedia's
// cursor:'never' constraint comes back unhonored (settings.cursor !== 'never'
// on the negotiated track) — see Recorder.jsx's captureStream(). Chromium's
// backend selection for that constraint isn't guaranteed on every Windows/GPU
// driver combination, so this talks to Windows.Graphics.Capture directly
// instead, where cursor exclusion is verified via IsCursorCaptureEnabled
// rather than hoped for. Optional at the module level: on any platform other
// than Windows, or a dev machine without the native addon built, this stays
// null and nativeCapture:isSupported simply reports false.
let wgcCapture = null
if (process.platform === 'win32') {
  try {
    wgcCapture = require('../native/wgc-capture')
  } catch (e) {
    console.warn('wgc-capture native addon not available:', e.message)
  }
}

const DEV_URL = process.env.VITE_DEV_SERVER_URL
let win = null
const tracker = new MouseTracker()
const exports_ = new ExportQueue()
exports_.on('changed', (list) => {
  if (win && !win.isDestroyed()) win.webContents.send('exports:changed', list)
})

// A project name is user-facing text that also seeds export filenames, so it is
// trimmed, length-capped and stripped of anything path-like.
// Windows forbids more than POSIX does: < > : " / \ | ? * plus the legacy
// device names, and it silently drops trailing dots and spaces. Sanitising to
// the strictest ruleset keeps one take portable across both platforms.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function cleanName(name, fallback = 'Recording') {
  let clean = String(name ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim()
  if (RESERVED.test(clean)) clean = `${clean} recording`
  return clean || fallback
}

// Everything for one take lives in its own folder: raw.webm + mouse.json
function newTakeDir() {
  const dir = path.join(app.getPath('userData'), 'takes', String(Date.now()))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0d10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // The packaged exe/app bundle gets its icon from build/icon.ico|icns via
    // electron-builder; this covers the window/taskbar icon in `npm run dev`,
    // where nothing has embedded one yet.
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (DEV_URL) win.loadURL(DEV_URL)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[diagnostic] renderer process gone:', JSON.stringify(details))
  })
  win.webContents.on('unresponsive', () => console.error('[diagnostic] renderer unresponsive'))
  win.webContents.on('responsive', () => console.error('[diagnostic] renderer responsive again'))
  win.on('closed', () => console.error('[diagnostic] main window closed'))
}

process.on('uncaughtException', (err) => {
  console.error('[diagnostic] uncaughtException in main process:', err.stack || err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[diagnostic] unhandledRejection in main process:', reason)
})
app.on('child-process-gone', (_e, details) => {
  console.error('[diagnostic] child process gone:', JSON.stringify(details))
})

// getDisplayMedia is the only capture path that can omit the system cursor, but
// it insists on a picker unless we answer the request ourselves. The renderer
// arms the source id first, so the user never sees a second chooser.
let armedSourceId = null
ipcMain.handle('capture:arm', (_e, sourceId) => {
  armedSourceId = sourceId
  return true
})

// Windows Graphics Capture fallback (see wgcCapture require above). Frames
// stream out via 'nativeCapture:frame' to whichever window started the
// capture, rather than a return value — MediaRecorder-speed delivery has no
// business going through ipcMain.handle's request/response round trip.
ipcMain.handle('nativeCapture:isSupported', () => !!wgcCapture?.isSupported())
ipcMain.handle('nativeCapture:listMonitors', () => wgcCapture?.listMonitors() || [])
ipcMain.handle('nativeCapture:start', (event, monitorHandle) => {
  if (!wgcCapture) throw new Error('Windows Graphics Capture is not available on this build')
  const sender = event.sender
  return wgcCapture.start(String(monitorHandle), (frame) => {
    if (!sender.isDestroyed()) sender.send('nativeCapture:frame', frame)
  })
})
ipcMain.handle('nativeCapture:startWindow', (event, hwnd) => {
  if (!wgcCapture) throw new Error('Windows Graphics Capture is not available on this build')
  const sender = event.sender
  return wgcCapture.startWindow(String(hwnd), (frame) => {
    if (!sender.isDestroyed()) sender.send('nativeCapture:frame', frame)
  })
})
ipcMain.handle('nativeCapture:stop', () => {
  wgcCapture?.stop()
  return true
})

app.whenReady().then(() => {
  exports_.attach()
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
      const source = sources.find((s) => s.id === armedSourceId) || sources[0]
      callback({ video: source })
    },
    { useSystemPicker: false },
  )
  createWindow()
})
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  exports_.shutdown()
})
app.on('window-all-closed', () => {
  tracker.stop()
  // Between two queued exports there is briefly no window at all, and closing
  // the editor mid-export must not kill the encode. Stay alive until the queue
  // drains; the queue quits us then (see below).
  if (process.platform !== 'darwin' && !exports_.hasPending()) app.quit()
})

exports_.on('changed', () => {
  if (
    process.platform !== 'darwin' &&
    !exports_.hasPending() &&
    BrowserWindow.getAllWindows().length === 0
  ) {
    app.quit()
  }
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

/* ---------------------------------------------------------------- sources */

// macOS gates both of these behind Privacy & Security; report status so the UI
// can explain what to grant instead of failing with an opaque error.
ipcMain.handle('permissions:check', () => {
  if (process.platform !== 'darwin') return { screen: 'granted', accessibility: true }
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  }
})

ipcMain.handle('permissions:open', (_e, kind) => {
  if (process.platform === 'darwin') {
    const pane = kind === 'accessibility' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture'
    return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
  }
  // Windows has no capture permission to grant; this is only ever reached if a
  // user goes looking, so send them somewhere sensible rather than nowhere.
  if (process.platform === 'win32') return shell.openExternal('ms-settings:privacy')
  return false
})

ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 480, height: 300 },
    fetchWindowIcons: false,
  })
  const displays = screen.getAllDisplays()
  return sources.map((s) => {
    // display_id lets us map global cursor coords into this source's pixel space
    const display = displays.find((d) => String(d.id) === String(s.display_id))
    return {
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? 'screen' : 'window',
      thumbnail: s.thumbnail.toDataURL(),
      display: display
        ? { bounds: display.bounds, scaleFactor: display.scaleFactor }
        : null,
    }
  })
})

/* -------------------------------------------------------------- recording */

let take = null

const STOP_HOTKEY = 'CommandOrControl+Shift+2'
// Rendered in the UI, so it has to read the way each platform writes it.
const STOP_HOTKEY_LABEL = process.platform === 'darwin' ? '⌘⇧2' : 'Ctrl+Shift+2'

ipcMain.handle('app:platform', () => ({
  platform: process.platform,
  stopHotkey: STOP_HOTKEY_LABEL,
}))

function armStopHotkey() {
  globalShortcut.unregister(STOP_HOTKEY)
  globalShortcut.register(STOP_HOTKEY, () => win?.webContents.send('record:stop-hotkey'))
}

ipcMain.handle('record:start', (_e, meta) => {
  take = { dir: newTakeDir(), startedAt: Date.now(), meta }
  tracker.start()
  armStopHotkey()
  // Get the app out of the shot; the hotkey brings the session back.
  if (meta?.hideWindow !== false) win?.minimize()
  // take.startedAt is also the tracker's own zero (see MouseTracker.start).
  // The renderer doesn't actually start encoding until some time after this
  // handler returns (IPC round trip, MediaRecorder.start()), so it hands that
  // real gap back at record:finish as offsetMs — without it, mouse timestamps
  // are zeroed too early and every effect that follows the cursor reads stale,
  // "delayed" positions relative to the video.
  return { dir: take.dir, stopHotkey: STOP_HOTKEY, t0: take.startedAt }
})

ipcMain.handle('record:cancel', () => {
  tracker.stop()
  globalShortcut.unregister(STOP_HOTKEY)
  win?.restore()
  if (take) fs.rmSync(take.dir, { recursive: true, force: true })
  take = null
  return true
})

// Renderer hands back the recorded blob; we pair it with the mouse track.
ipcMain.handle('record:finish', async (_e, { buffer, durationMs, videoSize, offsetMs, cameraBuffer, camera }) => {
  if (!take) throw new Error('no active take')
  const rawEvents = tracker.stop()
  globalShortcut.unregister(STOP_HOTKEY)
  win?.restore()
  win?.focus()

  const videoPath = path.join(take.dir, 'raw.webm')
  fs.writeFileSync(videoPath, Buffer.from(buffer))

  // The webcam recording is a separate file (not composited in yet) so the
  // editor can reposition/restyle the pill without ever re-encoding the
  // screen capture. Same-length, same start time as the main recording.
  let cameraPath = null
  if (cameraBuffer) {
    cameraPath = path.join(take.dir, 'camera.webm')
    fs.writeFileSync(cameraPath, Buffer.from(cameraBuffer))
  }

  // The tracker's clock (t0 = take.startedAt) starts before the video actually
  // does — offsetMs is that gap, measured by the renderer. Re-zero events onto
  // the video's own timeline so a sample at video-time t reads the mouse
  // position from the same real instant, instead of one `offsetMs` stale.
  const shift = Math.max(0, Math.round(offsetMs) || 0)
  const shifted = rawEvents.map((e) => ({ ...e, t: e.t - shift }))
  const events = shifted.filter((e) => e.t >= 0)
  // Pre-roll (captured before the video actually started) is discarded, but
  // the cursor's last known position from it has to survive as the state at
  // t=0 — otherwise the path holds at wherever the first post-roll move
  // happens to be instead of where the pointer actually was when frame 0 hit.
  const lastPreRollMove = [...shifted].reverse().find((e) => e.t < 0 && e.type === 'move')
  if (lastPreRollMove) events.unshift({ ...lastPreRollMove, t: 0 })

  const track = {
    version: 1,
    name: cleanName(take.meta?.projectName, defaultTakeName(take.startedAt)),
    // Measured, not assumed: see MouseTracker.probeScale.
    pointerScale: tracker.getPointerScale(),
    startedAt: take.startedAt,
    durationMs,
    videoSize,
    source: take.meta,
    camera: cameraPath ? camera || {} : null, // { deviceId, label, width, height }
    events, // [{ t, x, y, type }] t = ms since the video's own start
  }
  fs.writeFileSync(path.join(take.dir, 'mouse.json'), JSON.stringify(track))

  const result = { dir: take.dir, videoPath, cameraPath, track }
  take = null
  return result
})

/* ----------------------------------------------------------------- takes */

// Older takes predate named projects; fall back to a stable timestamp name.
function defaultTakeName(startedAt) {
  const d = new Date(startedAt || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`
}

ipcMain.handle('takes:rename', (_e, dir, name) => {
  const file = path.join(dir, 'mouse.json')
  // A take can vanish underneath a listing the window is still showing, so say
  // so plainly instead of surfacing a raw ENOENT from deep in the handler.
  if (!fs.existsSync(file)) {
    const err = new Error('That recording is no longer on disk.')
    err.code = 'TAKE_MISSING'
    throw err
  }
  const track = JSON.parse(fs.readFileSync(file, 'utf8'))
  track.name = cleanName(name, track.name || defaultTakeName(track.startedAt))
  // Write via a temp file so a crash mid-write can't leave an unreadable take.
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(track))
  fs.renameSync(tmp, file)
  return track.name
})

function takesRoot() {
  return path.join(app.getPath('userData'), 'takes')
}

ipcMain.handle('takes:list', async () => {
  const root = takesRoot()
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((dir) => fs.existsSync(path.join(dir, 'raw.webm')))
    .sort()
    .reverse()
    .map((dir) => {
      const track = JSON.parse(fs.readFileSync(path.join(dir, 'mouse.json'), 'utf8'))
      track.name = track.name || defaultTakeName(track.startedAt)
      const cameraFile = path.join(dir, 'camera.webm')
      return {
        dir,
        videoPath: path.join(dir, 'raw.webm'),
        cameraPath: fs.existsSync(cameraFile) ? cameraFile : null,
        track,
      }
    })
})

// The editor loads the take as a blob URL so <video> can seek frame-accurately.
ipcMain.handle('takes:read', async (_e, videoPath) => fs.readFileSync(videoPath).buffer)

ipcMain.handle('takes:load', async (_e, dir) => {
  const track = JSON.parse(fs.readFileSync(path.join(dir, 'mouse.json'), 'utf8'))
  track.name = track.name || defaultTakeName(track.startedAt)
  const cameraFile = path.join(dir, 'camera.webm')
  return {
    dir,
    videoPath: path.join(dir, 'raw.webm'),
    cameraPath: fs.existsSync(cameraFile) ? cameraFile : null,
    track,
  }
})

// Permanent — the renderer is the one that holds the take on screen for an
// undo window before ever calling this, so there is no grace period here.
ipcMain.handle('takes:delete', (_e, dir) => {
  // Guard against deleting anything outside the takes root, in case a stale
  // or forged path ever reaches this handler.
  const root = takesRoot()
  const resolved = path.resolve(dir)
  if (path.relative(root, resolved).startsWith('..')) {
    throw new Error('Refusing to delete a path outside the takes folder.')
  }
  fs.rmSync(resolved, { recursive: true, force: true })
  return true
})

ipcMain.handle('takes:revealRoot', () => {
  const root = takesRoot()
  fs.mkdirSync(root, { recursive: true })
  return shell.openPath(root)
})

/* ---------------------------------------------------------------- export */

let exporter = null

/* ----------------------------------------------------------------- export */

// Export is queued and runs in a hidden window, so the editor stays usable and
// a job outlives navigating away from (or closing) the take being exported.
ipcMain.handle('exports:formats', () =>
  Object.entries(FORMATS).map(([id, f]) => ({
    id,
    label: f.label,
    ext: f.ext,
    alpha: !!f.alpha,
    sequence: !!f.sequence,
  })),
)

// mp4/webm are the only formats a quality preset actually changes anything
// for (mov/mkv are pinned lossless) — exposed anyway as one flat list since
// the picker only needs to disable itself, not know which formats care.
ipcMain.handle('exports:qualities', () => ({
  presets: Object.values(QUALITY_PRESETS).map((q) => ({ id: q.id, label: q.label })),
  default: DEFAULT_QUALITY,
  tunableFormats: Object.entries(FORMATS).filter(([, f]) => !f.sequence && f.ext !== 'mov' && f.ext !== 'mkv').map(([id]) => id),
}))

ipcMain.handle('exports:enqueue', async (_e, job) => {
  const fmt = FORMATS[job.format] || FORMATS.mp4
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export recording',
    defaultPath: path.join(
      app.getPath('videos') || os.homedir(),
      `${cleanName(job.name, 'recording')}${fmt.sequence ? '' : `.${fmt.ext}`}`,
    ),
    // A sequence needs a folder to fill, not a single file to overwrite.
    filters: fmt.sequence ? [] : [{ name: fmt.label, extensions: [fmt.ext] }],
    buttonLabel: fmt.sequence ? 'Create folder' : 'Export',
  })
  if (canceled || !filePath) return { canceled: true }
  return { canceled: false, outPath: filePath, ...exports_.add({ ...job, outPath: filePath }) }
})

ipcMain.handle('exports:list', () => exports_.list())
ipcMain.handle('exports:cancel', (_e, id) => exports_.cancel(id))
ipcMain.handle('exports:clear', () => exports_.clearFinished())

ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p))
