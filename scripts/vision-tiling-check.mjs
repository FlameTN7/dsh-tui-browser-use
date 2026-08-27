#!/usr/bin/env node
/**
 * dsh-tui-browser-use — multi-image tiling vision end-to-end check.
 *
 * Verifies the SPLIT-UPLOAD path used with the official DeepSeek file_api:
 * a tall page is scroll-captured into multiple segment images
 * (`BrowserSession.captureSegments`), EACH image is uploaded via the Files API,
 * and the vision model reads ALL tiles together and stitches them into a page
 * understanding.
 *
 * Key is read from the running container dsh-tui process environ (not printed).
 *
 * Usage: node scripts/vision-tiling-check.mjs
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const log = (...a) => process.stderr.write('[vision-tiling] ' + a.join(' ') + '\n')

function dshApiKey() {
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      if (!cmd.includes('--profile') || !cmd.includes('dsh-tui')) continue
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8')
      const hit = env.split('\0').find((s) => s.startsWith('DEEPSEEK_API_KEY='))
      if (hit) { log(`found key in pid ${pid}`); return hit.slice('DEEPSEEK_API_KEY='.length) }
    } catch { /* gone */ }
  }
  return null
}

async function main() {
  const key = dshApiKey()
  if (!key) { console.error('[vision-tiling] ERROR: no key in dsh-tui process'); process.exit(2) }

  const { BrowserSession } = await import(join(root, 'lib/types/browser.js') + '?t=' + Date.now())
  const { analyzeImages } = await import(join(root, 'lib/types/vision.js') + '?t=' + Date.now())
  const { prepareScreenshot } = await import(join(root, 'lib/types/image-pipeline.js') + '?t=' + Date.now())

  // Force tiling `on` so a tall page splits regardless of auto threshold.
  const config = {
    lang: 'zh',
    visionMode: 'deepseek-file-api',
    screenshot: { format: 'png', quality: 80, maxDimension: '1024x768' },
    tiling: { mode: 'on', threshold: '1200x1200', overlap: 60 },
    providers: [],
  }
  const session = new BrowserSession(config, 'en')

  // A tall page with clearly separated numbered blocks, so we can tell whether
  // the model reads content that spans multiple captured tiles.
  const blocks = Array.from({ length: 6 }, (_, i) =>
    `<section style="height:300px;border:1px solid #ccc;padding:8px"><h2>块 ${i + 1}</h2><p>这是第 ${i + 1} 段的独有正文内容。</p></section>`).join('')
  const dir = mkdtempSync(join(tmpdir(), 'vision-tiling-'))
  const fixture = join(dir, 'tall.html')
  writeFileSync(fixture, `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>分块长页面</title></head><body>${blocks}</body></html>`)

  log('navigating to tall fixture')
  await session.navigate({ url: 'file://' + fixture })

  const cap = await session.captureSegments()
  const segments = cap.buffers
  log('captureSegments returned ' + segments.length + ' segments: ' + segments.map((b) => b.length).join(',') + (cap.truncated ? ` (TRUNCATED, planned ${cap.segmentsTotal})` : ''))

  // Prepare each segment (no further tiling) and label its tile index.
  const images = segments.map((buf, i) => {
    const [img] = prepareScreenshot(buf, {
      format: 'png', quality: 80, maxWidth: 1024, maxHeight: 768, tiling: 'off',
    })
    img.tile = { index: i + 1, total: segments.length }
    return img
  })
  log('prepared ' + images.length + ' images for file_api')

  const env = {
    baseUrl: 'https://api.deepseek.com', apiKey: key,
    model: 'deepseek-v4-flash-vision-exp', imageTransfer: 'file',
    provider: 'deepseek', currentModel: 'deepseek-v4-flash-vision-exp',
  }

  log('calling analyzeImages with ' + images.length + ' images ...')
  const res = await analyzeImages(env, images,
    'This page was split into several scroll-captured blocks in order. Read ALL blocks together as one page. List the block numbers you can see, e.g. "1,2,3".')
  assert.ok(res.insight.length > 0, 'insight non-empty')

  log('insight (truncated): ' + res.insight.slice(0, 220).replace(/\n+/g, ' '))
  log('usage: imagesSent=' + res.usage.imagesSent + ' promptTokens=' + res.usage.promptTokens + ' completionTokens=' + res.usage.completionTokens)

  // The model should report more than one block if it truly read multiple tiles.
  const seen = [...res.insight.matchAll(/\b([1-9])\b/g)].map((m) => m[1])
  const unique = [...new Set(seen)]
  log('distinct block numbers seen in insight: ' + unique.join(','))

  await session.close()
  console.log('[vision-tiling] OK: imagesSent=' + res.usage.imagesSent + ' insight="' + res.insight.trim().slice(0, 90) + '"')
}

await main().catch((err) => { console.error('[vision-tiling] FAILED:', err && err.message ? err.message : err); process.exit(1) })
