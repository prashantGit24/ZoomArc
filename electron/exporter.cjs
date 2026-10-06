const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const ffmpegPath = require('ffmpeg-static')

/**
 * ffmpeg-static resolves a binary for the platform it was INSTALLED on, so a
 * Windows package built on a Mac would ship a Mach-O binary. Resolution order:
 *   1. FFMPEG_PATH, for anyone supplying their own build
 *   2. a binary placed next to the app resources by the packaging step
 *   3. whatever ffmpeg-static resolved, with the asar path corrected
 */
function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH
  }
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'bin', exe)
    if (fs.existsSync(bundled)) return bundled
  }
  // electron-builder unpacks native binaries out of the asar; fix the path.
  return String(ffmpegPath || '').replace('app.asar', 'app.asar.unpacked')
}

const FFMPEG = resolveFfmpeg()

/**
 * Output formats. All of these now take PNG frames rather than JPEG: JPEG
 * quantizes and chroma-subsamples (4:2:0) each frame on its own before ffmpeg
 * ever sees it, and doing that on top of the final encoder's own chroma
 * subsampling doubled up into visible DCT blocking and colour speckling
 * ("dead pixel" looking dots) around the hard edges screen content is full of
 * — text, cursors, window chrome. PNG carries the renderer's full-precision
 * RGB through losslessly, so only one lossy step (the final video encode)
 * ever touches the pixels.
 *
 * mp4 and webm also encode at 4:4:4 chroma (no subsampling at all) instead of
 * 4:2:0, which is what actually fixes the colour bleed/fringing on sharp UI
 * edges — 4:2:0 throws away 3 of every 4 chroma samples, which is exactly
 * where that fringing comes from. Trade-off: 4:4:4 H.264 ("High 4:4:4
 * Predictive") isn't guaranteed to hardware-decode on every device, though
 * every mainstream player (VLC, QuickTime, ffplay, browsers) decodes it fine
 * in software.
 *
 * Every format is tunable via a `quality` preset (see QUALITY_PRESETS below)
 * rather than fixed to one point — mp4 and webm move on a real quality/size
 * trade-off (CRF, plus VP9's dedicated `-lossless` mode at the top end since
 * VP9 has no true CRF-0 lossless point the way x264's crf 0 does); mov and
 * mkv stay pinned to their best settings regardless of the preset, since
 * ProRes 4444 XQ / FFV1 are what you reach for specifically *because* you
 * want lossless — a "smaller file" ProRes/FFV1 isn't a thing anyone asked for
 * when png sequence and a size-tunable format both already exist.
 */
const FORMATS = {
  mp4: {
    label: 'MP4 · H.264 (4:4:4)',
    ext: 'mp4',
    alpha: false,
    frameType: 'image/png',
    frameCodec: 'png',
    // crf 0 disables x264's quantizer outright — genuinely lossless, not an
    // approximation of it — at the 'lossless' preset.
    video: (q) => ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(q.crf), '-pix_fmt', 'yuv444p', '-movflags', '+faststart'],
  },
  mov: {
    label: 'MOV · ProRes 4444 XQ (transparent, lossless)',
    ext: 'mov',
    alpha: true,
    frameType: 'image/png',
    frameCodec: 'png',
    // 4444 XQ is Apple's top-of-line ProRes profile — meant for VFX/graphics
    // work where nothing can be thrown away — and still carries the alpha
    // plane the plain 4444 profile did. qscale 1 pins it to its best quality
    // point rather than a target bitrate. Not preset-tunable — see above.
    video: () => ['-c:v', 'prores_ks', '-profile:v', '4444xq', '-qscale:v', '1', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16'],
  },
  // ffmpeg's WebM muxer cannot write VP9/VP8 alpha (it lives in Matroska
  // BlockAdditional, which the muxer drops), so this one is opaque by design —
  // it is here for small web-friendly files, not for transparency.
  webm: {
    label: 'WebM · VP9 (4:4:4)',
    ext: 'webm',
    alpha: false,
    frameType: 'image/png',
    frameCodec: 'png',
    // VP9 profile 0 is 4:2:0-only; profile 1 unlocks 8-bit 4:4:4.
    video: (q) =>
      q.vp9Lossless
        ? ['-c:v', 'libvpx-vp9', '-profile:v', '1', '-pix_fmt', 'yuv444p', '-lossless', '1', '-row-mt', '1']
        : ['-c:v', 'libvpx-vp9', '-profile:v', '1', '-pix_fmt', 'yuv444p', '-crf', String(q.vp9Crf), '-b:v', '0', '-row-mt', '1'],
  },
  // FFV1 in Matroska: mathematically lossless like mov/png, but sidesteps
  // ProRes licensing/tooling expectations and, by encoding straight to planar
  // RGB(A) (gbrap) instead of any YUV variant, skips the colour-space
  // conversion step those formats still do — nothing is thrown away or even
  // reshuffled between the canvas and the file on disk.
  mkv: {
    label: 'MKV · FFV1 (lossless, transparent)',
    ext: 'mkv',
    alpha: true,
    frameType: 'image/png',
    frameCodec: 'png',
    // Not preset-tunable — see above.
    video: () => ['-c:v', 'ffv1', '-level', '3', '-coder', '1', '-context', '1', '-g', '1', '-slices', '4', '-pix_fmt', 'gbrap'],
  },
  // Numbered PNGs keep alpha losslessly and import into anything.
  png: {
    label: 'PNG sequence (transparent)',
    ext: 'png',
    alpha: true,
    sequence: true,
    frameType: 'image/png',
    frameCodec: 'png',
    video: () => ['-c:v', 'png'],
  },
}

