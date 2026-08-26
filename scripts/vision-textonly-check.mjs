#!/usr/bin/env node
/**
 * dsh-tui-browser-use — text-only model degrades vision to DOM fallback.
 *
 * Sets `DSH_TUI_BROWSER_MODEL=deepseek-v4-flash` (a non-multimodal model), so
 * the plugin's `resolveVisionEnv` must return null and `browser_screenshot`
 * fall back to the DOM elementSummary instead of sending a screenshot to a
 * model that cannot read it. Confirms the scnet-removal / text-only routing
 * decision end to end.
 *
 * Usage: node scripts/vision-textonly-check.mjs
 */

import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'lib/types/index.js') + '?t=' + Date.now()
const log = (...a) => process.stderr.write('[vision-textonly] ' + a.join(' ') + '\n')

async function main() {
  // Route to the official DeepSeek provider but with the TEXT-ONLY model.
  process.env.DSH_TUI_BROWSER_PROVIDER = 'deepseek'
  process.env.DSH_TUI_BROWSER_MODEL = 'deepseek-v4-flash'
  process.env.DSH_TUI_BROWSER_EXECUTABLE = process.env.DSH_TUI_BROWSER_EXECUTABLE ?? '/opt/chromium-1148/chrome-linux/chrome'

  const mod = await import(entry)
  const plugin = mod.default ?? mod

  const registered = []
  const stubTools = {
    register(def) { registered.push(def); return () => {} },
    schemas() { return registered.map((d) => ({ name: d.name })) },
  }
  const ctx = {
    get(name, optional) {
      if (name === 'tools') return stubTools
      if (name === 'credentials') return { async resolve() { return undefined } }
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

  const nav = registered.find((d) => d.name === 'browser_navigate')
  const shots = registered.find((d) => d.name === 'browser_screenshot')
  assert.ok(nav && shots)

  const dir = mkdtempSync(join(tmpdir(), 'textonly-'))
  const fixture = join(dir, 'f.html')
  writeFileSync(fixture, `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>文本模型页</title></head><body><h1>纯文本标题</h1><a href="/b">链接B</a><button>按钮C</button></body></html>`)
  await nav.execute({ url: 'file://' + fixture }, {})
  const res = await shots.execute({ instruction: 'read the heading' }, {})
  log('screenshot result: ' + JSON.stringify(res))
  assert.equal(res.ok, true, 'screenshot ok')

  // Vision must be OFF (visualInsight empty) and the DOM summary populated.
  assert.equal(res.value.visualInsight, '', 'text-only model → no visual insight')
  assert.ok(res.value.elementSummary.length > 0, 'DOM elementSummary populated')
  assert.match(res.value.elementSummary, /链接B|按钮C|纯文本标题/, 'elementSummary sees DOM content')

  console.log('[vision-textonly] OK (deepseek-v4-flash → DOM fallback): ' + res.value.elementSummary.replace(/\n/g, ' | ').slice(0, 80))
  process.exit(0)
}

await main().catch((err) => { console.error('[vision-textonly] FAILED:', err && err.message ? err.message : err); process.exit(1) })
