/**
 * driver-contract-check — pure-logic regression for Phase 2.1 (竞品 B9).
 *
 * `BrowserDriver` is the seam that isolates Playwright behind an interface. It
 * must expose a stable method set so a stub/future driver (and the tool
 * registries that call through `BrowserSession`) never drift from the contract.
 * This script asserts (a) the default `PlaywrightDriver` actually implements
 * every required method + accessor, and (b) a minimal stub that shares the same
 * public surface is structurally compatible (i.e. the contract is honest).
 *
 * The driver is a FULL backend seam: it exposes semantic page/context-level
 * operations and does NOT leak a raw `page`/`context` handle. Navigation,
 * interaction, observation, cookies and download all route through driver
 * methods, so a non-Playwright backend can be swapped in without touching the
 * session.
 *
 * Run: `node --import tsx/esm scripts/driver-contract-check.mjs`
 */
import assert from 'node:assert/strict'

const { PlaywrightDriver } = await import('../src/driver/playwright-driver.js')

// The required method set from the BrowserDriver interface (lifecycle + all
// page/context primitives). The session owns only orchestration; every browser
// operation goes through these driver methods.
const METHODS = [
  'start', 'close', 'version', 'settleStable',
  'goto', 'goBack', 'goForward', 'reload', 'title', 'currentUrl', 'waitForLoadState',
  'click', 'fill', 'hover', 'press', 'waitForVisible',
  'evaluate', 'screenshot', 'pdf',
  'setViewportSize', 'storageState',
  'cookies', 'addCookies', 'clearCookies', 'requestGet',
]

// The required read-only accessors from the BrowserDriver interface. A raw
// `page`/`context` handle is deliberately NOT part of the contract.
const ACCESSORS = ['startError', 'running']

// 1. PlaywrightDriver implements every expected method on its prototype.
{
  const proto = PlaywrightDriver.prototype
  const own = new Set(Object.getOwnPropertyNames(proto))
  const missing = METHODS.filter((m) => !own.has(m))
  assert.deepEqual(missing, [], `PlaywrightDriver missing methods: ${missing.join(', ')}`)
  console.log('[1] PlaywrightDriver exposes all contract methods — OK')
}

// 2. Every expected accessor is present as a prototype getter.
{
  const proto = PlaywrightDriver.prototype
  const missingAccessors = ACCESSORS.filter((a) => {
    const desc = Object.getOwnPropertyDescriptor(proto, a)
    return !desc || typeof desc.get !== 'function'
  })
  assert.deepEqual(missingAccessors, [], `PlaywrightDriver missing accessors: ${missingAccessors.join(', ')}`)
  console.log('[2] PlaywrightDriver exposes all contract accessors — OK')
}

// 2b. The raw Playwright `page`/`context` handle must NOT be part of the public
//     driver surface. The whole point of the full-backend seam is that the
//     session/page-ops never see a handle — only semantic operations.
{
  const proto = PlaywrightDriver.prototype
  const leaked = ['page', 'context'].filter((a) => {
    const desc = Object.getOwnPropertyDescriptor(proto, a)
    return desc && typeof desc.get === 'function'
  })
  assert.deepEqual(leaked, [], `PlaywrightDriver must not expose page/context getters: ${leaked.join(', ')}`)
  console.log('[2b] PlaywrightDriver hides the raw page/context handle — OK')
}

// 3. A minimal stub sharing the same public surface is structurally usable.
//    This proves the contract is honest: a tester/extension author can swap the
//    backend with a stub that exposes the same method names, and the session's
//    delegation (ensureStarted → start, close, running) still holds.
{
  const stub = {
    startError: null,
    running: false,
    start: async () => false,
    close: async () => {},
    version: () => 'stub',
    settleStable: async () => {},
    goto: async () => ({ status: null, url: '' }),
    goBack: async () => ({ status: null, url: '' }),
    goForward: async () => ({ status: null, url: '' }),
    reload: async () => ({ status: null, url: '' }),
    title: async () => '',
    currentUrl: () => '',
    waitForLoadState: async () => {},
    click: async () => {},
    fill: async () => {},
    hover: async () => {},
    press: async () => {},
    waitForVisible: async () => {},
    evaluate: async () => undefined,
    screenshot: async () => Buffer.alloc(0),
    pdf: async () => Buffer.alloc(0),
    setViewportSize: async () => {},
    storageState: async () => ({}),
    cookies: async () => [],
    addCookies: async () => {},
    clearCookies: async () => {},
    requestGet: async () => { throw new Error('unused') },
  }
  // A BrowserSession can be constructed with such a driver without a type error
  // (structural compatibility) — the session delegates `start`/`close`/`running`
  // through the same seam.
  const { BrowserSession } = await import('../src/browser.js')
  const { loadRuntimeEnv } = await import('../src/runtime-env.js')
  const session = new BrowserSession({}, 'en', loadRuntimeEnv(), stub)
  assert.ok(session, 'BrowserSession accepts a structurally-compatible stub driver')
  // Delegating `ensureStarted` to a stub that always fails must surface as
  // `false` (never a throw), matching the "missing browser is a graceful error"
  // contract.
  assert.equal(await session.ensureStarted(), false, 'stub start failure surfaces as false')
  console.log('[3] a compatible stub driver satisfies the contract — OK')
}

// 4. The tool contract stays orthogonal to the driver: all 21 definitions
//    carry an object-rooted parameter schema and an execute function, so the
//    same schema set drives PlaywrightDriver and a stub backend alike (B9).
{
  const { buildToolDefinitions } = await import('../src/tools.js')
  const defs = buildToolDefinitions({ session: {}, lang: 'en' })
  assert.equal(defs.length, 21, '21 tool definitions')
  for (const d of defs) {
    assert.equal(d.parameters?.type, 'object', `${d.name} parameters are object-rooted`)
    assert.ok(d.parameters && typeof d.parameters === 'object' && 'properties' in d.parameters, `${d.name} declares properties`)
    assert.equal(typeof d.execute, 'function', `${d.name} has execute`)
  }
  console.log('[4] all 21 tool schemas are object-rooted + executable — OK')
}

console.log('\n[driver-contract-check] ALL PASS')
process.exit(0)
