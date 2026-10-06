const { app, BrowserWindow, Menu, nativeImage, ipcMain, desktopCapturer, screen, dialog, shell, globalShortcut, systemPreferences, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { MouseTracker } = require('./mouse-tracker.cjs')
const { ExportQueue } = require('./export-queue.cjs')
const { FORMATS, QUALITY_PRESETS, DEFAULT_QUALITY, resolveFfmpeg } = require('./exporter.cjs')
const { spawn } = require('node:child_process')

// Native Windows recording (Windows.Graphics.Capture -> hardware H.264, plus a
// cursor sampler on the same clock). The primary path on Windows; elsewhere,
// or without the addon built, this stays null and the renderer falls back to
// getDisplayMedia + the uiohook MouseTracker.
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

// Everything for one take lives in its own folder: raw.mp4 (or raw.webm) + mouse.json
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
      // The window is minimized while recording, but this renderer is what
      // draws native frames into the recorded canvas — throttled, frames pile
      // up and the video lags the cursor by hundreds of ms.
      backgroundThrottling: false,
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

// Native Windows recording (native/wgc-capture): the capture module records
// straight to a hardware-encoded MP4 and samples the system cursor on the same
// clock, so nothing frame-sized ever crosses into JS.
ipcMain.handle('nativeCapture:isSupported', () => !!wgcCapture?.isSupported())
ipcMain.handle('nativeCapture:listMonitors', () => wgcCapture?.listMonitors() || [])
ipcMain.handle('nativeCapture:getWindowBounds', (_e, hwnd) => wgcCapture?.getWindowBounds(String(hwnd)) || { ok: false })

const REPO_URL = 'https://github.com/prashantGit24/ZoomArc'

// Electron's default menu, except Help: that one pointed at electronjs.org.
function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: () => win?.webContents.send('help:shortcuts'),
        },
        { type: 'separator' },
        { label: 'ZoomArc on GitHub', click: () => shell.openExternal(REPO_URL) },
        { label: "What's New (Changelog)", click: () => shell.openExternal(`${REPO_URL}/blob/main/CHANGELOG.md`) },
        { label: 'Report an Issue', click: () => shell.openExternal(`${REPO_URL}/issues`) },
        ...(isMac
          ? []
          : [
              { type: 'separator' },
              {
                label: 'About ZoomArc',
                click: () =>
                  dialog.showMessageBox(win, {
                    type: 'info',
                    title: 'About ZoomArc',
                    message: `ZoomArc ${app.getVersion()}`,
                    detail: `Screen recorder with cursor-driven zoom.\n\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
                  }),
              },
            ]),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  buildMenu()
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

// A preview grabbed by the native module, for monitors Chromium can't see.
async function nativeThumbnail(handle) {
  try {
    const t = await wgcCapture.captureMonitorThumbnail(String(handle), 480)
    if (!t) return null
    return nativeImage.createFromBitmap(t.bgra, { width: t.width, height: t.height }).toDataURL()
  } catch (e) {
    console.warn('monitor preview failed:', e.message)
    return null
  }
}

ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 480, height: 300 },
    fetchWindowIcons: false,
  })
  const displays = screen.getAllDisplays()
  const list = sources.map((s) => {
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
  if (!wgcCapture?.isSupported()) return list

  // Chromium's screen list can miss monitors outright (on hybrid-GPU laptops
  // it only sees one GPU's outputs), so with native capture the monitors come
  // from Windows itself; Chromium's entry only lends its thumbnail.
  const chromiumScreens = list.filter((s) => s.kind === 'screen')
  const monitors = wgcCapture.listMonitors().sort((a, b) => b.primary - a.primary)
  const screens = await Promise.all(monitors.map(async (m, i) => {
    const display = displays.reduce((best, d) => {
      const dist = (x) => Math.abs(Math.round(x.bounds.x * x.scaleFactor) - m.x) + Math.abs(Math.round(x.bounds.y * x.scaleFactor) - m.y)
      return !best || dist(d) < dist(best) ? d : best
    }, null)
    const chromium = chromiumScreens.find(
      (s) => display && s.display && s.display.bounds.x === display.bounds.x && s.display.bounds.y === display.bounds.y,
    )
    return {
      id: chromium?.id || `monitor:${m.handle}`,
      name: m.primary ? 'Main display' : `Display ${i + 1}`,
      kind: 'screen',
      thumbnail: chromium?.thumbnail || (await nativeThumbnail(m.handle)),
      display: display ? { bounds: display.bounds, scaleFactor: display.scaleFactor } : null,
      monitor: m.handle,
    }
  }))
  return [...screens, ...list.filter((s) => s.kind !== 'screen')]
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

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(resolveFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true })
    let stderr = ''
    p.stderr.on('data', (d) => (stderr += d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-500)}`))))
  })
}

