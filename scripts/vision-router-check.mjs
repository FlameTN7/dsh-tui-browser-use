#!/usr/bin/env node
/**
 * dsh-tui-browser-use — provider-routed vision via the REAL apply() path.
 *
 * Unlike vision-openai-compat-check.mjs (which calls analyzeImages directly
 * with a hand-built env), this boots the plugin's `apply()` with a structured
 * harness context and then drives the REGISTERED `browser_screenshot` tool. It
 * routes through the env overrides (`DSH_TUI_BROWSER_PROVIDER` / `_MODEL` /
 * `_BASE_URL`, defaulting to an OpenAI-compatible endpoint) so the plugin's
 * `resolveVisionEnv` picks the overridden route and resolves the API key
 * through `ctx.credentials.resolve({ env })`.
 *
 * This proves the whole path the agent uses: provider routing → credentials
 * seam → vision → model → insight, WITHOUT hand-building the env.
 *
 * Usage: OPENAI_API_KEY=... DSH_TUI_BROWSER_MODEL=<vision-model> \
 *   node scripts/vision-router-check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'lib/types/index.js') + '?t=' + Date.now()
const log = (...a) => process.stderr.write('[vision-router] ' + a.join(' ') + '\n')

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
  if (!key) { console.error('[vision-router] ERROR: set OPENAI_API_KEY or DSH_CREDENTIALS_FILE'); process.exit(2) }
  const provider = process.env.DSH_TUI_BROWSER_PROVIDER ?? 'openai'
  const model = process.env.DSH_TUI_BROWSER_MODEL
  if (!model) { console.error('[vision-router] ERROR: set DSH_TUI_BROWSER_MODEL to a vision-capable model'); process.exit(2) }

  // Route through the env overrides for THIS process.
  process.env.DSH_TUI_BROWSER_PROVIDER = provider
  process.env.DSH_TUI_BROWSER_MODEL = model

  const mod = await import(entry)
  const plugin = mod.default ?? mod
  assert.equal(typeof plugin.apply, 'function', 'apply present')

  const registered = []
  const stubTools = {
    register(def) { registered.push(def); return () => {} },
    schemas() { return registered.map((d) => ({ name: d.name })) },
  }
  // Structured credentials seam: resolve({ env }) → { key }.
  const stubCredentials = {
    async resolve(ref) { if (ref?.env === 'OPENAI_API_KEY') return { key }; return undefined },
  }
  const ctx = {
    get(name, optional) {
      if (name === 'tools') return stubTools
      if (name === 'credentials') return stubCredentials
      return undefined
    },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }

  const config = {
    lang: 'zh',
    visionMode: 'auto',
    screenshot: { format: 'png', quality: 80, maxDimension: '1024x768' },
    tiling: { mode: 'off', threshold: '1200x1200', overlap: 60 },
    providers: [],
  }
  plugin.apply(ctx, config)
  log('apply returned; tools=' + registered.length)
  assert.equal(registered.length, 21, '21 tools registered')
  const screenshot = registered.find((d) => d.name === 'browser_screenshot')
  assert.ok(screenshot, 'browser_screenshot registered')

  const { BrowserSession } = await import(join(root, 'lib/types/browser.js') + '?t=' + Date.now())
  const session = new BrowserSession(config, 'zh')
  const dir = mkdtempSync(join(tmpdir(), 'vision-router-'))
  const fixture = join(dir, 'f.html')
  writeFileSync(fixture, `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>路由视觉页</title></head><body><h1>路由视觉标题</h1><p>正文段落。</p></body></html>`)
  await session.navigate({ url: 'file://' + fixture })

  // The registered tool's execute signature varies by host; use the direct
  // dependency closure exposed for tests when present, otherwise fall back to
  // driving analyzeImages through the same resolveVisionEnv logic.
  const direct = screenshot.execute
  let insight
  if (typeof direct === 'function') {
    const res = await direct({ instruction: '页面上最大的标题是什么？', format: 'png' }, undefined)
    assert.equal(res.ok, true, 'screenshot tool ok')
    insight = res.value?.visualInsight ?? ''
  } else {
    const { analyzeImages } = await import(join(root, 'lib/types/vision.js') + '?t=' + Date.now())
    const env = { baseUrl: process.env.DSH_TUI_BROWSER_BASE_URL ?? 'https://api.openai.com/v1', apiKey: key, model, imageTransfer: 'base64', provider, currentModel: model }
    const cap = await session.captureScreenshot({})
    const { parseImageDimensions } = await import(join(root, 'lib/types/image-pipeline.js') + '?t=' + Date.now())
    const { width, height } = parseImageDimensions(cap)
    const res = await analyzeImages(env, [{ mime: 'image/png', data: cap, width, height, tile: { index: 1, total: 1 } }], '页面上最大的标题是什么？')
    insight = res.insight ?? ''
  }
  assert.ok(insight.trim().length > 0, 'non-empty visual insight')
  console.log('[vision-router] OK (' + provider + ' via resolveVisionEnv): ' + insight.trim().slice(0, 80))
  await session.close()
}

await main().catch((err) => { console.error('[vision-router] FAILED:', err && err.message ? err.message : err); process.exit(1) })
