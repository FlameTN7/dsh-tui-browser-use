#!/usr/bin/env node
/**
 * dsh-tui-browser-use — live browser integration test.
 *
 * Drives the real `BrowserSession` through a Chromium binary to exercise the
 * browser-facing tools end-to-end WITHOUT any vision provider or network:
 *   navigate → evaluate → click → type → screenshot → elementSummary → status.
 *
 * It launches via `BrowserSession.ensureStarted`, which probes system Chrome,
 * then an explicit `DSH_TUI_BROWSER_EXECUTABLE`/known Chromium path, then
 * Playwright's bundled Chromium.
 *
 * Usage:
 *   DSH_TUI_BROWSER_EXECUTABLE=/opt/chromium-1148/chrome-linux/chrome \
 *     node --import tsx/esm scripts/browser-integration.ts
 */

import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import type { BrowserUseConfig } from '../src/types.js'
import { BrowserSession } from '../src/browser.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A default config matching the plugin's balanced defaults. */
function defaultConfig(): BrowserUseConfig {
  return {
    visionMode: 'auto',
    screenshot: { format: 'png', quality: 80, maxDimension: '1280x720' },
    tiling: { mode: 'auto', threshold: '1200x1200', overlap: 80 },
    providers: [],
  }
}

/** Write a small self-contained fixture page (no network) into a temp dir. */
function fixturePage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'browser-use-'))
  const html = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>浏览器集成测试页</title></head>
<body>
  <h1>集成测试</h1>
  <a id="link-a" href="#section-b">跳到 B 区</a>
  <button id="btn" onclick="document.getElementById('out').textContent='已点击'">点我</button>
  <input id="name" placeholder="姓名">
  <div id="out">初始</div>
  <div id="section-b">B 区内容</div>
</body>
</html>`
  const p = join(dir, 'fixture.html')
  writeFileSync(p, html)
  return p
}

async function main() {
  const executable = process.env.DSH_TUI_BROWSER_EXECUTABLE ?? ''
  const config = defaultConfig()
  const session = new BrowserSession(config, 'zh')
  const pageUrl = 'file://' + fixturePage()

  // status before start: available may be false or undefined-and-false.
  const statusEarly = await session.status()
  console.log('[integ] status(early):', JSON.stringify({ available: statusEarly.available, version: statusEarly.version }))

  // navigate
  const nav = await session.navigate({ url: pageUrl })
  console.log('[integ] navigate:', JSON.stringify(nav))
  assert.match(nav.title, /集成测试/, 'title matches fixture')
  assert.equal(nav.url, pageUrl, 'url matches fixture')

  // evaluate
  const ev = await session.evaluate({ expression: 'document.title' })
  console.log('[integ] evaluate:', JSON.stringify(ev.result))
  assert.equal(ev.result, '浏览器集成测试页', 'evaluate returns title')

  // type: fill the input
  const typ = await session.type({ selector: '#name', text: '小明' })
  console.log('[integ] type:', JSON.stringify(typ))
  assert.equal(typ.success, true, 'type succeeded')
  const typedVal = await session.evaluate({ expression: "document.getElementById('name').value" })
  assert.equal(typedVal.result, '小明', 'input value filled')

  // click: trigger the button which rewrites #out text
  const clk = await session.click({ selector: '#btn' })
  console.log('[integ] click:', JSON.stringify(clk))
  assert.equal(clk.success, true, 'click succeeded')
  const outText = await session.evaluate({ expression: "document.getElementById('out').textContent" })
  assert.equal(outText.result, '已点击', 'button onclick ran')

  // screenshot: returns a non-empty PNG buffer
  const buf = await session.captureScreenshot({})
  console.log('[integ] screenshot: bytes=', buf.length, 'signature=', buf.slice(0, 8).toString('hex'))
  assert.ok(buf.length > 1000, 'screenshot produced bytes')
  // PNG magic
  assert.ok(buf[0] === 0x89 && buf[1] === 0x50, 'screenshot is a PNG')

  // elementSummary: should list the link/button/input
  const summary = await session.elementSummary()
  console.log('[integ] elementSummary:\n' + summary)
  assert.match(summary, /跳到 B 区/, 'summary lists the link')
  assert.match(summary, /点我/, 'summary lists the button')
  assert.match(summary, /姓名/, 'summary lists the input placeholder')

  // status after start: available true, version present
  const status = await session.status()
  console.log('[integ] status:', JSON.stringify({ available: status.available, version: status.version }))
  assert.equal(status.available, true, 'browser available after start')
  assert.match(status.version, /^\d+(\.\d+)+/, 'version is a dotted number: ' + status.version)

  // tiling: navigate to a tall fixture page and confirm scroll-capture split.
  const tallHtml = `<!doctype html><html><head><meta charset="utf-8"><title>高页面</title></head>
<body style="margin:0">${Array.from({ length: 20 }, (_, i) => `<div style="height:200px;border:1px solid #ccc">块 ${i + 1}</div>`).join('')}</body></html>`
  const d = mkdtempSync(join(tmpdir(), 'browser-tall-'))
  const tallPath = join(d, 'tall.html')
  writeFileSync(tallPath, tallHtml)
  await session.navigate({ url: 'file://' + tallPath })
  const segments = await session.captureSegments()
  console.log('[integ] captureSegments: count=', segments.length, 'sizes=', segments.map((b) => b.length))
  assert.ok(segments.length >= 2, 'tall page split into multiple segments')
  for (const seg of segments) {
    assert.ok(seg.length > 1000, 'each segment is a real screenshot')
    assert.ok(seg[0] === 0x89 && seg[1] === 0x50, 'each segment is a PNG')
  }

  await session.close()
  console.log(`[integ] browser-use integration OK: ${executable || '(playwright/chrome auto)'} → ${status.version}`)
}

await main().catch((err) => {
  console.error('[integ] FAILED:', err)
  process.exit(1)
})
