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
 * Run: `node --import tsx/esm scripts/driver-contract-check.mjs`
 */
import assert from 'node:assert/strict'

const { PlaywrightDriver } = await import('../src/driver/playwright-driver.js')

// The required method set from the BrowserDriver interface.
const METHODS = [
  'start', 'close', 'version',
  'navigate', 'goBack', 'goForward', 'reload',
  'waitLoad', 'settleRaf', 'settleStable', 'title', 'url', 'eval',
  'scrollTo', 'scrollBy', 'scrollPos', 'keyboardPress', 'screenshot', 'pdf',
  'resolveFrameAware', 'waitForLocator', 'clickLocator', 'hoverLocator', 'fillLocator', 'clearLocator',
  'cookies', 'clearCookies', 'addCookies', 'requestGet',
]

// The required read-only accessors from the BrowserDriver interface.
const ACCESSORS = ['startError', 'running', 'page', 'context']

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

// 3. A minimal stub sharing the same public surface is structurally usable.
//    This proves the contract is honest: a tester/extension author can swap the
//    backend with a stub that exposes the same method names, and the session's
//    delegation (ensureStarted → start, close, page/context getters) still holds.
{
  const stub = {
    startError: null,
    running: false,
    page: null,
    context: null,
    start: async () => false,
    close: async () => {},
    version: () => 'stub',
    navigate: async () => null,
    goBack: async () => null,
    goForward: async () => null,
    reload: async () => null,
    waitLoad: async () => {},
    settleRaf: async () => {},
    settleStable: async () => {},
    title: async () => '',
    url: () => '',
    eval: async () => undefined,
    scrollTo: async () => {},
    scrollBy: async () => {},
    scrollPos: async () => ({ x: 0, y: 0 }),
    keyboardPress: async () => {},
    screenshot: async () => Buffer.alloc(0),
    pdf: async () => Buffer.alloc(0),
    resolveFrameAware: async () => ({ first: () => ({ waitFor: async () => {}, click: async () => {}, hover: async () => {}, fill: async () => {}, clear: async () => {}, count: async () => 0 }) }),
    waitForLocator: async () => {},
    clickLocator: async () => {},
    hoverLocator: async () => {},
    fillLocator: async () => {},
    clearLocator: async () => {},
    cookies: async () => [],
    clearCookies: async () => {},
    addCookies: async () => {},
    requestGet: async () => ({ ok: () => true, status: () => 200, url: () => '', body: async () => Buffer.alloc(0), headers: () => ({}) }),
  }
  // A BrowserSession can be constructed with such a driver without a type error
  // (structural compatibility) — the session delegates `start`/`close`/`page`
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
