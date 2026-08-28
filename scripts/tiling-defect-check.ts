#!/usr/bin/env node
/**
 * dsh-tui-browser-use — live tiling-defect regression test.
 *
 * Black-box verification of the three scroll-capture tiling defects found in
 * `docs/tiling-verification-findings.zh.md` (roadmap P2 #10):
 *   1. no truncation reporting — a page needing more tiles than `maxTiles`
 *      silently drops the tail;
 *   2. no horizontal split — a page wider than the viewport is clipped to the
 *      left viewport, losing everything to the right;
 *   3. seam overlap duplication.
 *
 * This drives the real `BrowserSession` (no vision, no network) and asserts on
 * the capture geometry returned by `captureSegments`:
 *   A. small page → single tile, not truncated (control);
 *   B. wide page → multiple columns, captured extent beyond the left viewport;
 *   C. very tall page with a lowered `maxTiles` → truncation is reported.
 *
 * Fix #3 (overlap dedup guidance) is a static addition to the vision system
 * prompt, verified in `scripts/vision-prompt-fence-check.mjs`; this test focuses
 * on the capture geometry of #1 and #2.
 *
 * Usage:
 *   DSH_TUI_BROWSER_EXECUTABLE=/opt/chromium-1148/chrome-linux/chrome \
 *     node --import tsx/esm scripts/tiling-defect-check.ts
 */

import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserUseConfig } from '../src/types.js'
import { BrowserSession } from '../src/browser.js'

/** Match the plugin's balanced defaults (viewport 1024x768, auto, 60px overlap). */
function config(): BrowserUseConfig {
  return {
    visionMode: 'off',
    screenshot: { format: 'png', quality: 80, maxDimension: '1024x768' },
    tiling: { mode: 'auto', threshold: '1200x1200', overlap: 60 },
    providers: [],
  }
}

function tallPage(blocks: number, blockH = 1000): string {
  const body = Array.from({ length: blocks }, (_, i) =>
    `<div style="height:${blockH}px;border:1px solid #ccc">T${String(i + 1).padStart(2, '0')}</div>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>tall</title></head><body style="margin:0">${body}</body></html>`
}

function widePage(width: number, height = 768): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>wide</title><style>body{margin:0}.strip{height:${height}px;width:${width}px}</style></head><body><div class="strip">WIDE</div></body></html>`
}

function gridPage(width: number, height: number, blockW = 1000, blockH = 1000): string {
  const strips: string[] = []
  for (let y = 0; y < height; y += blockH) {
    const row: string[] = []
    for (let x = 0; x < width; x += blockW) {
      row.push(`<div style="position:absolute;left:${x}px;top:${y}px;width:${blockW}px;height:${blockH}px;border:1px solid #999">G${y / blockH}x${x / blockW}</div>`)
    }
    strips.push(row.join(''))
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>grid</title></head><body style="margin:0"><div style="position:relative;width:${width}px;height:${height}px">${strips.join('')}</div></body></html>`
}

function step(msg: string): void {
  process.stdout.write('[tiling-defect] ' + msg + '\n')
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'tiling-defect-'))
  const s = new BrowserSession(config(), 'zh')

  // A) Control: small page → single tile, not truncated.
  {
    const p = join(dir, 'small.html')
    writeFileSync(p, `<!doctype html><html><head><title>small</title></head><body style="margin:0"><div style="height:700px">S</div></body></html>`)
    await s.navigate({ url: 'file://' + p })
    const cap = await s.captureSegments()
    step(`A small page: buffers=${cap.buffers.length} truncated=${cap.truncated} planned=${cap.segmentsTotal}`)
    assert.equal(cap.buffers.length, 1, 'small page → single tile')
    assert.equal(cap.truncated, false, 'small page is not truncated')
    assert.equal(cap.segmentsTotal, 1, 'small page plans one tile')
  }

  // B) Wide page → multiple columns, not clipped to the left viewport (defect #2).
  {
    const p = join(dir, 'wide.html')
    writeFileSync(p, widePage(6000))
    await s.navigate({ url: 'file://' + p })
    const cap = await s.captureSegments()
    step(`B wide page: buffers=${cap.buffers.length} truncated=${cap.truncated} planned=${cap.segmentsTotal} capturedWidth=${cap.capturedWidth} pageWidth=${cap.pageWidth}`)
    assert.ok(cap.buffers.length > 1, 'wide page split into multiple columns')
    assert.ok(cap.capturedWidth > 1024, 'captured beyond the left viewport')
  }

  // C) Very tall page with a lowered maxTiles → truncation reported (defect #1).
  {
    const p = join(dir, 'tall.html')
    writeFileSync(p, tallPage(30, 1000)) // 30000px → ~43 rows
    await s.navigate({ url: 'file://' + p })
    const prev = process.env.DSH_TUI_BROWSER_MAX_TILES
    process.env.DSH_TUI_BROWSER_MAX_TILES = '3'
    const cap = await s.captureSegments()
    if (prev === undefined) delete process.env.DSH_TUI_BROWSER_MAX_TILES
    else process.env.DSH_TUI_BROWSER_MAX_TILES = prev
    step(`C tall page (maxTiles=3): buffers=${cap.buffers.length} truncated=${cap.truncated} planned=${cap.segmentsTotal} capturedHeight=${cap.capturedHeight} pageHeight=${cap.pageHeight}`)
    assert.equal(cap.captured, 3, 'capped at maxTiles')
    assert.equal(cap.truncated, true, 'truncation is reported')
    assert.ok(cap.segmentsTotal > 3, 'planned segments exceed the cap')
  }

  // D) Wide+tall grid under the cap → ROW-major: a full-width top band is read
  // before moving down (not a full-height left column that leaves every other
  // column unread). This guards the reading-order fix.
  {
    const p = join(dir, 'grid.html')
    writeFileSync(p, gridPage(5000, 3000)) // → 6 cols x 5 rows = 30 tiles
    await s.navigate({ url: 'file://' + p })
    const prev = process.env.DSH_TUI_BROWSER_MAX_TILES
    // Cap to exactly the column count: row-major reads one full band (all 6
    // columns) → capturedWidth == full page width; column-major would read the
    // whole left column (full height) and only ~2 columns wide.
    process.env.DSH_TUI_BROWSER_MAX_TILES = '6'
    const cap = await s.captureSegments()
    if (prev === undefined) delete process.env.DSH_TUI_BROWSER_MAX_TILES
    else process.env.DSH_TUI_BROWSER_MAX_TILES = prev
    step(`D grid (maxTiles=6): buffers=${cap.buffers.length} truncated=${cap.truncated} planned=${cap.segmentsTotal} capturedWidth=${cap.capturedWidth} capturedHeight=${cap.capturedHeight} pageWidth=${cap.pageWidth} pageHeight=${cap.pageHeight}`)
    assert.equal(cap.captured, 6, 'capped at maxTiles (== columns)')
    assert.ok(cap.capturedWidth >= cap.pageWidth, 'row-major: first band spans the full width')
    assert.ok(cap.capturedHeight < cap.pageHeight / 2, 'row-major: only the top band is read, not the whole height')
  }

  await s.close()
  step('ALL PASS')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
