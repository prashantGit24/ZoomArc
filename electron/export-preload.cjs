const { contextBridge, ipcRenderer } = require('electron')

// The job id is baked in at window creation so a worker can only ever report
// against its own job.
const jobId = process.argv.find((a) => a.startsWith('--job-id='))?.slice('--job-id='.length)

contextBridge.exposeInMainWorld('exportHost', {
  ready: () => ipcRenderer.send('exportjob:ready', jobId),
  onJob: (cb) => ipcRenderer.on('exportjob:start', (_e, job) => cb(job)),
  onCancel: (cb) => ipcRenderer.on('exportjob:cancel', () => cb()),
  readVideo: (p) => ipcRenderer.invoke('takes:read', p),
  // Awaited, so ffmpeg's backpressure reaches all the way back to the renderer.
  frame: (buffer) => ipcRenderer.invoke('exportjob:frame', jobId, buffer),
  progress: (done, total) => ipcRenderer.send('exportjob:progress', jobId, done, total),
  done: () => ipcRenderer.send('exportjob:done', jobId),
  canceled: () => ipcRenderer.send('exportjob:canceled', jobId),
  failed: (message) => ipcRenderer.send('exportjob:failed', jobId, message),
})
