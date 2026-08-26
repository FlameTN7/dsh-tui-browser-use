#!/usr/bin/env node
/**
 * dsh-tui-browser-use — real external-site type/click interaction (with proxy).
 *
 * The container can reach only a few external sites directly (example.com);
 * most are gated behind the host proxy reachable at 127.0.0.1:10800. This check
 * drives `browser_navigate`/`browser_type`/`browser_click` against a real site
 * that needs the proxy. It reads `DSH_TUI_BROWSER_PROXY` (or falls back to the
 * known 127.0.0.1:10800 host proxy) and wires it to the browser launch.
 *
 * Usage: node scripts/real-interact-check.mjs
 */

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'lib/types/index.js') + '?t=' + Date.now()
const log = (...a) => process.stderr.write('[real-interact] ' + a.join(' ') + '\n')

// The container reaches most external sites only through the host proxy.
const PROXY = process.env.DSH_TUI_BROWSER_PROXY ?? 'http://127.0.0.1:10800'

async function main() {
  process.env.DSH_TUI_BROWSER_PROXY = PROXY
  process.env.DSH_TUI_BROWSER_EXECUTABLE = process.env.DSH_TUI_BROWSER_EXECUTABLE ?? '/opt/chromium-1148/chrome-linux/chrome'

  const mod = await import(entry)
  const plugin = mod.default ?? mod
  const registered = []
  const stubTools = { register(d){ registered.push(d); return () => {} }, schemas(){ return registered.map((d)=>({name:d.name})) } }
  const ctx = {
    get(name, optional){ if (name==='tools') return stubTools; return undefined },
    effect(fn){ const d=fn(); return typeof d==='function'?d:()=>{} },
  }
  const config = { lang:'zh', visionMode:'off', screenshot:{format:'jpeg',quality:80,maxDimension:'1440x900'}, tiling:{mode:'off',threshold:'1200x1200',overlap:60}, providers:[] }
  plugin.apply(ctx, config)
  log('apply returned; tools=' + registered.length)

  const nav = registered.find((d) => d.name === 'browser_navigate')
  const type = registered.find((d) => d.name === 'browser_type')
  const click = registered.find((d) => d.name === 'browser_click')
  const evalTool = registered.find((d) => d.name === 'browser_evaluate')
  assert.ok(nav && type && click && evalTool)

  const navRes = await nav.execute({ url: 'https://duckduckgo.com' }, {})
  log('navigate: ' + JSON.stringify(navRes))
  assert.equal(navRes.ok, true, 'navigate ok')
  const url = (await evalTool.execute({ expression: 'location.href' }, {})).value.result
  assert.ok(url.includes('duckduckgo'), 'reached duckduckgo via proxy')

  const typeRes = await type.execute({ selector: 'textarea[name=q], input[name=q]', text: 'DeepSeek AI' }, {})
  log('type: ' + JSON.stringify(typeRes))
  assert.equal(typeRes.ok, true, 'type ok')

  const clickRes = await click.execute({ selector: 'button[type=submit], input[type=submit], [aria-label*=Search], .search-button' }, {})
  log('click: ' + JSON.stringify(clickRes))
  assert.equal(clickRes.ok, true, 'click ok')

  console.log('[real-interact] OK (duckduckgo via proxy): type+click ok, url=' + url)
  process.exit(0)
}

await main().catch((err) => { console.error('[real-interact] FAILED:', err && err.message ? err.message : err); process.exit(1) })
