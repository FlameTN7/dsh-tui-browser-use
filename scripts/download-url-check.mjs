/**
 * download-url-check — pure-logic regression for P1-13 (1.3).
 *
 * `browser_download` must request the ORIGINAL URL (a signed/token URL carries
 * auth in the query string and 403/404s if scrubbed first) but must surface only
 * a SANITIZED URL so a secret never leaks into the model context. `requestUrl`
 * / `displayUrl` separate those two intents.
 *
 * Run: `node --import tsx/esm scripts/download-url-check.mjs`
 */
import assert from 'node:assert/strict'

const { requestUrl, displayUrl, unsafeUrlKind } = await import('../src/download-url.js')
const { sanitizeUrl } = await import('../src/browser.js')

const SIGNED = 'https://cdn.example.com/file?token=abctoken123&sig=xyz&ok=1'
const REDIRECT = 'https://cdn.example.com/final.bin'

// 1. requestUrl returns the raw URL verbatim (signed/token query preserved).
{
  assert.equal(requestUrl(SIGNED), SIGNED, 'request URL is the raw value')
  console.log('[1] requestUrl keeps the raw signed URL verbatim — OK')
}

// 2. displayUrl sanitizes the URL it surfaces (secret scrubbed).
{
  const shown = displayUrl(SIGNED, '')
  assert.equal(shown, 'https://cdn.example.com/file?ok=1', 'display scrubs token/sig')
  assert.ok(!shown.includes('token='), 'no token in displayed URL')
  console.log('[2] displayUrl sanitizes the surfaced URL — OK')
}

// 3. displayUrl prefers the final (post-redirect) URL, sanitized.
{
  const shown = displayUrl(SIGNED, REDIRECT)
  assert.equal(shown, 'https://cdn.example.com/final.bin', 'final redirect URL wins')
  console.log('[3] displayUrl prefers the final redirect URL — OK')
}

// 4. displayUrl falls back to the raw URL when no final URL, still sanitized.
{
  const shown = displayUrl('https://x.com/a?key=secret', '')
  assert.equal(shown, 'https://x.com/a', 'no-final fallback sanitized')
  console.log('[4] displayUrl fallback sanitized — OK')
}

// 5. sanitizeUrl handles the target signatures (independent contract sanity).
{
  assert.equal(sanitizeUrl(SIGNED), 'https://cdn.example.com/file?ok=1')
  console.log('[5] sanitizeUrl scrubs the signed URL — OK')
}

// 6. P0-3 SSRF policy: `file:` and cloud-metadata/link-local are blocked by
//    default; `allowUnsafeUrl` opts out; loopback/RFC1918/relative stay allowed.
{
  assert.equal(unsafeUrlKind('file:///etc/passwd', false), 'file', 'file: blocked')
  assert.equal(unsafeUrlKind('file:///tmp/x.html', true), null, 'opt-in allows file:')
  assert.equal(unsafeUrlKind('http://169.254.169.254/latest/meta-data/', false), 'metadata', 'cloud metadata blocked')
  assert.equal(unsafeUrlKind('http://metadata.google.internal/foo', false), 'metadata', 'google metadata blocked')
  assert.equal(unsafeUrlKind('http://169.254.169.254/', true), null, 'opt-in allows metadata')
  assert.equal(unsafeUrlKind('http://127.0.0.1:3000/dev', false), null, 'loopback allowed (local dev)')
  assert.equal(unsafeUrlKind('http://192.168.1.10/x', false), null, 'RFC1918 allowed (local dev)')
  assert.equal(unsafeUrlKind('https://example.com/', false), null, 'normal https allowed')
  assert.equal(unsafeUrlKind('/relative/path', false), null, 'relative URL passes downstream')
  console.log('[6] unsafeUrlKind SSRF policy — OK')
}

console.log('\n[download-url-check] ALL PASS')
process.exit(0)
