/**
 * Downsamples a decoded audio buffer into [min, max] peak pairs, one per
 * bin, spread evenly across the whole recording. Cheap to keep around and
 * cheap to draw — Timeline.jsx just scales this fixed-length array to
 * whatever width the audio lane currently has, so it doesn't need to be
 * rebuilt when the timeline is resized or the window changes width.
 */
export function buildWaveformPeaks(audioBuffer, bins = 800) {
  const channels = audioBuffer.numberOfChannels
  const length = audioBuffer.length
  const perBin = Math.max(1, Math.floor(length / bins))
  const data = []
  for (let c = 0; c < channels; c++) data.push(audioBuffer.getChannelData(c))

  const peaks = new Array(bins)
  for (let b = 0; b < bins; b++) {
    const start = b * perBin
    const end = Math.min(length, start + perBin)
    let min = 0
    let max = 0
    for (let i = start; i < end; i++) {
      // Mix down to mono on the fly rather than allocating a merged
      // channel array up front — keeps memory flat for long recordings.
      let sum = 0
      for (let c = 0; c < channels; c++) sum += data[c][i]
      const v = sum / channels
      if (v < min) min = v
      if (v > max) max = v
    }
    peaks[b] = [min, max]
  }
  return peaks
}

/**
 * Decodes a take's audio track (if it has one) into peaks. Resolves to null
 * rather than throwing when there's no audio to decode — a silent take, or
 * a container decodeAudioData can't find a track in — so callers can just
 * leave the audio lane empty on failure.
 */
export async function decodeWaveform(buffer, bins = 800) {
  let ctx
  try {
    // decodeAudioData detaches the ArrayBuffer it's given, so hand it a
    // fresh copy rather than the caller's own buffer (which the video
    // element's Blob may still need).
    const bytes = buffer instanceof ArrayBuffer
      ? buffer.slice(0)
      : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    ctx = new (window.AudioContext || window.webkitAudioContext)()
    const audioBuffer = await ctx.decodeAudioData(bytes)
    return buildWaveformPeaks(audioBuffer, bins)
  } catch {
    return null
  } finally {
    ctx?.close()
  }
}
