// Regenerates every app icon/logo from the master artwork in logo/.
//   node scripts/make-icons.cjs
const fs = require('node:fs')
const path = require('node:path')
const sharp = require('sharp')

const root = path.join(__dirname, '..')
const MASTER = path.join(root, 'logo', 'ZoomArc Logo v2.png')

const png = (img, size) => img.clone().resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer()

// Windows .ico with PNG-compressed entries (supported since Vista).
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, e)
    header.writeUInt8(size >= 256 ? 0 : size, e + 1)
    header.writeUInt8(0, e + 2)
    header.writeUInt8(0, e + 3)
    header.writeUInt16LE(1, e + 4)
    header.writeUInt16LE(32, e + 6)
    header.writeUInt32LE(data.length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...images.map((i) => i.data)])
}

// macOS .icns with PNG entries.
function icns(entries) {
  const chunks = entries.map(({ type, data }) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([head, data])
  })
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

;(async () => {
  const master = sharp(MASTER).ensureAlpha()
  const { width } = await master.metadata()

  // Tight crop to the rounded square, for small in-app use where the
  // artwork's own transparent margin would just waste pixels.
  const { data, info } = await master.clone().raw().toBuffer({ resolveWithObject: true })
  let min = info.width
  let max = 0
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 8) {
        min = Math.min(min, x, y)
        max = Math.max(max, x, y)
      }
    }
  }
  const cropped = sharp(await master.clone().extract({ left: min, top: min, width: max - min + 1, height: max - min + 1 }).png().toBuffer())

  const write = (rel, buf) => {
    fs.writeFileSync(path.join(root, rel), buf)
    console.log(rel.padEnd(28), `${(buf.length / 1024).toFixed(0)} KB`)
  }

  // App icon (full artwork, margin included — standard for OS icons).
  write('build/icon.png', await png(master, 1024))
  write('build/icon.ico', ico(await Promise.all([16, 20, 24, 32, 40, 48, 64, 96, 128, 256].map(async (size) => ({ size, data: await png(master, size) })))))
  const icnsSizes = { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512 }
  write('build/icon.icns', icns(await Promise.all(Object.entries(icnsSizes).map(async ([type, size]) => ({ type, data: await png(master, size) })))))
  write('electron/icon.png', await png(master, 256))

  // In-app title bar logo + favicon (tight crop).
  write('src/assets/logo.png', await png(cropped, 128))

  // README header.
  write('Recorder Logo.png', await png(master, 512))
  console.log(`master ${width}px, square ${max - min + 1}px`)
})()
