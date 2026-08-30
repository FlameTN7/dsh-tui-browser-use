#!/usr/bin/env node
/**
 * dsh-tui-browser-use — OpenAI-compatible (base64 inline) vision check.
 *
 * Verifies the SECOND transfer path: an OpenAI-compatible endpoint that inlines
 * images as base64 `image_url` (instead of the DeepSeek Files API). Defaults to
 * the public OpenAI endpoint; point at any gateway with the env vars below.
 * This is the counterpart to `vision-check.mjs` (DeepSeek file_api).
 *
 * The key is read from `OPENAI_API_KEY` (env), or — for profiles that keep refs
 * in a credentials file — from `DSH_CREDENTIALS_FILE`. It is read in-memory
 * only and never printed.
 *
 * Usage: OPENAI_API_KEY=... node scripts/vision-openai-compat-check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const log = (...a) => process.stderr.write('[vision-openai-compat] ' + a.join(' ') + '\n')

/** Read the API key (never printed): env first, then DSH_CREDENTIALS_FILE. */
function apiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY
  const file = process.env.DSH_CREDENTIALS_FILE
  if (!file) return null
  try {
    const text = readFileSync(file, 'utf8')
    const m = text.match(/OPENAI_API_KEY:\s*(\S+)/)
    if (m) return m[1]
  } catch { /* ignore */ }
  return null
}

async function main() {
  const key = apiKey()
  if (!key) { console.error('[vision-openai-compat] ERROR: set OPENAI_API_KEY or DSH_CREDENTIALS_FILE'); process.exit(2) }
  log('api key loaded (len=' + key.length + ')')

  const baseUrl = process.env.DSH_TUI_BROWSER_BASE_URL ?? 'https://api.openai.com/v1'
  const model = process.env.DSH_TUI_BROWSER_MODEL ?? 'gpt-4o-mini'

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

  const dir = mkdtempSync(join(tmpdir(), 'openai-compat-'))
  const fixture = join(dir, 'f.html')
  writeFileSync(fixture, `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>OpenAI 兼容视觉页</title></head><body><h1>OpenAI 兼容视觉标题</h1><p>正文段落。</p></body></html>`)
  await session.navigate({ url: 'file://' + fixture })
  const buf = await session.captureScreenshot({})
  const { width, height } = parseImageDimensions(buf)
  log('captured ' + buf.length + ' bytes ' + width + 'x' + height)

  // Non-DeepSeek provider → base64 inline transfers.
  const env = {
    baseUrl,
    apiKey: key,
    model,
    imageTransfer: 'base64',
    provider: 'openai',
    currentModel: model,
  }
  const images = [{ mime: 'image/png', data: buf, width, height, tile: { index: 1, total: 1 } }]
  log('calling analyzeImages (base64 + ' + model + ') ...')
  const res = await analyzeImages(env, images, '页面上最大的标题是什么？')
  assert.ok(res.insight && res.insight.trim().length > 0, 'non-empty insight')
  assert.ok(res.usage && res.usage.inputTokens > 0, 'usage input > 0')
  console.log('[vision-openai-compat] OK (base64 + ' + model + '): ' + res.insight.trim().slice(0, 80))
  await session.close()
}

await main().catch((err) => { console.error('[vision-openai-compat] FAILED:', err && err.message ? err.message : err); process.exit(1) })
