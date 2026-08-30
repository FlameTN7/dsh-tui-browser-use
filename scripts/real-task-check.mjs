#!/usr/bin/env node
/**
 * dsh-tui-browser-use — real external-site multi-step browser_task.
 *
 * Boots the plugin's `apply()` (real provider routing) and drives the REGISTERED
 * `browser_task` tool against `https://example.com` (directly reachable from the
 * container, so no proxy is needed). This exercises the vision-driven multi-step
 * loop on a REAL external site: navigate → screenshot → model reads it → decides
 * the next action (or reports done).
 *
 * Usage: node scripts/real-task-check.mjs
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'lib/types/index.js') + '?t=' + Date.now()
const log = (...a) => process.stderr.write('[real-task] ' + a.join(' ') + '\n')

async function dshApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      if (!cmd.includes('--profile') || !cmd.includes('dsh-tui')) continue
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8')
      const hit = env.split('\0').find((s) => s.startsWith('DEEPSEEK_API_KEY='))
      if (hit) return hit.slice('DEEPSEEK_API_KEY='.length)
    } catch { /* pid vanished */ }
  }
  return null
}

async function main() {
  const key = await dshApiKey()
  if (!key) { console.error('[real-task] ERROR: no DEEPSEEK_API_KEY'); process.exit(2) }

  const mod = await import(entry)
  const plugin = mod.default ?? mod
  const registered = []
  const stubTools = { register(d){ registered.push(d); return () => {} }, schemas(){ return registered.map((d)=>({name:d.name})) } }
  const stubCredentials = { async resolve(ref){ if (ref?.env === 'DEEPSEEK_API_KEY') return { key }; return undefined } }
  const ctx = {
    get(name, optional){ if (name==='tools') return stubTools; if (name==='credentials') return stubCredentials; return undefined },
    effect(fn){ const d=fn(); return typeof d==='function'?d:()=>{} },
  }
  const config = { lang:'zh', visionMode:'auto', screenshot:{format:'jpeg',quality:80,maxDimension:'1024x768'}, tiling:{mode:'on',threshold:'1200x1200',overlap:60}, providers:[] }
  plugin.apply(ctx, config)
  log('apply returned; tools=' + registered.length)

  const task = registered.find((d) => d.name === 'browser_task')
  assert.ok(task, 'browser_task registered')

  const res = await task.execute({
    instruction: 'Navigate to https://example.com and report the page heading text. When you can see the heading, reply with done and the answer.',
    maxSteps: 4,
  }, {})
  log('browser_task result: ' + JSON.stringify(res))
  assert.equal(res.ok, true, 'task ok')
  assert.ok(res.value.answer && res.value.answer.length > 0, 'task produced an answer')
  assert.ok(res.value.steps >= 1, 'task took at least one step')

  console.log('[real-task] OK (external example.com multi-step): answer="' + res.value.answer.trim().slice(0, 120) + '" steps=' + res.value.steps + ' dur=' + res.value.durationS + 's')
  process.exit(0)
}

await main().catch((err) => { console.error('[real-task] FAILED:', err && err.message ? err.message : err); process.exit(1) })