// Positive: the input started that many seconds after video frame 0.
const offsetArgs = (sec) => (sec > 0.005 ? ['-itsoffset', sec.toFixed(3)] : sec < -0.005 ? ['-ss', (-sec).toFixed(3)] : [])

ipcMain.handle('record:start', async (_e, meta) => {
  take = { dir: newTakeDir(), startedAt: Date.now(), meta }
  armStopHotkey()
  // Get the app out of the shot; the hotkey brings the session back.
  if (meta?.hideWindow !== false) win?.minimize()

  if (meta?.native && wgcCapture) {
    // Native capture starts immediately, so let the minimize animation finish
    // first or it ends up in the opening frames.
    if (meta.hideWindow !== false) await delay(300)
    const { kind, handle, bitrate } = meta.native
    const monitor = kind === 'monitor' ? wgcCapture.listMonitors().find((m) => m.handle === String(handle)) : null
    try {
      const size = wgcCapture.startRecording({
        kind,
        handle: String(handle),
        path: path.join(take.dir, 'video.mp4'),
        bitrate,
        fps: 60,
      })
      take.native = { kind, width: size.width, height: size.height, origin: monitor ? { x: monitor.x, y: monitor.y } : null }
    } catch (e) {
      globalShortcut.unregister(STOP_HOTKEY)
      win?.restore()
      fs.rmSync(take.dir, { recursive: true, force: true })
      take = null
      throw e
    }
    return { dir: take.dir, stopHotkey: STOP_HOTKEY, t0: take.startedAt }
  }

  tracker.start()
  // take.startedAt is also the tracker's own zero (see MouseTracker.start).
  // The renderer starts encoding some time after this returns; it hands that
  // gap back at record:finish as offsetMs.
  return { dir: take.dir, stopHotkey: STOP_HOTKEY, t0: take.startedAt }
})

ipcMain.handle('record:cancel', async () => {
  globalShortcut.unregister(STOP_HOTKEY)
  win?.restore()
  if (take?.native) await wgcCapture.stopRecording().catch(() => {})
  else tracker.stop()
  if (take) fs.rmSync(take.dir, { recursive: true, force: true })
  take = null
  return true
})

// Renderer hands back what it recorded (screen video in browser mode, or just
// the mic in native mode, plus the webcam); we pair it with the cursor track.
ipcMain.handle('record:finish', async (_e, payload) => {
  if (!take) throw new Error('no active take')
  const current = take
  take = null
  globalShortcut.unregister(STOP_HOTKEY)
  try {
    return current.native ? await finishNative(current, payload) : finishBrowser(current, payload)
  } finally {
    win?.restore()
    win?.focus()
  }
})

