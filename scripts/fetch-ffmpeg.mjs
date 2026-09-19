/**
 * Downloads the ffmpeg binary for a TARGET platform into build/bin/<platform>,
 * which electron-builder then ships as resources/bin/ffmpeg(.exe).
 *
 * Needed because ffmpeg-static only ever fetches a binary for the machine doing
 * the install, so cross-building (a Windows package from macOS, say) would
 * otherwise bundle the wrong executable.
 *
 *   node scripts/fetch-ffmpeg.mjs win32-x64
 */
import { createWriteStream } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { mkdir, chmod, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// Track whatever release ffmpeg-static itself pins, so the cross-built binary
// matches the one a native install would have produced.
const VERSION = process.env.FFMPEG_BINARY_RELEASE || require('ffmpeg-static/package.json')['ffmpeg-static']['binary-release-tag']
const target = process.argv[2] || `${process.platform}-${process.arch}`
const isWin = target.startsWith('win32')
// Release assets are gzipped and named ffmpeg-<platform>-<arch>.gz
const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${VERSION}/ffmpeg-${target}.gz`
const outDir = path.resolve('build/bin', target)
const outFile = path.join(outDir, isWin ? 'ffmpeg.exe' : 'ffmpeg')

const res = await fetch(url, { redirect: 'follow' })
if (!res.ok) {
  console.error(`Could not download ffmpeg for ${target}: ${res.status} ${res.statusText}`)
  console.error(`  ${url}`)
  process.exit(1)
}
await mkdir(outDir, { recursive: true })
await pipeline(res.body, createGunzip(), createWriteStream(outFile))
if (!isWin) await chmod(outFile, 0o755)
const { size } = await stat(outFile)
console.log(`ffmpeg for ${target} -> ${outFile} (${(size / 1e6).toFixed(1)} MB)`)
