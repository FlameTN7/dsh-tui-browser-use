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
 *   DSH_TUI_BROWSER_EXECUTABLE=/path/to/chrome \
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

  // type with clear + enter: clear the field, refill, and press Enter (no form, safe)
  const typ2 = await session.type({ selector: '#name', text: '小红', clear: true, enter: 'Enter' })
  console.log('[integ] type(clear+enter):', JSON.stringify(typ2))
  assert.equal(typ2.success, true, 'type(clear+enter) succeeded')
  const typed2 = await session.evaluate({ expression: "document.getElementById('name').value" })
  assert.equal(typed2.result, '小红', 'input cleared + refilled')

  // screenshot: returns a non-empty PNG buffer
  const buf = await session.captureScreenshot({})
  console.log('[integ] screenshot: bytes=', buf.length, 'signature=', buf.slice(0, 8).toString('hex'))
  assert.ok(buf.length > 1000, 'screenshot produced bytes')
  // PNG magic
  assert.ok(buf[0] === 0x89 && buf[1] === 0x50, 'screenshot is a PNG')

  // elementSummary: deprecated no-op (AGENTS.md §6: unified under browser_snapshot).
  const summary = await session.elementSummary()
  console.log('[integ] elementSummary (deprecated no-op):', JSON.stringify(summary))
  assert.equal(summary, '', 'elementSummary is a no-op')

  // snapshot: returns a structured a11y element index (role/name/bbox)
  const snap = await session.snapshot({})
  console.log('[integ] snapshot nodes=' + snap.nodes.length + ' roles=' + snap.nodes.map((n) => n.role).join(','))
  assert.ok(Array.isArray(snap.nodes) && snap.nodes.length >= 3, 'snapshot has >=3 nodes')
  const hasHeading = snap.nodes.some((n) => n.role === 'heading' && /集成测试/.test(n.name))
  const hasLink = snap.nodes.some((n) => n.role === 'link' && /跳到 B 区/.test(n.name))
  const hasButton = snap.nodes.some((n) => n.role === 'button' && /点我/.test(n.name))
  const hasTextbox = snap.nodes.some((n) => n.role === 'text' && /姓名/.test(n.name))
  assert.ok(hasHeading, 'snapshot lists heading by role+name')
  assert.ok(hasLink, 'snapshot lists link by role+name')
  assert.ok(hasButton, 'snapshot lists button by role+name')
  assert.ok(hasTextbox, 'snapshot lists textbox by role+name')
  for (const n of snap.nodes) {
    assert.ok(n.index > 0, 'index > 0')
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), 'has bounding box x/y')
    assert.ok(Number.isFinite(n.width) && Number.isFinite(n.height), 'has bounding box w/h')
  }

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
  const cap = await session.captureSegments()
  const segments = cap.buffers
  console.log('[integ] captureSegments: count=', segments.length, 'sizes=', segments.map((b) => b.length), 'truncated=', cap.truncated, 'planned=', cap.segmentsTotal)
  assert.ok(segments.length >= 2, 'tall page split into multiple segments')
  for (const seg of segments) {
    assert.ok(seg.length > 1000, 'each segment is a real screenshot')
    assert.ok(seg[0] === 0x89 && seg[1] === 0x50, 'each segment is a PNG')
  }

  // back: from the tall page back to the fixture page
  const back = await session.back()
  console.log('[integ] back:', JSON.stringify({ title: back.title, url: back.url }))
  assert.match(back.title, /集成测试/, 'back returns to fixture page')
  // forward: back to the tall page
  const fwd = await session.forward()
  console.log('[integ] forward:', JSON.stringify({ title: fwd.title, url: fwd.url }))
  assert.match(fwd.title, /高页面/, 'forward returns to tall page')
  // reload the tall page
  const rel = await session.reload()
  console.log('[integ] reload:', JSON.stringify({ title: rel.title, url: rel.url }))
  assert.match(rel.title, /高页面/, 'reload keeps tall page')

  // scroll the tall page down
  const scr = await session.scroll({ y: 200 })
  console.log('[integ] scroll:', JSON.stringify(scr))
  assert.ok(scr.y >= 200, 'scroll moved down')

  // wait: sleep a fixed ms
  const waitMs = await session.wait({ ms: 30 })
  assert.equal(waitMs.waited, true, 'wait(ms) returns waited')
  // wait: for a selector on the fixture — navigate back first
  await session.navigate({ url: pageUrl })
  const waitSel = await session.wait({ selector: '#name' })
  assert.equal(waitSel.waited, true, 'wait(selector) returns waited')
  assert.equal(waitSel.visible, true, 'wait(selector) found a visible element')

  // press a key (Enter on the page — safe, no focused input)
  const press = await session.press({ key: 'Enter' })
  assert.equal(press.success, true, 'press returns success')

  // mutex (P1 #9): two serialized tasks must never interleave — task B waits
  // for task A to fully settle, even though B was launched concurrently. This is
  // the primitive the tool registry funnels every browser call through.
  const runOrder: string[] = []
  await Promise.all([
    session.run(async () => {
      runOrder.push('a-start')
      await new Promise((r) => setTimeout(r, 30))
      runOrder.push('a-end')
    }),
    session.run(async () => {
      runOrder.push('b-start')
      await new Promise((r) => setTimeout(r, 10))
      runOrder.push('b-end')
    }),
  ])
  console.log('[integ] mutex order:', JSON.stringify(runOrder))
  assert.deepEqual(runOrder, ['a-start', 'a-end', 'b-start', 'b-end'], 'session.run serializes concurrent tasks')

  await session.close()
  console.log(`[integ] browser-use integration OK: ${executable || '(playwright/chrome auto)'} → ${status.version}`)
}

await main().catch((err) => {
  console.error('[integ] FAILED:', err)
  process.exit(1)
})
