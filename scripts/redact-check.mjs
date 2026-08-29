/**
 * redact-check — pure-logic regression for P1-04 (sensitive-data redaction).
 *
 * Verifies:
 *   1. `sanitizeUrl` deletes sensitive query params from a parseable absolute
 *      URL (so a signed/token URL never leaks its secret into the context);
 *   2. `sanitizeUrl` masks sensitive query params on a relative href (the
 *      non-parseable path, e.g. `/x?token=abc&ok=1` → `/x?token=***&ok=1`);
 *   3. `cookieValue` masks a cookie value by default and reads it only under
 *      an explicit `readValues: true`.
 *
 * Run: `node --import tsx/esm scripts/redact-check.mjs`
 */
import assert from 'node:assert/strict'

const { sanitizeUrl, cookieValue } = await import('../src/browser.js')

// 1. Absolute URL: sensitive query keys are deleted.
{
  const out = sanitizeUrl('https://example.com/x?token=abc&ok=1')
  assert.equal(out, 'https://example.com/x?ok=1')
  const out2 = sanitizeUrl('https://example.com/x?api_key=abc&sig=xyz&a=1')
  assert.equal(out2, 'https://example.com/x?a=1')
  console.log('[1] sanitizeUrl absolute: sensitive keys deleted — OK')
}

// 2. Relative / non-parseable href: sensitive query values masked with ***.
{
  const out = sanitizeUrl('/x?token=abc&ok=1')
  assert.equal(out, '/x?token=***&ok=1')
  const out2 = sanitizeUrl('?api_key=abc')
  assert.equal(out2, '?api_key=***')
  console.log('[2] sanitizeUrl relative: sensitive values masked — OK')
}

// 3. Cookie value masking.
{
  assert.equal(cookieValue('secret', false), '***')
  assert.equal(cookieValue('secret', true), 'secret')
  console.log('[3] cookieValue default masks, readValues reads — OK')
}

console.log('\n[redact-check] ALL PASS')
process.exit(0)
