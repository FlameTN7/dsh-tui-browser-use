#!/usr/bin/env node
/**
 * dsh-tui-browser-use — iframe interaction check (Block ①).
 *
 * Serves a same-origin http page whose button/input live inside an iframe, then
 * verifies the frame-aware locator can click by text and type inside the frame.
 * Uses `http://` (not `file://`) so the frame is same-origin and
 * `browser_evaluate` can read the result via `window.frames[0].document`.
 *
 * Usage: node scripts/iframe-check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'lib/types/browser.js') + '?t=' + Date.now()
const log = (...a) => process.stderr.write('[iframe] ' + a.join(' ') + '\n')

async function main() {
  const { BrowserSession } = await import(entry)
  process.env.DSH_TUI_BROWSER_EXECUTABLE = process.env.DSH_TUI_BROWSER_EXECUTABLE ?? '/opt/chromium-1148/chrome-linux/chrome'

  const dir = join(tmpdir(), 'iframe-check-' + Date.now())
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'frame.html'), `<!doctype html><html><head><meta charset="utf-8"><title>内</title></head><body><h1 id="t">框内初始</h1><button onclick="document.getElementById('t').textContent='框内点击'">框内按钮</button><input id="fi" placeholder="输入"></body></html>`)
  writeFileSync(join(dir, 'm.html'), `<!doctype html><html><head><meta charset="utf-8"><title>主</title></head><body><h1>主页面</h1><iframe id="fr" src="frame.html"></iframe></body></html>`)

  // Same-origin http server so the iframe is not cross-origin isolated.
  const server = createServer((req, res) => {
    const file = req.url === '/m.html' ? 'm.html' : req.url === '/frame.html' ? 'frame.html' : null
    if (!file) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(readFileSync(join(dir, file)))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  log('serving at http://127.0.0.1:' + port + '/m.html')

  const config = { lang:'zh', visionMode:'off', screenshot:{format:'jpeg',quality:80,maxDimension:'1024x768'}, tiling:{mode:'off',threshold:'1200x1200',overlap:60}, providers:[] }
  const s = new BrowserSession(config, 'zh')
  try {
    await s.navigate({ url: 'http://127.0.0.1:' + port + '/m.html' })

    const click = await s.click({ text: '框内按钮' })
    assert.equal(click.success, true, 'click by text inside iframe')
    const title = (await s.evaluate({ expression: "window.frames[0].document.getElementById('t').textContent" })).result
    assert.equal(title, '框内点击', 'click changed the iframe content')

    const type = await s.type({ selector: '#fi', text: '框内文本' })
    assert.equal(type.success, true, 'type inside iframe')
    const val = (await s.evaluate({ expression: "window.frames[0].document.getElementById('fi').value" })).result
    assert.equal(val, '框内文本', 'input received the text')

    await s.close()
    server.close()
    rmSync(dir, { recursive: true, force: true })
    console.log('[iframe] OK: click-by-text + type inside iframe (title="' + title + '" value="' + val + '")')
    process.exit(0)
  } catch (e) {
    try { await s.close() } catch { /* ignore */ }
    server.close()
    throw e
  }
}

await main().catch((err) => { console.error('[iframe] FAILED:', err && err.message ? err.message : err); process.exit(1) })
