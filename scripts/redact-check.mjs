/**
 * redact-check — pure-logic regression for P1-04 (sensitive-data redaction).
 *
 * Verifies:
 *   1. `sanitizeUrl` deletes sensitive query params from a parseable absolute
 *      URL (so a signed/token URL never leaks its secret into the context);
 *   2. `sanitizeUrl` masks sensitive query params on a relative href (the
 *      non-parseable path, e.g. `/x?token=abc&ok=1` → `/x?token=***&ok=1`);
 *   3. Basic-Auth userinfo is stripped (a password must never reach the model);
 *   4. composite keys (`auth_token`) match, lookalikes (`monkey`/`author`) do NOT;
 *   5. `cookieValue` masks a cookie value by default and reads it only under
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
  // Composite key segments match (`auth_token` contains `token`).
  const out3 = sanitizeUrl('https://example.com/x?auth_token=abc&ok=1')
  assert.equal(out3, 'https://example.com/x?ok=1')
  console.log('[1] sanitizeUrl absolute: sensitive keys deleted — OK')
}

// 2. Relative / non-parseable href: sensitive query values masked with ***.
{
  const out = sanitizeUrl('/x?token=abc&ok=1')
  assert.equal(out, '/x?token=***&ok=1')
  const out2 = sanitizeUrl('?api_key=abc')
  assert.equal(out2, '?api_key=***')
  // The caller's custom key list applies to relative URLs too (previous regex
  // fallback hard-coded the built-in list and ignored custom keys).
  const out3 = sanitizeUrl('/x?auth_token=abc&ok=1', ['auth_token'])
  assert.equal(out3, '/x?auth_token=***&ok=1')
  console.log('[2] sanitizeUrl relative: sensitive values masked — OK')
}

// 3. Lookalike query names are NOT wiped (substring matching was too greedy).
{
  const out = sanitizeUrl('https://example.com/x?monkey=1&hockey=2&author=me&ok=1')
  assert.equal(out, 'https://example.com/x?monkey=1&hockey=2&author=me&ok=1')
  console.log('[3] sanitizeUrl keeps lookalike query names — OK')
}

// 4. Basic-Auth userinfo is stripped from parseable URLs.
{
  const out = sanitizeUrl('https://alice:secretpass@example.com/page?token=x')
  assert.equal(out, 'https://example.com/page')
  assert.ok(!out.includes('secretpass'), 'password must never surface')
  console.log('[4] sanitizeUrl strips URL userinfo — OK')
}

// 5. Cookie value masking.
{
  assert.equal(cookieValue('secret', false), '***')
  assert.equal(cookieValue('secret', true), 'secret')
  console.log('[5] cookieValue default masks, readValues reads — OK')
}

console.log('\n[redact-check] ALL PASS')
process.exit(0)
