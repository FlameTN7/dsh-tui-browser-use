#!/usr/bin/env node
/**
 * dsh-tui-browser-use — dynamic/SPA page robustness check (Block D).
 *
 * Verifies the locator strategy on pages that mount content lazily (SPA /
 * async-rendered):
 *   - `browser_click({ text })` finds a button by visible text (not CSS class,
 *     which dynamic sites recompile/hash).
 *   - `browser_type` waits for a late-mounted input (waitForLocator retry) before
 *     filling it.
 *   - a button added to the DOM after load is still clickable by text.
 * Also confirms `browser_evaluate` can reach into a shadow root (Playwright's
 * CSS pierce is not needed when the caller just needs to read/act on it).
 *
 * Usage: node scripts/dynamic-page-check.mjs
 */

import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'lib/types/browser.js') + '?t=' + Date.now()
const log = (...a) => process.stderr.write('[dynamic] ' + a.join(' ') + '\n')

// P0-3: deliberate local `file://` fixture → opt in to the SSRF relaxation.
process.env.DSH_TUI_BROWSER_ALLOW_UNSAFE_URL = '1'

async function main() {
  const { BrowserSession } = await import(entry)

  const dir = mkdtempSync(join(tmpdir(), 'dyn-'))
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>动态页</title></head><body>
<h1 id="title">初始标题</h1>
<button onclick="document.getElementById('title').textContent='点击成功'">动态按钮</button>
<input id="lazyInput" style="display:none">
<div id="host"></div>
<script>
  setTimeout(() => { document.getElementById('lazyInput').style.display='block'; document.getElementById('lazyInput').placeholder='懒加载输入'; }, 1500);
  setTimeout(() => { const b=document.createElement('button'); b.textContent='懒按钮'; b.id='lazyBtn'; document.body.appendChild(b); }, 800);
  const host=document.getElementById('host'); const sh=host.attachShadow({mode:'open'});
  sh.innerHTML = '<button id="shadowBtn">影子按钮</button>';
</script>
</body></html>`
  const f = join(dir, 'dyn.html')
  writeFileSync(f, html)

  const config = { lang:'zh', visionMode:'off', screenshot:{format:'jpeg',quality:80,maxDimension:'1024x768'}, tiling:{mode:'off',threshold:'1200x1200',overlap:60}, providers:[] }
  const s = new BrowserSession(config, 'zh')
  try {
    await s.navigate({ url: 'file://' + f })

    const c1 = await s.click({ text: '动态按钮' })
    assert.equal(c1.success, true, 'click by visible text ok')
    const title = (await s.evaluate({ expression: "document.getElementById('title').textContent" })).result
    assert.equal(title, '点击成功', 'click clicked the button (title changed)')

    const t1 = await s.type({ selector: '#lazyInput', text: '输入内容ABC' })
    assert.equal(t1.success, true, 'type into late-mounted input ok')
    const val = (await s.evaluate({ expression: "document.getElementById('lazyInput').value" })).result
    assert.equal(val, '输入内容ABC', 'input received the typed text')

    const c2 = await s.click({ text: '懒按钮' })
    assert.equal(c2.success, true, 'click late-added button by text ok')

    const shadowText = (await s.evaluate({ expression: "document.getElementById('host').shadowRoot.querySelector('#shadowBtn').textContent" })).result
    assert.equal(shadowText, '影子按钮', 'shadow root reachable via evaluate')

    await s.close()
    console.log('[dynamic] OK (SPA/lazy text+role locator, waitFor, shadow via evaluate): title after click="' + title + '" lazy value="' + val + '"')
    process.exit(0)
  } catch (e) {
    try { await s.close() } catch { /* ignore */ }
    throw e
  }
}

await main().catch((err) => { console.error('[dynamic] FAILED:', err && err.message ? err.message : err); process.exit(1) })
