/**
 * viewport-segment-check — pure-logic regression for P1-11 (1.1).
 *
 * `BrowserSession.captureSegments()` and the tool prepare options must derive
 * the tiling/scroll stepping from the REAL viewport, not the deprecated
 * `screenshot.maxDimension` alias (the /settings viewport edit was ignored for
 * stepping → tiles sized by a stale default). `effectiveViewport()` is now the
 * single source of truth, so this locks its three resolution paths:
 *
 *   1. explicit `viewport` wins over `maxDimension` (the actual bug);
 *   2. `maxDimension` alias still works when `viewport` is absent (back-compat);
 *   3. both invalid/absent → 1024×768 default, and the viewport never returns a
 *      zero/negative dimension (which would break `stepX = vpW - overlap`).
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

console.log('\n[viewport-segment-check] ALL PASS')
process.exit(0)
