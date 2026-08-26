#!/usr/bin/env node
/**
 * dsh-tui-browser-use — container registration & runtime check.
 *
 * Loads the REAL built plugin (`lib/types/index.js`) against a minimal harness
 * context that exposes the `tools` service, and verifies:
 *   1. `apply` runs and registers exactly the 8 `browser.*` tools.
 *   2. `browser.status` actually launches a browser (via the executable probe)
 *      and reports `available: true` with a Chromium version.
 *
 * This exercises the same code path the real container dsh-tui uses (plugin
 * apply → registerTools → ctx.tools.register) without needing the full TTY
 * harness, so it is cheap to run as an end-to-end sanity gate.
 */

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'lib/types/index.js') + '?t=' + Date.now()
const log = (m) => process.stderr.write(`[container] ${m}\n`)

try {
  log('loading plugin: ' + entry)
  const mod = await import(entry)
  const plugin = mod.default ?? mod
  assert.ok(plugin, 'plugin loaded')
  assert.equal(plugin.name, 'dsh-tui-browser-use', 'plugin name')
  assert.equal(typeof plugin.apply, 'function', 'apply present')
  assert.deepEqual(plugin.inject, ['tools'], 'inject: [tools] invariant')
  log('plugin loaded, name=' + plugin.name)

  // ── Minimal harness context exposing the `tools` service ───────────────
  const registered = []
  const stubTools = {
    register(def) {
      registered.push(def)
      return () => {}
    },
    schemas() {
      return registered.map((d) => ({ name: d.name }))
    },
  }
  // The plugin injects the `settings` service to register the `browser-use`
  // settings namespace (fixes the TUI /settings "[命名空间未注册]"). Emulate a
  // minimal settings service + `ctx.inject` so apply() exercises that path.
  const registeredNamespaces = []
  const stubSettings = {
    register(ns, schema) {
      registeredNamespaces.push(ns)
      return () => {}
    },
  }
  const ctx = {
    get(name, optional) {
      if (name === 'tools') return stubTools
      if (name === 'settings') return stubSettings
      return undefined
    },
    inject(services, cb) {
      cb({ get: (n) => (n === 'settings' ? stubSettings : undefined) })
      return () => {}
    },
    effect(fn) {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
  }

  const config = {
    lang: 'zh',
    visionMode: 'auto',
    screenshot: { format: 'jpeg', quality: 80, maxDimension: '1024x768' },
    tiling: { mode: 'auto', threshold: '1200x1200', overlap: 60 },
    providers: [],
  }
  log('calling apply')
  plugin.apply(ctx, config)
  log('apply returned')

  // The settings namespace must have been registered (TUI /settings renders it
  // as served rather than "[命名空间未注册]").
  assert.ok(registeredNamespaces.includes('browser-use'), 'browser-use settings namespace registered')
  log('settings namespaces = ' + registeredNamespaces.join(','))

  const names = registered.map((d) => d.name)
  log('tools registered = ' + registered.length)
  log('names = ' + names.join(','))
  assert.equal(registered.length, 20, '20 browser tools registered')
  const expected = ['browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_evaluate', 'browser_extract', 'browser_task', 'browser_status', 'browser_snapshot', 'browser_back', 'browser_forward', 'browser_reload', 'browser_scroll', 'browser_press', 'browser_wait', 'browser_hover', 'browser_cookies', 'browser_console_messages', 'browser_network_requests', 'browser_pdf']
  for (const n of expected) assert.ok(names.includes(n), 'tool ' + n + ' present')

  // ── Exercise the real browser path through the registered tools ────────
  if (process.env.DSH_TUI_SKIP_BROWSER) {
    log('DSH_TUI_SKIP_BROWSER set — skipping live browser check')
    console.log('[container] dsh-tui-browser-use container check OK: 20 tools registered (browser skipped)')
    process.exit(0)
  }

  log('running browser.status')
  const statusDef = registered.find((d) => d.name === 'browser_status')
  const evDef = registered.find((d) => d.name === 'browser_evaluate')
  assert.ok(statusDef && evDef, 'status & evaluate present')
  const statusRes = await statusDef.execute({}, {})
  log('browser_status: ' + JSON.stringify(statusRes))
  assert.equal(statusRes.ok, true, 'browser_status returns ok')
  assert.equal(statusRes.value.available, true, 'browser is available')
  assert.match(statusRes.value.version, /^\d+(\.\d+)+/, 'version is dotted number: ' + statusRes.value.version)

  log('running browser.evaluate(1+2)')
  const evRes = await evDef.execute({ expression: '1 + 2' }, {})
  log('browser_evaluate(1+2): ' + JSON.stringify(evRes))
  assert.equal(evRes.ok, true, 'evaluate returns ok')
  assert.equal(evRes.value.result, 3, 'evaluate computed 1+2')

  log('running browser.snapshot')
  const snapDef = registered.find((d) => d.name === 'browser_snapshot')
  assert.ok(snapDef, 'snapshot present')
  const snapRes = await snapDef.execute({}, {})
  log('browser_snapshot: ' + JSON.stringify(snapRes).slice(0, 200))
  assert.equal(snapRes.ok, true, 'snapshot returns ok')
  assert.ok(Array.isArray(snapRes.value.nodes), 'snapshot returns a nodes array')

  console.log('[container] dsh-tui-browser-use container check OK: 20 tools registered, browser live (version=' + statusRes.value.version + ')')
  // The browser we launched keeps the Node event loop alive; exit explicitly so
  // a CI runner sees the success immediately instead of hanging on Chromium.
  process.exit(0)
} catch (err) {
  log('FAILED: ' + (err && err.stack ? err.stack : err))
  process.exit(1)
}
