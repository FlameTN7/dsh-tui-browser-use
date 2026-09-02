#!/usr/bin/env node
/**
 * p12-abort-check — real-browser regression for P1-2 (fully fixed).
 *
 * Reproduces the exact defect: `raceAbort` rejects the tool envelope when a
 * navigation's wall-clock budget fires, but the UNDERLYING Playwright `goto`
 * kept running on the shared page after the session queue released, so the next
 * tool could interleave with a stale navigation. The full fix quarantines the
 * stale op by discarding the page it ran on (the driver closes it) and lazily
 * provisions a fresh page for the next call.
 *
 * This drives the tool path (registry wraps each execute in `session.run`) minus
 * the harness: we queue a hung navigation behind an AbortSignal, abort it
 * mid-flight, then immediately queue an OK navigation and assert it lands on a
 * fresh page (correct title, no wedge, no stale-op interleaving).
 *
 * Run: `node --import tsx/esm scripts/p12-abort-check.mjs`
 * Requires a real browser (DSH_TUI_BROWSER_EXECUTABLE or Playwright/`/opt`
 * chromium). Skips if the browser cannot start.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { BrowserSession } from '../src/browser.js'

const log = (m) => process.stderr.write(`[p12] ${m}\n`)

async function main() {
  // A local server: `/hang` accepts the connection but never responds (a real
  // hung navigation), while `/ok` returns a known title.
  const srv = http.createServer((req, res) => {
    if (req.url === '/hang') return // never respond
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end('<html><head><title>OK-PAGE</title></head><body>ok</body></html>')
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = srv.address().port
  const hangUrl = `http://127.0.0.1:${port}/hang`
  const okUrl = `http://127.0.0.1:${port}/ok`

  const session = new BrowserSession(
    {
      visionMode: 'off',
      viewport: { width: 800, height: 600 },
      screenshot: { format: 'jpeg', quality: 80 },
      tiling: { mode: 'auto', threshold: '1200x1200', overlap: 60 },
      providers: [],
    },
    'zh',
  )

  let started = false
  try {
    // Prime the browser so a launch failure is reported as skip, not a cryptic
    // evaluate error. This also lets us report the environment honestly.
    started = await session.ensureStarted()
    if (!started) {
      log(`browser not available (${session.startError}) — SKIP`)
      return
    }

    // Queue a HUNG navigation and abort it mid-flight (replicates the tool path:
    // registry wraps each execute in `session.run`, so the next call queues
    // behind this one on the serial mutex).
    const ctl = new AbortController()
    const aborted = session
      .run(() => session.navigate({ url: hangUrl }, ctl.signal))
      .then(() => 'resolved', (e) => `rejected:${e?.code ?? e?.message}`)
    await new Promise((r) => setTimeout(r, 500))
    ctl.abort()

    const out1 = await aborted
    assert.match(out1, /^rejected:timed-out$/, `hung navigation should abort to timed-out, got: ${out1}`)
    log('hung navigation aborted to timed-out')

    // NEXT queued op must succeed on a FRESH page (no stale op interleaving, no
    // session wedge). This is the assertion that would have failed before the fix
    // (or flaked) because the stale goto kept mutating the shared page.
    const out2 = await session.run(() => session.navigate({ url: okUrl }))
    assert.equal(out2.title, 'OK-PAGE', `OK navigation should land on a fresh page, got title: ${out2.title}`)
    assert.equal(out2.status, 200, 'OK navigation returns HTTP 200')
    log('next op recovered on a fresh page (title=OK-PAGE)')

    console.log('[p12-abort-check] P1-2 PASS: stale op quarantined, session recovers on a fresh page')
  } finally {
    await session.close().catch(() => undefined)
    await new Promise((resolve) => srv.close(resolve))
  }
}

main().catch((err) => {
  log('FAILED: ' + (err && err.stack ? err.stack : err))
  process.exit(1)
})
