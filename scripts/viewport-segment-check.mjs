/**
 * viewport-segment-check — pure-logic regression for P1-11 (1.1).
 *
 * `BrowserSession.captureSegments()` must derive the tiling/scroll stepping
 * from the REAL viewport, not the deprecated `screenshot.maxDimension` alias
 * (the /settings viewport edit was ignored for stepping → tiles sized by a
 * stale default). Two layers lock this down:
 *
 *   1. `effectiveViewport()` resolution paths (pure function);
 *   2. an actual `BrowserSession.captureSegments()` run against a stub page:
 *      with `viewport: 800x600`, `maxDimension: 1920x1080` and a 2000x1000
 *      page, the scroll steps MUST be 740/540 (viewport − overlap 60), not
 *      1860/1020 (what the stale maxDimension would produce).
 *
 * Run: `node --import tsx/esm scripts/viewport-segment-check.mjs`
 */
import assert from 'node:assert/strict'

const { effectiveViewport, parseDimension } = await import('../src/capabilities.js')

// 1. Explicit viewport wins over a larger maxDimension alias (the bug).
{
  const vp = effectiveViewport({ viewport: { width: 800, height: 600 }, screenshot: { maxDimension: '1920x1080' } })
  assert.deepEqual(vp, { width: 800, height: 600 })
  console.log('[1] effectiveViewport: viewport wins over maxDimension — OK')
}

// 2. maxDimension alias still works when viewport is absent (back-compat).
{
  const vp = effectiveViewport({ viewport: undefined, screenshot: { maxDimension: '1920x1080' } })
  assert.deepEqual(vp, { width: 1920, height: 1080 })
  console.log('[2] effectiveViewport: maxDimension alias back-compat — OK')
}

// 3. Invalid viewport (zero dims) falls back to the maxDimension alias.
{
  const vp = effectiveViewport({ viewport: { width: 0, height: 0 }, screenshot: { maxDimension: '1280x720' } })
  assert.deepEqual(vp, { width: 1280, height: 720 })
  console.log('[3] effectiveViewport: invalid viewport falls back to maxDimension — OK')
}

// 4. Both invalid/absent → 1024×768 default (never zero, so stepX/stepY stay ≥1).
{
  const vp = effectiveViewport({ viewport: undefined, screenshot: { maxDimension: '' } })
  assert.equal(vp.width, 1024)
  assert.equal(vp.height, 768)
  assert.ok(vp.width > 0 && vp.height > 0)
  console.log('[4] effectiveViewport: default 1024x768, never zero — OK')
}

// 5. Non-finite viewport values are rejected (NaN → fallback), not passed through.
{
  const vp = effectiveViewport({ viewport: { width: NaN, height: 768 }, screenshot: { maxDimension: '1440x900' } })
  assert.deepEqual(vp, { width: 1440, height: 900 })
  console.log('[5] effectiveViewport: NaN viewport rejected, falls back — OK')
}

// 6. parseDimension helper stays sane (independent contract, used by effectiveViewport).
{
  assert.deepEqual(parseDimension('800x600'), { width: 800, height: 600 })
  assert.deepEqual(parseDimension('bogus'), { width: 0, height: 0 })
  console.log('[6] parseDimension: valid + invalid parse — OK')
}

// 7. End-to-end (no real browser): drive BrowserSession.captureSegments with a
//    stub page and assert the scroll steps come from viewport 800x600.
{
  const { BrowserSession } = await import('../src/browser.js')
  const { loadRuntimeEnv } = await import('../src/runtime-env.js')

  const scrolls = []
  const page = {
    async evaluate(expr) {
      const s = String(expr)
      if (s.includes('scrollWidth')) return { w: 2000, h: 1000 }
      if (s.includes('window.scrollTo(')) {
        const m = /window\.scrollTo\((\d+),\s*(\d+)\)/.exec(s)
        if (m) scrolls.push({ x: Number(m[1]), y: Number(m[2]) })
        return undefined
      }
      if (s.includes('requestAnimationFrame')) return undefined
      if (s.includes('scrollX')) return { x: 0, y: 0 }
      return undefined
    },
    async screenshot() { return Buffer.alloc(16) },
  }
  const driver = {
    get startError() { return null },
    get running() { return true },
    get page() { return page },
    get context() { return null },
    async start() { return true },
    async close() {},
    version() { return 'stub' },
    async settleStable() {},
  }

  const config = {
    visionMode: 'off',
    viewport: { width: 800, height: 600 },
    screenshot: { format: 'jpeg', quality: 80, maxDimension: '1920x1080' },
    tiling: { mode: 'on', threshold: '1200x1200', overlap: 60, maxTiles: 24 },
    providers: [],
  }
  const session = new BrowserSession(config, 'en', loadRuntimeEnv(), driver)
  const cap = await session.captureSegments()
  assert.equal(cap.buffers.length, 6, '2 rows × 3 columns planned for 2000x1000 at 800x600/overlap 60')
  assert.ok(scrolls.some((s) => s.x === 740), 'x step 740 = 800 viewport − 60 overlap (not maxDimension 1920)')
  assert.ok(scrolls.some((s) => s.x === 1480), 'second x column at 1480')
  assert.ok(scrolls.some((s) => s.y === 540), 'y step 540 = 600 viewport − 60 overlap (not maxDimension 1080)')
  assert.ok(!scrolls.some((s) => s.x === 1860 || s.y === 1020), 'no stale maxDimension stepping')
  await session.close()
  console.log('[7] captureSegments stepping follows real viewport — OK')
}

console.log('\n[viewport-segment-check] ALL PASS')
process.exit(0)
