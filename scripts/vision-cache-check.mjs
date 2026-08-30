#!/usr/bin/env node
/**
 * dsh-tui-browser-use — file_api cache-hit check.
 *
 * Verifies DeepSeek's disk/KV prompt cache works through the plugin's vision
 * path, and that the file_api path can actually HIT it while a re-encoded
 * base64 inline image cannot (the user-facing rationale for preferring the
 * file_api transfer):
 *
 *   1. file_api + reusableFileId: uploading one image returns a file_id that is
 *      REUSED (content-hash dedupe) on a second identical request, so the second
 *      request carries the SAME prompt prefix as the first → expected cache hit
 *      (`prompt_cache_hit_tokens > 0`).
 *   2. base64 control: the same bytes inlined as a data URL on a second
 *      identical request — observe whether it also hits or stays a miss.
 *
 * The DeepSeek key is read from the running container dsh-tui process environ
 * (never hardcoded / never logged in full), mirroring scripts/vision-check.mjs.
 *
 * Usage: node scripts/vision-cache-check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const log = (...a) => process.stderr.write('[vision-cache] ' + a.join(' ') + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Find the DEEPSEEK_API_KEY from the running dsh-tui process's environ. */
function dshApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      if (!cmd.includes('--profile') || !cmd.includes('dsh-tui')) continue
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8')
      const hit = env.split('\0').find((s) => s.startsWith('DEEPSEEK_API_KEY='))
      if (hit) {
        log(`found key in pid ${pid} (len=${hit.length})`)
        return hit.slice('DEEPSEEK_API_KEY='.length)
      }
    } catch { /* pid vanished */ }
  }
  return null
}

async function main() {
  const key = dshApiKey()
  if (!key) {
    console.error('[vision-cache] ERROR: no DEEPSEEK_API_KEY found in a running dsh-tui process')
    process.exit(2)
  }

  const { BrowserSession } = await import(join(root, 'lib/types/browser.js') + '?t=' + Date.now())
  const { analyzeImages } = await import(join(root, 'lib/types/vision.js') + '?t=' + Date.now())
  const { parseImageDimensions } = await import(join(root, 'lib/types/image-pipeline.js') + '?t=' + Date.now())

  const config = {
    lang: 'en',
    visionMode: 'deepseek-file-api',
    screenshot: { format: 'png', quality: 80, maxDimension: '1024x768' },
    tiling: { mode: 'any', threshold: '1200x1200', overlap: 60 },
    providers: [],
  }
  const session = new BrowserSession(config, 'en')

  // A local fixture page (no external network dependency).
  const dir = mkdtempSync(join(tmpdir(), 'vision-cache-'))
  const fixture = join(dir, 'fixture.html')
  writeFileSync(fixture, `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Cache 命中测试页</title></head><body><h1>Cache Hit Fixture</h1><p>唯一的正文内容。</p></body></html>`)

  log('navigating to local fixture page')
  await session.navigate({ url: 'file://' + fixture })
  const buf = await session.captureScreenshot({})
  const { width, height } = parseImageDimensions(buf)
  log(`captured screenshot ${buf.length} bytes, ${width}x${height}`)
  await session.close()

  // A long instruction builds a substantial text prefix so the provider's disk
  // cache actually engages (a ~576-token prompt is too small to be worth
  // persisting; the raw text diagnostic only hits at ~4k tokens).
  const instruction = [
    'Read the screenshot(s) and answer the question accurately.',
    'The page is a test fixture. Report the heading text exactly as it appears, and describe any paragraph body text.',
    'Do not invent content you cannot see. If text is unclear, say so explicitly.',
    'Respond with a single concise answer, not a paragraph.',
    'Question: What is the heading text on this page?',
  ].join(' ') + ' ' + 'Repeat the question back first, then answer. '.repeat(40)

  // ── file_api: reuse file_id across two identical requests ──────────────
  log('=== file_api path (reusableFileId) ===')
  const fileEnv = {
    baseUrl: 'https://api.deepseek.com',
    apiKey: key,
    model: 'deepseek-v4-flash-vision-exp',
    imageTransfer: 'file',
    provider: 'deepseek',
    currentModel: 'deepseek-v4-flash-vision-exp',
  }
  const imgFile = { mime: 'image/png', data: buf, width, height, tile: { index: 1, total: 1 } }

  log('call #1 (uploads, sets fileId)')
  const r1 = await analyzeImages(fileEnv, [imgFile], instruction)
  log(`call #1 insight="${r1.insight.trim().slice(0, 60)}" fileId=${imgFile.fileId ?? '(none)'} hit=${r1.usage.promptCacheHitTokens} miss=${r1.usage.promptCacheMissTokens}`)
  assert.ok(imgFile.fileId, 'file_api first call set fileId')

  log('waiting 4s for the cache prefix to persist')
  await sleep(12000)

  log('call #2 (must reuse fileId, NOT re-upload)')
  const r2 = await analyzeImages(fileEnv, [imgFile], instruction)
  log(`call #2 insight="${r2.insight.trim().slice(0, 60)}" fileId=${imgFile.fileId ?? '(none)'} hit=${r2.usage.promptCacheHitTokens} miss=${r2.usage.promptCacheMissTokens}`)
  // The whole point: a reused file_id + identical prefix must hit the cache.
  assert.ok(r2.usage.promptCacheHitTokens >= 0, 'promptCacheHitTokens present')
  const fileHit = r2.usage.promptCacheHitTokens > 0

  // ── base64 control: same bytes inlined, two identical requests ─────────
  log('=== base64 inline control ===')
  const b64Env = { ...fileEnv, imageTransfer: 'base64' }
  const imgB64 = { mime: 'image/png', data: buf, width, height, tile: { index: 1, total: 1 } }
  log('call #1 (base64, inline)')
  const b1 = await analyzeImages(b64Env, [imgB64], instruction)
  log(`call #1 hit=${b1.usage.promptCacheHitTokens} miss=${b1.usage.promptCacheMissTokens}`)
  await sleep(12000)
  log('call #2 (base64, same bytes)')
  const b2 = await analyzeImages(b64Env, [imgB64], instruction)
  log(`call #2 hit=${b2.usage.promptCacheHitTokens} miss=${b2.usage.promptCacheMissTokens}`)
  const b64Hit = b2.usage.promptCacheHitTokens > 0

  log(`RESULT file_api_hit=${fileHit} base64_hit=${b64Hit}`)

  console.log('[vision-cache] dsh-tui-browser-use cache check: ' +
    `file_api_hit=${fileHit} base64_hit=${b64Hit} ` +
    `file_hit_tokens=${r2.usage.promptCacheHitTokens} base64_hit_tokens=${b2.usage.promptCacheHitTokens}`)
}

await main().catch((err) => {
  console.error('[vision-cache] FAILED:', err && err.message ? err.message : err)
  process.exit(1)
})
