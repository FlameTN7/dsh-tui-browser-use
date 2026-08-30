#!/usr/bin/env node
/**
 * dsh-tui-browser-use smoke — verifies the plugin module and its pure
 * building blocks load and behave without a real browser or network.
 *
 * It does NOT launch Playwright (no `npx playwright install` required) and
 * does NOT call any vision provider. It exercises:
 *   - the plugin entry (name, Config schema, apply presence)
 *   - provider capability detection (`detectImageTransfer`)
 *   - screenshot preprocessing (`prepareScreenshot` on a tiny in-memory image)
 *   - tool definition construction (`buildToolDefinitions`) with no browser
 *   - config validation through the Schemastery `Config` schema
 */

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function loadAlt(specifiers) {
  for (const specifier of specifiers) {
    try { return await import(specifier) } catch { /* next */ }
  }
  return null
}

async function main() {
  // 1. Plugin entry.
  const plugin = await loadAlt([
    join(root, 'lib/types/index.js') + '?t=' + Date.now(),
    join(root, 'src/index.ts') + '?t=' + Date.now(),
  ])
  assert.ok(plugin, 'plugin module loaded')
  assert.equal(plugin.name, 'dsh-tui-browser-use', 'plugin name')
  assert.ok(typeof plugin.Config === 'function' || typeof plugin.Config === 'object', 'Config schema present')
  assert.equal(typeof plugin.apply, 'function', 'apply present')

  // Config schema validation via Schemastery.
  const Schema = (await loadAlt([
    join(root, 'node_modules/@deepseek-ai/schemastery/lib/index.js'),
  ]))?.default ?? null
  if (plugin.Config?.validate && Schema) {
    const good = plugin.Config.validate({})
    assert.ok(good, 'default config validates')
    const bad = plugin.Config.validate({ screenshot: { format: 'gif' } })
    assert.ok(bad?.length, 'invalid screenshot format rejected')
  }

  // 2. Provider capability detection.
  const caps = await loadAlt([
    join(root, 'lib/types/capabilities.js') + '?t=' + Date.now(),
    join(root, 'src/capabilities.ts') + '?t=' + Date.now(),
  ])
  assert.ok(caps, 'capabilities module loaded')
  assert.equal(typeof caps.detectImageTransfer, 'function', 'detectImageTransfer present')
  // Built-in official DeepSeek detection.
  assert.equal(caps.detectImageTransfer('deepseek', 'deepseek-chat', []), 'file', 'official deepseek -> file')
  // Model-name vision fallback for an unknown provider.
  assert.equal(caps.detectImageTransfer('acme', 'acme-vision', []), 'base64', 'vision in model name -> base64')
  // Explicit user override wins.
  assert.equal(
    caps.detectImageTransfer('acme', 'acme-chat', [{
      provider: 'acme', supportsVision: true, imageTransfer: 'base64',
    }]),
    'base64', 'user override imageTransfer honored',
  )
  // A provider with no vision and no override -> none.
  assert.equal(caps.detectImageTransfer('acme', 'acme-chat', []), 'none', 'no vision -> none')

  // 3. Screenshot preprocessing.
  const pipe = await loadAlt([
    join(root, 'lib/types/image-pipeline.js') + '?t=' + Date.now(),
    join(root, 'src/image-pipeline.ts') + '?t=' + Date.now(),
  ])
  assert.ok(pipe, 'image-pipeline module loaded')
  const prepared = pipe.prepareScreenshot(
    Buffer.from('not-a-real-image'),
    { format: 'jpeg', quality: 80, maxWidth: 1024, maxHeight: 768, tiling: 'off' },
  )
  assert.ok(Array.isArray(prepared), 'prepareScreenshot returns an array')
  assert.ok(typeof prepared[0]?.bytes === 'number', 'prepared image reports bytes')
  assert.ok(typeof prepared[0]?.oversize === 'boolean', 'prepared image reports oversize')

  // 4. Tool definitions.
  const tools = await loadAlt([
    join(root, 'lib/types/tools.js') + '?t=' + Date.now(),
    join(root, 'src/tools.ts') + '?t=' + Date.now(),
  ])
  assert.ok(tools, 'tools module loaded')
  const defs = tools.buildToolDefinitions({} as never)
  assert.ok(Array.isArray(defs), 'buildToolDefinitions returns array')
  const names = defs.map((d) => d.name)
  for (const expected of ['browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_evaluate', 'browser_extract', 'browser_task', 'browser_status', 'browser_snapshot', 'browser_back', 'browser_forward', 'browser_reload', 'browser_scroll', 'browser_press', 'browser_wait', 'browser_hover', 'browser_cookies', 'browser_console_messages', 'browser_network_requests', 'browser_pdf', 'browser_download']) {
    assert.ok(names.includes(expected), `tool ${expected} present`)
  }
  for (const d of defs) {
    assert.ok(typeof d.description === 'string' && d.description.length > 0, `${d.name} has description`)
    assert.ok(d.output && typeof d.output.schema === 'object', `${d.name} declares output schema`)
  }

  // P2-2.6: the delta seam is exposed on browser_snapshot and the action tools.
  assert.ok((defs.find((d) => d.name === 'browser_snapshot')?.parameters as { properties?: Record<string, unknown> })?.properties?.delta, 'browser_snapshot declares delta param')
  for (const name of ['browser_click', 'browser_type', 'browser_scroll']) {
    assert.ok((defs.find((d) => d.name === name)?.parameters as { properties?: Record<string, unknown> })?.properties?.delta, `${name} declares delta param`)
  }

  console.log(`[smoke] browser-use OK: plugin=${plugin.name}, tools=${names.length}, capabilities+preprocess verified`)
}

await main().catch((err) => {
  console.error('[smoke] FAILED:', err)
  process.exit(1)
})
