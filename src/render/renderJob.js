/**
 * Frame-accurate render of a whole take. Shared by the background export
 * worker so the encoded output is produced by exactly the same code path as
 * the editor preview — there is no second implementation to drift.
 */
import { buildMousePath } from './track.js'
import { renderFrame, clipTimeAt } from './renderFrame.js'

export function seekVideo(video, t) {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('seeked', done)
      resolve()
    }
    video.addEventListener('seeked', done)
    video.currentTime = t
  })
}

// Backgrounds arrive as data URLs (blob URLs are per-window and would 404 here).
export async function loadImages(project) {
  const images = new Map()
  const srcs = new Set()
  if (project.background?.type === 'image') srcs.add(project.background.src)
  for (const c of project.backgroundClips || []) {
    if (c.bg?.type === 'image') srcs.add(c.bg.src)
  }
  for (const el of project.elements || []) {
    if (el.src) srcs.add(el.src)
  }
  await Promise.all(
    [...srcs].filter(Boolean).map(
      (src) =>
        new Promise((resolve) => {
          const img = new Image()
          img.onload = () => {
            images.set(src, img)
            resolve()
          }
          img.onerror = () => resolve() // paintBackground already falls back
          img.src = src
        }),
    ),
  )
  return images
}

export function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.onloadeddata = () => resolve(video)
    video.onerror = () => reject(new Error('could not decode the recording'))
    video.src = url
  })
}

/**
 * Renders every frame in order, handing each encoded JPEG to `onFrame`.
 * `onFrame` is awaited, which is what applies encoder backpressure.
 */
export async function renderAllFrames({ video, cameraVideo, track, project, fps, width, height, frameType = 'image/jpeg', onFrame, onProgress, shouldStop }) {
  const path = buildMousePath(track)
  const duration = path.duration || (track.durationMs || 0) / 1000
  const total = Math.max(1, Math.ceil(duration * fps))
  const images = await loadImages(project)

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')

  for (let i = 0; i < total; i++) {
    if (shouldStop?.()) return { total, done: i, canceled: true }
    const t = i / fps
    // Each track's clips (trimmed/split/moved in the editor) map timeline
    // time to a moment in that recording — null where a gap leaves nothing
    // to seek to, so it's simply left wherever it last was (renderFrame
    // won't draw it there anyway).
    const videoAt = clipTimeAt(t, project.videoClips)
    const cameraAt = clipTimeAt(t, project.cameraClips)
    await Promise.all(
      [videoAt != null && seekVideo(video, videoAt), cameraVideo && cameraAt != null && seekVideo(cameraVideo, cameraAt)].filter(Boolean),
    )
    renderFrame(ctx, {
      source: video,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      cameraSource: cameraVideo,
      t,
      project,
      path,
      width,
      height,
      images,
    })
    // PNG for alpha formats (JPEG would flatten transparency to black).
    const blob = await canvas.convertToBlob(
      frameType === 'image/png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.95 },
    )
    await onFrame(await blob.arrayBuffer())
    if (i % 5 === 0 || i === total - 1) onProgress?.(i + 1, total)
  }
  return { total, done: total, canceled: false }
}
