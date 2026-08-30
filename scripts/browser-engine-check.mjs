#!/usr/bin/env node
/**
 * dsh-tui-browser-use — cross-engine browser check (chromium/firefox/webkit).
 *
 * Selects the Playwright engine via `DSH_TUI_BROWSER_ENGINE` (default chromium)
 * and verifies navigate + click(by text) + type + evaluate on a real page. For
 * chromium it honors `DSH_TUI_BROWSER_EXECUTABLE` (constrained containers) and
 * `DSH_TUI_BROWSER_PROXY` (hoster proxy for external sites); for firefox/webkit
 * it uses the engine's bundled binary.
 *
 * Usage:
 *   DSH_TUI_BROWSER_ENGINE=firefox node scripts/browser-engine-check.mjs
 *   DSH_TUI_BROWSER_ENGINE=chromium node scripts/browser-engine-check.mjs
 */

import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'lib/types/browser.js') + '?t=' + Date.now()
const log = (...a) => process.stderr.write('[browser-engine] ' + a.join(' ') + '\n')
const engine = process.env.DSH_TUI_BROWSER_ENGINE ?? 'chromium'

async function main() {
  const { BrowserSession } = await import(entry)

  const dir = mkdtempSync(join(tmpdir(), 'engine-'))
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>引擎页</title></head><body>
<h1 id="t">初始标题</h1>
<button onclick="document.getElementById('t').textContent='点击成功'">引擎按钮</button>
<input id="i" placeholder="输入">
</body></html>`
  const f = join(dir, 'e.html')
  writeFileSync(f, html)

  const config = { lang:'zh', visionMode:'off', screenshot:{format:'jpeg',quality:80,maxDimension:'1024x768'}, tiling:{mode:'off',threshold:'1200x1200',overlap:60}, providers:[] }
  const s = new BrowserSession(config, 'zh')
  try {
    await s.navigate({ url: 'file://' + f })
    const st = await s.status()
    log('engine=' + engine + ' version=' + st.version + ' available=' + st.available)

    const c = await s.click({ text: '引擎按钮' })
    assert.equal(c.success, true, 'click by text ok')
    const title = (await s.evaluate({ expression: "document.getElementById('t').textContent" })).result
    assert.equal(title, '点击成功', 'click changed title (engine=' + engine + ')')

    const t = await s.type({ selector: '#i', text: '跨引擎输入' })
    assert.equal(t.success, true, 'type ok')
    const val = (await s.evaluate({ expression: "document.getElementById('i').value" })).result
    assert.equal(val, '跨引擎输入', 'type filled input')

    await s.close()
    console.log('[browser-engine] OK engine=' + engine + ' version=' + st.version + ': click-by-text+type+evaluate all passed')
    process.exit(0)
  } catch (e) {
    try { await s.close() } catch { /* ignore */ }
    throw e
  }
}

await main().catch((err) => { console.error('[browser-engine] FAILED (' + engine + '):', err && err.message ? err.message : err); process.exit(1) })
