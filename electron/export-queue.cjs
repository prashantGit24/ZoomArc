const { BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { exportVideo, FORMATS } = require('./exporter.cjs')

const DEV_URL = process.env.VITE_DEV_SERVER_URL

let seq = 0
const nextId = () => `x${Date.now().toString(36)}${(seq++).toString(36)}`

/**
 * Runs export jobs off the visible window. Each job renders in its own hidden
 * BrowserWindow and streams lossless PNG frames to a dedicated ffmpeg process,
 * so the editor stays interactive and a job survives navigating away from the take.
 *
 * Jobs run one at a time: encoding is already CPU-saturating, and running two
 * only makes both slower while multiplying decode memory.
 */
class ExportQueue extends EventEmitter {
  constructor() {
    super()
    this.jobs = []
    this.running = null
    this.wired = false
  }

  /** Public snapshot — deliberately excludes the heavy project/track payloads. */
  list() {
    return this.jobs.map((j) => ({
      id: j.id,
      name: j.name,
      outPath: j.outPath,
      format: j.format || 'mp4',
      state: j.state,
      done: j.done,
      total: j.total,
      error: j.error || null,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt || null,
    }))
  }

  /** True while any job still needs the app alive. */
  hasPending() {
    return this.jobs.some((j) => j.state === 'queued' || j.state === 'rendering')
  }

  changed() {
    this.emit('changed', this.list())
  }

  add(job) {
    const entry = {
      ...job,
      id: nextId(),
      state: 'queued',
      done: 0,
      total: Math.max(1, Math.ceil((job.durationSec || 0) * job.fps)),
      startedAt: Date.now(),
      window: null,
      encoder: null,
      cancelRequested: false,
    }
    this.jobs.push(entry)
    this.changed()
    this.pump()
    return { id: entry.id }
  }

  cancel(id) {
    const job = this.jobs.find((j) => j.id === id)
    if (!job || job.state === 'done' || job.state === 'failed' || job.state === 'canceled') return false
    job.cancelRequested = true
    if (job.state === 'queued') {
      job.state = 'canceled'
      job.finishedAt = Date.now()
      this.changed()
      return true
    }
    // Ask the worker to stop at the next frame boundary; teardown happens there.
    job.window?.webContents.send('exportjob:cancel')
    return true
  }

  /** Drops finished entries from the list; running jobs are left alone. */
  clearFinished() {
    this.jobs = this.jobs.filter((j) => !['done', 'failed', 'canceled'].includes(j.state))
    this.changed()
  }

  pump() {
    if (this.running) return
    const next = this.jobs.find((j) => j.state === 'queued')
    if (!next) return
    this.running = next
    this.start(next).catch((err) => this.settle(next, 'failed', err.message))
  }

  async start(job) {
    job.state = 'rendering'
    this.changed()

    job.encoder = exportVideo({
      outPath: job.outPath,
      fps: job.fps,
      width: job.width,
      height: job.height,
      audioPath: job.audioPath,
      format: job.format,
      quality: job.quality,
    })

    const worker = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        preload: path.join(__dirname, 'export-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        // A hidden window is throttled to ~1fps by default, which would stall
        // the render loop; the whole point here is to run at full speed.
        backgroundThrottling: false,
        additionalArguments: [`--job-id=${job.id}`],
        offscreen: false,
      },
    })
    job.window = worker

    // A worker that can't even load its page would otherwise hang the queue.
    worker.webContents.on('did-fail-load', (_e, code, desc) =>
      this.settle(job, 'failed', `export worker failed to load (${code} ${desc})`),
    )
    worker.webContents.on('console-message', (_e, _level, message) => {
      if (process.env.EXPORT_DEBUG) console.log('[export worker]', message)
    })

    worker.on('closed', () => {
      job.window = null
      // Closing before the job settled means something killed it out from under us.
      if (job.state === 'rendering') this.settle(job, 'failed', 'export worker closed unexpectedly')
    })

    if (DEV_URL) await worker.loadURL(new URL('export.html', DEV_URL).href)
    else await worker.loadFile(path.join(__dirname, '..', 'dist', 'export.html'))
  }

  /** Wires the worker->main channels once; jobs are matched by id. */
  attach(ipc = ipcMain) {
    if (this.wired) return
    this.wired = true

    const find = (id) => this.jobs.find((j) => j.id === id) || null

    ipc.on('exportjob:ready', (_e, id) => {
      const job = find(id)
      if (!job || !job.window) return
      job.window.webContents.send('exportjob:start', {
        videoPath: job.videoPath,
        cameraVideoPath: job.cameraVideoPath || null,
        track: job.track,
        project: job.project,
        fps: job.fps,
        width: job.width,
        height: job.height,
        frameType: (FORMATS[job.format] || FORMATS.mp4).frameType,
      })
    })

    ipc.handle('exportjob:frame', async (_e, id, buffer) => {
      const job = find(id)
      if (!job?.encoder) throw new Error('no such export job')
      await job.encoder.writeFrame(Buffer.from(buffer))
      job.done += 1
      return true
    })

    ipc.on('exportjob:progress', (_e, id, done, total) => {
      const job = find(id)
      if (!job) return
      job.done = done
      job.total = total
      this.changed()
    })

    ipc.on('exportjob:done', async (_e, id) => {
      const job = find(id)
      if (!job) return
      try {
        await job.encoder.finish()
        this.settle(job, 'done')
      } catch (err) {
        this.settle(job, 'failed', err.message)
      }
    })

    ipc.on('exportjob:canceled', (_e, id) => {
      const job = find(id)
      if (job) this.settle(job, 'canceled')
    })

    ipc.on('exportjob:failed', (_e, id, message) => {
      const job = find(id)
      if (job) this.settle(job, 'failed', message)
    })
  }

  settle(job, state, error) {
    if (['done', 'failed', 'canceled'].includes(job.state)) return
    job.state = state
    job.error = error || null
    job.finishedAt = Date.now()

    // A partial file is worse than none: abort discards it.
    if (state !== 'done') job.encoder?.abort().catch(() => {})
    job.encoder = null

    const w = job.window
    job.window = null

    if (this.running === job) this.running = null
    this.changed()

    // Teardown and starting the next job are deferred off the current event:
    // settle() is reached from webContents callbacks, and destroying a window
    // (or creating one) inside its own event crashes the renderer with SIGTRAP.
    setImmediate(() => {
      if (w && !w.isDestroyed()) w.destroy()
      this.pump()
    })
  }

  shutdown() {
    for (const job of this.jobs) {
      if (job.state === 'rendering' || job.state === 'queued') this.settle(job, 'canceled')
    }
  }
}

module.exports = { ExportQueue }
