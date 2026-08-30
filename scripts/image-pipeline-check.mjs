/**
 * image-pipeline-check — pure-logic regression for P1-15 (1.5).
 *
 * The screenshot pipeline was a pass-through that ignored its options and never
 * reported the byte budget. It is now a validation/normalization layer: it
 * sniffs mime/dimensions, checks the byte budget, and reports `bytes`/`oversize`
 * while passing the payload through unchanged (capture-time JPEG compression
 * happens in `BrowserSession.captureSegments`; PNG is never re-encoded).
 *
 * Run: `node --import tsx/esm scripts/image-pipeline-check.mjs`
 */
import assert from 'node:assert/strict'

const { prepareScreenshot, parseImageDimensions, sniffMime, DEFAULT_MAX_IMAGE_BYTES } = await import('../src/image-pipeline.js')

// 1. sniffMime: PNG / JPEG / webp / unknown.
{
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)])
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])
  assert.equal(sniffMime(png), 'image/png', 'png mime')
  assert.equal(sniffMime(jpg), 'image/jpeg', 'jpeg mime')
  assert.equal(sniffMime(webp), 'image/webp', 'webp mime')
  assert.equal(sniffMime(Buffer.from('hello')), 'image/jpeg', 'unknown defaults to jpeg')
  console.log('[1] sniffMime — OK')
}

// 2. parseImageDimensions: PNG IHDR + JPEG SOFn + unknown → 0x0.
{
  // A minimal real PNG: 8-byte sig + IHDR (4 len + 'IHDR' + 4 w + 4 h + ...).
  const png = Buffer.alloc(24)
  png.writeUInt32BE(0x89504e47, 0)
  png.writeUInt32BE(0x0d0a1a0a, 4)
  png.writeUInt32BE(16, 8) // IHDR data len
  png.write('IHDR', 12, 'ascii')
  png.writeUInt32BE(200, 16) // width
  png.writeUInt32BE(100, 20) // height
  const dims = parseImageDimensions(png)
  assert.equal(dims.width, 200)
  assert.equal(dims.height, 100)
  assert.deepEqual(parseImageDimensions(Buffer.from('xx')), { width: 0, height: 0 })
  console.log('[2] parseImageDimensions — OK')
}

// 3. prepareScreenshot marks oversize when over budget, passes through data.
{
  const big = Buffer.alloc(DEFAULT_MAX_IMAGE_BYTES + 1, 0xff)
  const [img] = prepareScreenshot(big, { format: 'jpeg', quality: 80, maxWidth: 1024, maxHeight: 768, tiling: 'off', maxImageBytes: DEFAULT_MAX_IMAGE_BYTES })
  assert.equal(img.bytes, big.length, 'bytes reported')
  assert.equal(img.oversize, true, 'oversize flagged')
  assert.equal(img.data.length, big.length, 'payload passed through unchanged')
  assert.equal(img.mime, 'image/jpeg', 'unknown buf → jpeg')
  console.log('[3] prepareScreenshot oversize marking + pass-through — OK')
}

// 4. Within budget → oversize false; custom budget honored.
{
  const small = Buffer.alloc(1024)
  const [img] = prepareScreenshot(small, { format: 'jpeg', quality: 80, maxWidth: 1024, maxHeight: 768, tiling: 'off', maxImageBytes: 2048 })
  assert.equal(img.oversize, false, 'within budget not oversize')
  const [img2] = prepareScreenshot(small, { format: 'jpeg', quality: 80, maxWidth: 1024, maxHeight: 768, tiling: 'off', maxImageBytes: 512 })
  assert.equal(img2.oversize, true, 'custom small budget flags oversize')
  console.log('[4] prepareScreenshot budget boundary — OK')
}

// 5. PNG payload passed through (never re-encoded; data identical).
{
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3])
  const [img] = prepareScreenshot(png, { format: 'png', quality: 80, maxWidth: 1024, maxHeight: 768, tiling: 'off' })
  assert.deepEqual(img.data, png, 'png data unchanged')
  assert.equal(img.mime, 'image/png', 'png mime')
  console.log('[5] prepareScreenshot PNG pass-through — OK')
}

console.log('\n[image-pipeline-check] ALL PASS')
process.exit(0)
