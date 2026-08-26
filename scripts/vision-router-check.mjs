#!/usr/bin/env node
/**
 * dsh-tui-browser-use — provider-routed vision via the REAL apply() path.
 *
 * Unlike vision-mimo-check.mjs (which calls analyzeImages directly with a
 * hand-built env), this boots the plugin's `apply()` with a structured harness
 * context and then drives the REGISTERED `browser_screenshot` tool. It sets
 * `DSH_TUI_BROWSER_PROVIDER=xiaomi` so the plugin's `resolveVisionEnv` routes
 * to Xiaomi MiMo and resolves base64 transfer + the xiaomi API key through
 * `ctx.credentials.resolve({ env: 'XIAOMI_API_KEY' })`.
 *
 * This proves the whole path the agent uses: provider routing → credentials
 * seam → vision → model → insight, WITHOUT hand-building the env.
 *
 * Usage: node scripts/vision-router-check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'lib/types/index.js') + '?t=' + Date.now()
const log = (...a) => process.stderr.write('[vision-router] ' + a.join(' ') + '\n')

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
  if (!key) { console.error('[vision-router] ERROR: no XIAOMI_API_KEY'); process.exit(2) }

  // Route to xiaomi (base64) for THIS process.
  process.env.DSH_TUI_BROWSER_PROVIDER = 'xiaomi'
  process.env.DSH_TUI_BROWSER_EXECUTABLE = process.env.DSH_TUI_BROWSER_EXECUTABLE ?? '/opt/chromium-1148/chrome-linux/chrome'

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
    async resolve(ref) { if (ref?.env === 'XIAOMI_API_KEY') return { key }; return undefined },
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
    tiling: { mode: 'auto', threshold: '1200x1200', overlap: 60 },
    providers: [],
  }
  plugin.apply(ctx, config)
  log('apply returned; tools=' + registered.length)

  const shots = registered.find((d) => d.name === 'browser_screenshot')
  assert.ok(shots, 'browser_screenshot registered')

  // Navigate to a real local fixture, then screenshot with vision routing.
  const session = null
  const dir = mkdtempSync(join(tmpdir(), 'router-'))
  const fixture = join(dir, 'f.html')
  writeFileSync(fixture, `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>路由测试页</title></head><body><h1>路由集成标题</h1><p>路由正文。</p></body></html>`)

  const nav = registered.find((d) => d.name === 'browser_navigate')
  const navRes = await nav.execute({ url: 'file://' + fixture }, {})
  log('navigate: ' + JSON.stringify(navRes))
  assert.equal(navRes.ok, true, 'navigate ok')

  const res = await shots.execute({ instruction: 'What is the heading text on this page? One short sentence.' }, {})
  log('screenshot result: ' + JSON.stringify(res))
  assert.equal(res.ok, true, 'screenshot ok')
  assert.ok(res.value.visualInsight && res.value.visualInsight.length > 0, 'visual insight non-empty')
  assert.match(res.value.visualInsight, /路由集成标题|标题/, 'insight names the heading')

  console.log('[vision-router] OK (xiaomi via resolveVisionEnv): ' + res.value.visualInsight.trim().slice(0, 80))
  process.exit(0)
}

await main().catch((err) => { console.error('[vision-router] FAILED:', err && err.message ? err.message : err); process.exit(1) })