/**
 * Quality presets for the formats that actually have a size/quality dial
 * (mp4, webm). `crf` drives x264; `vp9Crf`/`vp9Lossless` drive libvpx-vp9,
 * which needs its own numbers since VP9's CRF scale (0-63) and quality curve
 * don't line up with x264's (0-51) — picking matched-by-number values across
 * codecs would leave webm and mp4 looking nothing alike at the "same" preset.
 */
const QUALITY_PRESETS = {
  lossless: { id: 'lossless', label: 'Lossless (largest files)', crf: 0, vp9Lossless: true, vp9Crf: 0 },
  high: { id: 'high', label: 'High (visually lossless)', crf: 12, vp9Lossless: false, vp9Crf: 16 },
  balanced: { id: 'balanced', label: 'Balanced', crf: 18, vp9Lossless: false, vp9Crf: 28 },
  small: { id: 'small', label: 'Smaller file', crf: 26, vp9Lossless: false, vp9Crf: 40 },
}
const DEFAULT_QUALITY = 'lossless'

/**
 * Starts ffmpeg reading a frame stream from stdin. The renderer draws each
 * composited frame offscreen and pushes it here in order, so export is
 * deterministic rather than a realtime screen-grab of the preview.
 */
function exportVideo({ outPath, fps = 60, width, height, audioPath, quality = DEFAULT_QUALITY, format = 'mp4' }) {
  const fmt = FORMATS[format] || FORMATS.mp4
  const q = QUALITY_PRESETS[quality] || QUALITY_PRESETS[DEFAULT_QUALITY]
  const args = ['-y', '-f', 'image2pipe', '-vcodec', fmt.frameCodec, '-r', String(fps), '-i', 'pipe:0']

  // A sequence writes numbered files into a directory of its own.
  let target = outPath
  if (fmt.sequence) {
    fs.mkdirSync(outPath, { recursive: true })
    target = require('node:path').join(outPath, 'frame-%05d.png')
  }

  const hasAudio = !fmt.sequence && audioPath && fs.existsSync(audioPath)
  if (hasAudio) {
    args.push('-i', audioPath, '-map', '0:v:0', '-map', '1:a:0?')
    // flac for mkv keeps the audio lossless too, matching the video codec —
    // no point encoding bit-exact FFV1 video next to lossy audio.
    if (fmt.ext === 'webm') args.push('-c:a', 'libopus', '-b:a', '192k')
    else if (fmt.ext === 'mkv') args.push('-c:a', 'flac')
    else args.push('-c:a', 'aac', '-b:a', '192k')
  }

  args.push(...fmt.video(q))
  args.push(
    // Even dimensions keep every pixel format here happy (still required by
    // the PNG sequence's frame-to-frame consistency and by some decoders'
    // handling of 4:4:4 streams) — cheaper to always floor than to special-case it.
    '-vf', `scale=${Math.floor(width / 2) * 2}:${Math.floor(height / 2) * 2}`,
    '-r', String(fps),
  )
  if (hasAudio) args.push('-shortest')
  args.push(target)

  if (!FFMPEG || !fs.existsSync(FFMPEG)) {
    throw new Error(
      `No ffmpeg binary for ${process.platform}-${process.arch}. ` +
        'Reinstall dependencies, or set FFMPEG_PATH to a local ffmpeg.',
    )
  }

  const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr.on('data', (d) => {
    stderr += d.toString()
    if (stderr.length > 20000) stderr = stderr.slice(-10000)
  })

  let fatal = null
  proc.on('error', (err) => { fatal = err })
  proc.stdin.on('error', (err) => {
    // EPIPE just means ffmpeg died first; the exit handler reports the real cause.
    if (err.code !== 'EPIPE') fatal = err
  })

  return {
    writeFrame(buf) {
      if (fatal) return Promise.reject(fatal)
      return new Promise((resolve, reject) => {
        // Respect backpressure so a slow encoder doesn't balloon memory.
        const ok = proc.stdin.write(buf, (err) => (err && err.code !== 'EPIPE' ? reject(err) : null))
        if (ok) resolve()
        else proc.stdin.once('drain', resolve)
      })
    },

    finish() {
      return new Promise((resolve, reject) => {
        proc.on('close', (code) =>
          code === 0
            ? resolve({ outPath })
            : reject(new Error(`ffmpeg exited with ${code}\n${stderr.slice(-2000)}`)),
        )
        proc.stdin.end()
      })
    },

    abort() {
      return new Promise((resolve) => {
        proc.on('close', () => {
          // Recursive covers the sequence case, where outPath is a directory.
          fs.rmSync(outPath, { force: true, recursive: true })
          resolve()
        })
        proc.kill('SIGKILL')
      })
    },
  }
}

module.exports = { exportVideo, resolveFfmpeg, FORMATS, QUALITY_PRESETS, DEFAULT_QUALITY }
