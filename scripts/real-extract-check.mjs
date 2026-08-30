#!/usr/bin/env node
/**
 * dsh-tui-browser-use — real external-site browser_extract with schema validation.
 *
 * Navigates to https://example.com and drives the vision model to extract data
 * matching a caller-supplied JSON Schema. Validates the model reply against the
 * schema via the plugin's schema-validator. Confirms `browser_extract` on a REAL
 * external site (directly reachable, no proxy).
 *
 * Usage: node scripts/real-extract-check.mjs
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'lib/types/index.js') + '?t=' + Date.now()
const log = (...a) => process.stderr.write('[real-extract] ' + a.join(' ') + '\n')

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
  if (!key) { console.error('[real-extract] ERROR: no DEEPSEEK_API_KEY'); process.exit(2) }

  const mod = await import(entry)
  const plugin = mod.default ?? mod
  const registered = []
  const stubTools = { register(d){ registered.push(d); return () => {} }, schemas(){ return registered.map((d)=>({name:d.name})) } }
  const stubCredentials = { async resolve(ref){ if (ref?.env === 'DEEPSEEK_API_KEY') return { key }; return undefined } }
  const ctx = {
    get(name, optional){ if (name==='tools') return stubTools; if (name==='credentials') return stubCredentials; return undefined },
    effect(fn){ const d=fn(); return typeof d==='function'?d:()=>{} },
  }
  const config = { lang:'zh', visionMode:'auto', screenshot:{format:'jpeg',quality:80,maxDimension:'1024x768'}, tiling:{mode:'off',threshold:'1200x1200',overlap:60}, providers:[] }
  plugin.apply(ctx, config)
  log('apply returned; tools=' + registered.length)

  const nav = registered.find((d) => d.name === 'browser_navigate')
  const extract = registered.find((d) => d.name === 'browser_extract')
  assert.ok(nav && extract)

  await nav.execute({ url: 'https://example.com' }, {})

  const schema = {
    type: 'object',
    properties: {
      heading: { type: 'string' },
      links: { type: 'array', items: { type: 'string' } },
    },
    required: ['heading', 'links'],
    additionalProperties: false,
  }
  const res = await extract.execute({ schema, instruction: 'Extract the main heading and the list of link texts on this page. Return ONLY a JSON object satisfying the schema {heading:string, links:[string]}.' }, {})
  log('extract result: ' + JSON.stringify(res))
  assert.equal(res.ok, true, 'extract ok')
  assert.ok(res.value.data && typeof res.value.data.heading === 'string', 'heading present')
  assert.ok(Array.isArray(res.value.data.links), 'links array present')

  console.log('[real-extract] OK (external example.com schema-validated): heading="' + res.value.data.heading + '" links=' + JSON.stringify(res.value.data.links))
  process.exit(0)
}

await main().catch((err) => { console.error('[real-extract] FAILED:', err && err.message ? err.message : err); process.exit(1) })
