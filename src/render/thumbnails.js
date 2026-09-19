/**
 * Captures a handful of frames spread across a recording, for the Video/
 * Camera tracks' filmstrip in the timeline. Runs on its own throwaway
 * <video> element (not the editor's live-preview one) so scrubbing through
 * timestamps to grab frames never visibly flashes the actual preview.
 */

function seekAndCapture(video, ctx, w, h, t) {
  return new Promise((resolve) => {
    // Setting currentTime to (essentially) where it already is — typically
    // just the very first frame, right after load — fires no 'seeked'
    // event at all, so waiting for one here would hang forever.
    if (Math.abs(video.currentTime - t) < 0.01) {
      ctx.drawImage(video, 0, 0, w, h)
      resolve()
      return
    }
    const done = () => {
      video.removeEventListener('seeked', done)
      ctx.drawImage(video, 0, 0, w, h)
      resolve()
    }
    video.addEventListener('seeked', done)
    video.currentTime = t
  })
}

/**
 * Resolves to an array of `{ t, src }` (t in seconds, src a small JPEG data
 * URL) spread evenly across [0, duration], oldest-to-newest — or `[]` on
 * any decode failure, so a caller can just skip drawing a filmstrip rather
 * than special-case an error.
 */
export async function generateThumbnails(url, duration, { count, width = 160 } = {}) {
  if (!url || !duration || duration <= 0) return []
  const n = count ?? Math.min(24, Math.max(6, Math.round(duration / 3)))

  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'

  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve
      video.onerror = () => reject(new Error('could not decode video for thumbnails'))
      video.src = url
    })

    const height = Math.max(1, Math.round(width * ((video.videoHeight || 9) / (video.videoWidth || 16))))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')

    const thumbs = []
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : (i / (n - 1)) * Math.max(0, duration - 0.05)
      await seekAndCapture(video, ctx, width, height, t)
      thumbs.push({ t, src: canvas.toDataURL('image/jpeg', 0.55) })
    }
    return thumbs
  } catch {
    return []
  } finally {
    video.src = ''
  }
}
