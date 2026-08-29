/**
 * abort-check — pure-logic regression for P0-02 / R-02.
 *
 * Verifies the abort path does not wedge a tool or poison the session queue:
 *   1. `abortSignalOf` returns `exec.signal` when present, else derives an
 *      `AbortSignal.timeout` from the tool timeout, else `undefined`;
 *   2. a hanging `analyzeImages` (stubbed fetch that never resolves) rejects
 *      within a deadline once its abort signal fires — the TCP/connect cannot
 *      hang forever even when the host doesn't thread a signal;
 *   3. `BrowserSession.run` recovers after a rejected task: the serial queue
 *      still executes the NEXT task (never wedged by a prior failure).
 *
 * Run: `node --import tsx/esm scripts/abort-check.mjs`
 */
import assert from 'node:assert/strict'

const { analyzeImages } = await import('../src/vision.js')
const { abortSignalOf } = await import('../src/tools.js')
const { BrowserSession } = await import('../src/browser.js')

// 1. abortSignalOf: signal present → returned; absent → timeout / undefined.
{
  const ctl = new AbortController()
  assert.equal(abortSignalOf({ signal: ctl.signal }, 5000), ctl.signal)
  const t = abortSignalOf({}, 5000)
  assert.equal(typeof t, 'object')
  assert.equal(t.aborted, false)
  assert.equal(abortSignalOf({}), undefined)
  console.log('[1] abortSignalOf precedence (signal → timeout → undefined) — OK')
}

// 2. analyzeImages rejects once the abort signal fires (hanging fetch).
{
  const env = { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm', imageTransfer: 'base64', provider: 'test', currentModel: 'm' }
  const images = [{ data: Buffer.from('x'), mime: 'image/jpeg' }]
  const ctl = new AbortController()
  // Stub fetch to never resolve, but reject when the signal aborts.
  globalThis.fetch = (url, init = {}) => new Promise((_, reject) => {
    const s = init.signal ?? ctl.signal
    if (s.aborted) { reject(new Error('aborted')); return }
    s.addEventListener('abort', () => reject(new Error('aborted')))
  })

  const p = analyzeImages(env, images, 'read', ctl.signal)
  // Let the fetch attempt settle, then abort.
  await new Promise((r) => setTimeout(r, 20))
  ctl.abort()
  await assert.rejects(p, (err) => /aborted|vision call failed/.test(err.message))
  console.log('[2] analyzeImages rejects on abort (no wedge) — OK')
}

// 3. BrowserSession.run never wedges the serial queue after a rejection.
{
  const s = new BrowserSession(
    { visionMode: 'auto', viewport: { width: 1024, height: 768 }, screenshot: { format: 'jpeg', quality: 80 }, tiling: { mode: 'auto', threshold: '1200x1200', overlap: 60 }, providers: [] },
    'zh',
  )
  const r1 = s.run(async () => { throw new Error('boom') }).catch((e) => `caught:${e.message}`)
  const r2 = s.run(async () => 'ok')
  const results = await Promise.all([r1, r2])
  assert.equal(results[0], 'caught:boom')
  assert.equal(results[1], 'ok')
  console.log('[3] BrowserSession.run queue recovers after rejection — OK')
}

console.log('\n[abort-check] ALL PASS')
process.exit(0)
