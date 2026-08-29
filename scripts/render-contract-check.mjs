/**
 * render-contract-check — pure-logic regression for P0-04/R-08/R-11.
 *
 * Verifies the model-facing render contract of the tool outputs:
 *   1. a failure envelope renders the canonical `[code] message` (not a throw);
 *   2. a success envelope appends a `[usage]` summary (token/cost visibility);
 *   3. an over-long value is truncated with an explicit marker;
 *   4. page-derived tools (renderUntrusted) only mark SUCCESSFUL results as
 *      `[untrusted page content]`, never a failure envelope (R-08).
 *
 * Run: `node --import tsx/esm scripts/render-contract-check.mjs`
 */
import assert from 'node:assert/strict'

const { renderText, renderUntrusted } = await import('../src/tools.js')

// 1. Failure envelope carries the canonical error code.
{
  const out = renderText({}, { ok: false, error: { code: 'schema-validation-failed', message: 'bad' } })
  assert.match(out[0].text, /^\[schema-validation-failed\] bad/)
  console.log('[1] failure render: [code] message — OK')
}

// 2. Success envelope appends a usage summary.
{
  const out = renderText({}, {
    ok: true,
    value: { visualInsight: 'x', fileId: '' },
    usage: { model: 'm', visionMode: 'auto', imagesSent: 2, promptTokens: 10, completionTokens: 5, promptCacheHitTokens: 1, promptCacheMissTokens: 2, costUsd: 0.01, costCny: 0.072 },
  })
  assert.match(out[0].text, /\[usage\] model=m images=2 prompt=10 completion=5 cacheHit=1/)
  assert.match(out[0].text, /costUsd=0\.01000 costCny=0\.0720/)
  console.log('[2] success render: [usage] summary — OK')
}

// 3. Over-long value is truncated with an explicit marker.
{
  const out = renderText({}, { ok: true, value: { result: 'x'.repeat(50000) } })
  const text = out[0].text
  assert.ok(text.includes('…(truncated, original'), 'truncation marker required')
  assert.ok(text.length < 15000, `text should be capped near MAX_RENDER_TEXT, got ${text.length}`)
  console.log('[3] huge value: truncated with marker — OK')
}

// 4a. renderUntrusted marks a SUCCESSFUL page-derived result.
{
  const out = renderUntrusted({}, { ok: true, value: { result: 'hello' } })
  assert.match(out[0].text, /^\[untrusted page content\]/)
  console.log('[4a] renderUntrusted ok:true → untrusted marker — OK')
}

// 4b. renderUntrusted does NOT mark a failure envelope (R-08).
{
  const out = renderUntrusted({}, { ok: false, error: { code: 'browser-error', message: 'boom' } })
  assert.ok(!out[0].text.startsWith('[untrusted page content]'), 'failure must not be labelled untrusted')
  assert.match(out[0].text, /^\[browser-error\] boom/)
  console.log('[4b] renderUntrusted failure → no untrusted marker — OK')
}

console.log('\n[render-contract-check] ALL PASS')
process.exit(0)
