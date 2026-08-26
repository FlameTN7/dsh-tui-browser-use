#!/usr/bin/env node
/**
 * dsh-tui-browser-use — non-DeepSeek (base64) multimodal vision check.
 *
 * Verifies the SECOND transfer path: an OpenAI-compatible endpoint that inlines
 * images as base64 `image_url` (instead of the DeepSeek Files API). The
 * container's xiaomi `mimo-v2.5` (a multimodal model) is used with its own
 * endpoint/key. This is the counterpart to `vision-check.mjs` (DeepSeek file_api).
 *
 * The xiaomi key is NOT in the process env or the shell; it lives in the
 * container `.credentials.yaml` refs. It is read in-memory only and never printed.
 *
 * Usage: node scripts/vision-mimo-check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const log = (...a) => process.stderr.write('[vision-mimo] ' + a.join(' ') + '\n')

/** Read the xiaomi API key from the container credentials refs (never printed). */
function xiaomiKey() {
  try {
    const text = readFileSync('/opt/dsh-home/.credentials.yaml', 'utf8')
    const m = text.match(/XIAOMI_API_KEY:\s*(\S+)/)
    if (m) return m[1]
  } catch { /* ignore */ }
  return null
}

async function main() {
  const key = xiaomiKey()
  if (!key) { console.error('[vision-mimo] ERROR: no XIAOMI_API_KEY in .credentials.yaml'); process.exit(2) }
  log('xiaomi key loaded (len=' + key.length + ')')

  const { BrowserSession } = await import(join(root, 'lib/types/browser.js') + '?t=' + Date.now())
  const { analyzeImages } = await import(join(root, 'lib/types/vision.js') + '?t=' + Date.now())
  const { parseImageDimensions } = await import(join(root, 'lib/types/image-pipeline.js') + '?t=' + Date.now())

  const config = {
    lang: 'zh',
    visionMode: 'auto', // resolveImageTransfer → base64 for a non-DeepSeek provider
    screenshot: { format: 'png', quality: 80, maxDimension: '1024x768' },
    tiling: { mode: 'auto', threshold: '1200x1200', overlap: 60 },
    providers: [],
  }
  const session = new BrowserSession(config, 'en')

  const dir = mkdtempSync(join(tmpdir(), 'mimo-'))
  const fixture = join(dir, 'f.html')
  writeFileSync(fixture, `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Mimo 多模态页</title></head><body><h1>Mimo 多模态标题</h1><p>正文段落。</p></body></html>`)
  await session.navigate({ url: 'file://' + fixture })
  const buf = await session.captureScreenshot({})
  const { width, height } = parseImageDimensions(buf)
  log('captured ' + buf.length + ' bytes ' + width + 'x' + height)

  // Non-DeepSeek provider → base64 inline transfers.
  const env = {
    baseUrl: 'https://api.xiaomimimo.com/v1',
    apiKey: key,
    model: 'mimo-v2.5',
    imageTransfer: 'base64',
    provider: 'xiaomi',
    currentModel: 'mimo-v2.5',
  }
  const images = [{ mime: 'image/png', data: buf, width, height, tile: { index: 1, total: 1 } }]

  log('calling analyzeImages (base64 + xiaomi mimo-v2.5) ...')
  const res = await analyzeImages(env, images, 'What is the heading text on this page? One short sentence.')
  assert.ok(res.insight.length > 0, 'insight non-empty')
  log('insight (truncated): ' + res.insight.slice(0, 160).replace(/\n+/g, ' '))
  log('usage: imagesSent=' + res.usage.imagesSent + ' promptTokens=' + res.usage.promptTokens)

  await session.close()
  console.log('[vision-mimo] OK (base64 + xiaomi mimo-v2.5): ' + res.insight.trim().slice(0, 80))
}

await main().catch((err) => { console.error('[vision-mimo] FAILED:', err && err.message ? err.message : err); process.exit(1) })
