#!/usr/bin/env node
/**
 * dsh-tui-browser-use — real external multi-step browser_task on a proxied site.
 *
 * Drives the registered `browser_task` tool against `https://duckduckgo.com`
 * through an HTTP proxy (most external sites need one).
 * The vision-driven loop: navigate → screenshot → model reads the search box →
 * type "Playwright" → read the page. Uses `tiling:'off'` so the screengrab is a
 * single first-viewport capture (fewer tokens per step).
 *
 * Usage: node scripts/real-task-ddg.mjs   (needs DSH_TUI_BROWSER_PROXY + vision key)
 */

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { probeApiKey } from './key-probe.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'lib/types/index.js') + '?t=' + Date.now()
const log = (...a) => process.stderr.write('[real-task-ddg] ' + a.join(' ') + '\n')

const PROXY = process.env.DSH_TUI_BROWSER_PROXY

async function main() {
  const key = probeApiKey('DEEPSEEK_API_KEY', { log })
  if (!key) { console.error('[real-task-ddg] ERROR: no DEEPSEEK_API_KEY reachable from this standalone process (checked process.env, $DSH_HOME/.credentials.yaml, .env, and a live dsh-tui process environ). Export DEEPSEEK_API_KEY or store it in ~/.dsh/.credentials.yaml to run this test.'); process.exit(2) }
  if (!PROXY) { console.error('[real-task-ddg] ERROR: set DSH_TUI_BROWSER_PROXY to an HTTP proxy'); process.exit(2) }
  process.env.DSH_TUI_BROWSER_PROXY = PROXY

  const mod = await import(entry)
  const plugin = mod.default ?? mod
  const registered = []
  const stubTools = { register(d){ registered.push(d); return () => {} }, schemas(){ return registered.map((d)=>({name:d.name})) } }
  const stubCredentials = { async resolve(ref){ if (ref?.env === 'DEEPSEEK_API_KEY') return { key }; return undefined } }
  const ctx = {
    get(name, optional){ if (name==='tools') return stubTools; if (name==='credentials') return stubCredentials; return undefined },
    effect(fn){ const d=fn(); return typeof d==='function'?d:()=>{} },
  }
  const config = { lang:'zh', visionMode:'deepseek-file-api', screenshot:{format:'jpeg',quality:80,maxDimension:'1440x900'}, tiling:{mode:'off',threshold:'1200x1200',overlap:60}, providers:[] }
  plugin.apply(ctx, config)
  log('apply returned; tools=' + registered.length)

  const task = registered.find((d) => d.name === 'browser_task')
  const nav = registered.find((d) => d.name === 'browser_navigate')
  assert.ok(task && nav)

  const navRes = await nav.execute({ url: 'https://duckduckgo.com' }, {})
  log('navigate: ' + JSON.stringify(navRes))

  const res = await task.execute({
    instruction: 'Look at the search box on this page. Type "Playwright" into the search input (selector textarea[name=q] or input[name=q]), then report the search box placeholder text you saw. If it is already typed, just report it.',
    maxSteps: 3,
  }, {})
  log('browser_task result: ' + JSON.stringify(res))
  assert.equal(res.ok, true, 'task ok')
  assert.ok(res.value.answer && res.value.answer.length > 0, 'task produced an answer')

  console.log('[real-task-ddg] OK (duckduckgo via proxy multi-step): answer="' + res.value.answer.trim().slice(0, 140) + '" steps=' + res.value.steps)
  process.exit(0)
}

await main().catch((err) => { console.error('[real-task-ddg] FAILED:', err && err.message ? err.message : err); process.exit(1) })
