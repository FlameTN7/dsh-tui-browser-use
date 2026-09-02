#!/usr/bin/env node
/**
 * dsh-tui-browser-use — vision end-to-end check.
 *
 * Proves the full vision path: a real browser screenshot → DeepSeek Files API
 * upload (`file_id`) → `deepseek-v4-flash-vision-exp` model reads it → textual
 * insight + usage accounting.
 *
 * The DeepSeek API key is resolved by scripts/key-probe.mjs across every channel
 * a standalone process can reach (process.env → $DSH_HOME/.credentials.yaml →
 * .env → a live dsh-tui process environ), mirroring dsh-credentials-local. It is
 * used in-memory only and never logged in full.
 *
 * Usage: node scripts/vision-check.mjs
 */

import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { probeApiKey } from './key-probe.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const log = (...a) => process.stderr.write('[vision] ' + a.join(' ') + '\n')

// P0-3: deliberate local `file://` fixture → opt in to the SSRF relaxation.
process.env.DSH_TUI_BROWSER_ALLOW_UNSAFE_URL = '1'

async function main() {
  const key = probeApiKey('DEEPSEEK_API_KEY', { log })
  if (!key) {
    console.error('[vision] ERROR: no DEEPSEEK_API_KEY reachable from this standalone process (checked process.env, $DSH_HOME/.credentials.yaml, .env, and a live dsh-tui process environ). Export DEEPSEEK_API_KEY in the shell or store it in ~/.dsh/.credentials.yaml to run this test.')
    process.exit(2)
  }

  const { BrowserSession } = await import(join(root, 'lib/types/browser.js') + '?t=' + Date.now())
  const { analyzeImages } = await import(join(root, 'lib/types/vision.js') + '?t=' + Date.now())
  const { parseImageDimensions } = await import(join(root, 'lib/types/image-pipeline.js') + '?t=' + Date.now())

  const config = {
    lang: 'zh',
    visionMode: 'deepseek-file-api',
    screenshot: { format: 'png', quality: 80, maxDimension: '1024x768' },
    tiling: { mode: 'any', threshold: '1200x1200', overlap: 60 },
    providers: [],
  }
  const session = new BrowserSession(config, 'en')

  // Local fixture page (no external network dependency for the browser).
  const dir = mkdtempSync(join(tmpdir(), 'vision-'))
  const fixture = join(dir, 'fixture.html')
  writeFileSync(fixture, `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Vision 集成测试页</title></head><body><h1>Vision 集成测试标题</h1><p>这是本页的唯一正文段落。</p></body></html>`)

  log('navigating to a local fixture page')
  await session.navigate({ url: 'file://' + fixture })
  const buf = await session.captureScreenshot({})
  const { width, height } = parseImageDimensions(buf)
  log(`captured screenshot ${buf.length} bytes, ${width}x${height}`)

  const env = {
    baseUrl: 'https://api.deepseek.com',
    apiKey: key,
    model: 'deepseek-v4-flash-vision-exp',
    imageTransfer: 'file',
    provider: 'deepseek',
    currentModel: 'deepseek-v4-flash-vision-exp',
  }

  const images = [{ mime: 'image/png', data: buf, width, height, tile: { index: 1, total: 1 } }]

  log('calling analyzeImages (file_api + model) ...')
  const res = await analyzeImages(env, images, 'What is the heading text on this page? Answer in one short sentence.')
  assert.ok(res.insight.length > 0, 'insight is non-empty')
  assert.ok(res.usage, 'usage is present')

  log('insight (truncated): ' + res.insight.slice(0, 160).replace(/\n+/g, ' '))
  log('usage: imagesSent=' + res.usage.imagesSent + ' promptTokens=' + res.usage.promptTokens + ' completionTokens=' + res.usage.completionTokens)

  await session.close()
  console.log('[vision] dsh-tui-browser-use vision check OK: file_api + model returned: ' + res.insight.trim().slice(0, 80))
}

await main().catch((err) => {
  console.error('[vision] FAILED:', err && err.message ? err.message : err)
  process.exit(1)
})
