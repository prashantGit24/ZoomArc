/**
 * Runs inside a hidden BrowserWindow, one per export job. It owns its own
 * <video> decode and canvas, so a long export never competes with the editor
 * window for the main thread — close the editor mid-export and this keeps going.
 */
import { loadVideo, renderAllFrames } from '../render/renderJob.js'

const videoMime = (p) => (/\.mp4$/i.test(p) ? 'video/mp4' : 'video/webm')

let canceled = false
window.exportHost.onCancel(() => {
  canceled = true
})

window.exportHost.onJob(async (job) => {
  const urls = []
  try {
    const buffer = await window.exportHost.readVideo(job.videoPath)
    const url = URL.createObjectURL(new Blob([buffer], { type: videoMime(job.videoPath) }))
    urls.push(url)
    const video = await loadVideo(url)

    let cameraVideo = null
    if (job.cameraVideoPath) {
      const camBuffer = await window.exportHost.readVideo(job.cameraVideoPath)
      const camUrl = URL.createObjectURL(new Blob([camBuffer], { type: videoMime(job.cameraVideoPath) }))
      urls.push(camUrl)
      cameraVideo = await loadVideo(camUrl)
    }

    const result = await renderAllFrames({
      video,
      cameraVideo,
      track: job.track,
      project: job.project,
      fps: job.fps,
      width: job.width,
      height: job.height,
      frameType: job.frameType,
      onFrame: (buf) => window.exportHost.frame(buf),
      onProgress: (done, total) => window.exportHost.progress(done, total),
      shouldStop: () => canceled,
    })

    urls.forEach((u) => URL.revokeObjectURL(u))
    if (result.canceled) window.exportHost.canceled()
    else window.exportHost.done()
  } catch (err) {
    urls.forEach((u) => URL.revokeObjectURL(u))
    window.exportHost.failed(err?.message || String(err))
  }
})

window.exportHost.ready()