async function finishNative(t, { buffer, startWallMs, cameraBuffer, camera }) {
  const res = await wgcCapture.stopRecording()
  if (!res.ok) throw new Error(res.error || 'The recording failed')

  const video = path.join(t.dir, 'video.mp4')
  const videoPath = path.join(t.dir, 'raw.mp4')
  // Mic and webcam were started (on the Date.now() clock) a moment after
  // frame 0; offsetting them by exactly that keeps them in sync with the video.
  const startOffset = startWallMs ? (startWallMs - res.firstFrameWallMs) / 1000 : 0
  if (buffer) {
    const mic = path.join(t.dir, 'mic.webm')
    fs.writeFileSync(mic, Buffer.from(buffer))
    await runFfmpeg([
      '-i', video, ...offsetArgs(startOffset), '-i', mic,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart', videoPath,
    ])
    fs.rmSync(mic, { force: true })
    fs.rmSync(video, { force: true })
  } else {
    fs.renameSync(video, videoPath)
  }

  let cameraPath = null
  if (cameraBuffer) {
    cameraPath = path.join(t.dir, 'camera.webm')
    const rawCam = path.join(t.dir, 'camera-raw.webm')
    fs.writeFileSync(rawCam, Buffer.from(cameraBuffer))
    try {
      await runFfmpeg([...offsetArgs(startOffset), '-i', rawCam, '-c', 'copy', cameraPath])
      fs.rmSync(rawCam, { force: true })
    } catch (e) {
      console.warn('camera alignment failed, keeping it unshifted:', e.message)
      fs.renameSync(rawCam, cameraPath)
    }
  }

  const track = {
    version: 2,
    // Cursor and video share one clock: event t is milliseconds on the
    // video's own timeline, no offset estimation involved.
    clock: 'native',
    name: cleanName(t.meta?.projectName, defaultTakeName(t.startedAt)),
    startedAt: t.startedAt,
    durationMs: res.durationMs,
    videoSize: { width: res.width, height: res.height },
    // Physical pixels: event x/y map to video pixels as (x - origin) / size.
    // A window's origin moves with it, carried by 'bounds' events instead.
    capture: { kind: t.native.kind, origin: t.native.origin, width: res.width, height: res.height },
    stats: { frames: res.frames, delivered: res.arrivals, cursorPolls: res.cursorPolls },
    source: t.meta,
    camera: cameraPath ? camera || {} : null,
    events: res.cursor,
  }
  fs.writeFileSync(path.join(t.dir, 'mouse.json'), JSON.stringify(track))
  return { dir: t.dir, videoPath, cameraPath, track }
}

function finishBrowser(t, { buffer, durationMs, videoSize, offsetMs, cameraBuffer, camera }) {
  const rawEvents = tracker.stop()
  const videoPath = path.join(t.dir, 'raw.webm')
  fs.writeFileSync(videoPath, Buffer.from(buffer))

  let cameraPath = null
  if (cameraBuffer) {
    cameraPath = path.join(t.dir, 'camera.webm')
    fs.writeFileSync(cameraPath, Buffer.from(cameraBuffer))
  }

  // The tracker's clock (t0 = take.startedAt) starts before the video does;
  // offsetMs is that gap, so re-zero events onto the video's own timeline.
  const shift = Math.max(0, Math.round(offsetMs) || 0)
  const shifted = rawEvents.map((e) => ({ ...e, t: e.t - shift }))
  const events = shifted.filter((e) => e.t >= 0)
  // Keep the cursor's last pre-roll position as its state at t=0.
  const lastPreRollMove = [...shifted].reverse().find((e) => e.t < 0 && e.type === 'move')
  if (lastPreRollMove) events.unshift({ ...lastPreRollMove, t: 0 })

  const track = {
    version: 1,
    name: cleanName(t.meta?.projectName, defaultTakeName(t.startedAt)),
    pointerScale: tracker.getPointerScale(),
    startedAt: t.startedAt,
    durationMs,
    videoSize,
    source: t.meta,
    camera: cameraPath ? camera || {} : null,
    events, // [{ t, x, y, type }] t = ms since the video's own start
  }
  fs.writeFileSync(path.join(t.dir, 'mouse.json'), JSON.stringify(track))
  return { dir: t.dir, videoPath, cameraPath, track }
}

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

// Native takes are raw.mp4 (hardware H.264); browser-path takes are raw.webm.
function takeVideo(dir) {
  const mp4 = path.join(dir, 'raw.mp4')
  return fs.existsSync(mp4) ? mp4 : path.join(dir, 'raw.webm')
}

function takesRoot() {
  return path.join(app.getPath('userData'), 'takes')
}

ipcMain.handle('takes:list', async () => {
  const root = takesRoot()
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((dir) => fs.existsSync(takeVideo(dir)) && fs.existsSync(path.join(dir, 'mouse.json')))
    .sort()
    .reverse()
    .map((dir) => {
      const track = JSON.parse(fs.readFileSync(path.join(dir, 'mouse.json'), 'utf8'))
      track.name = track.name || defaultTakeName(track.startedAt)
      const cameraFile = path.join(dir, 'camera.webm')
      return {
        dir,
        videoPath: takeVideo(dir),
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
    videoPath: takeVideo(dir),
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
