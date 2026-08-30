/**
 * session-start-failure-check — regression for P1-1 (persistent lock release).
 *
 * A failed `driver.start()` must not leave the persistent profile lock behind,
 * otherwise the NEXT ensureStarted() sees its own live PID in the lock and
 * silently degrades the session to isolated forever. This script drives the
 * real BrowserSession with stub drivers (no browser) and asserts:
 *
 *   A. start() → false twice: both attempts stay persistent/degraded=false and
 *      the lock file is gone after each failure.
 *   B. start() throws once: treated as a failed start, lock released, the next
 *      attempt stays persistent (driver contract hardening).
 *   C. a REAL lock conflict (foreign lock with a live PID) + failed start keeps
 *      `degraded:true` — the failure report must not erase the fallback reason.
 *
 * Run: `node --import tsx/esm scripts/session-start-failure-check.mjs`
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const rootBase = `/tmp/dsh-session-start-failure-${Date.now()}`
const persistentConfig = () => ({
  visionMode: 'off',
  screenshot: { format: 'jpeg', quality: 80, maxDimension: '1024x768' },
  tiling: { mode: 'off', threshold: '1200x1200', overlap: 60, maxTiles: 24 },
  providers: [],
  session: { mode: 'persistent', profile: 'default' },
})

async function load() {
  const [{ BrowserSession }, { loadRuntimeEnv }] = await Promise.all([
    import('../src/browser.js'),
    import('../src/runtime-env.js'),
  ])
  return { BrowserSession, loadRuntimeEnv }
}

function makeStubDriver(mode) {
  return {
    startError: mode === 'throw' ? null : 'stub-no-browser',
    running: false,
    page: null,
    context: null,
    async start() {
      if (mode === 'throw') throw new Error('stub start exploded')
      return false
    },
    async close() {},
    version() { return 'stub' },
    async navigate() { return null },
    async goBack() { return null },
    async goForward() { return null },
    async reload() { return null },
    async waitLoad() {},
    async settleRaf() {},
    async settleStable() {},
    async title() { return '' },
    url() { return '' },
    async eval() { return undefined },
    async scrollTo() {},
    async scrollBy() {},
    async scrollPos() { return { x: 0, y: 0 } },
    async keyboardPress() {},
    async screenshot() { return Buffer.alloc(0) },
    async pdf() { return Buffer.alloc(0) },
    async resolveFrameAware() { throw new Error('unused') },
    async waitForLocator() {},
    async clickLocator() {},
    async hoverLocator() {},
    async fillLocator() {},
    async clearLocator() {},
    async cookies() { return [] },
    async clearCookies() {},
    async addCookies() {},
    async requestGet() { throw new Error('unused') },
  }
}

async function scenarioA({ BrowserSession, loadRuntimeEnv }) {
  const root = join(rootBase, 'a')
  process.env.XDG_CACHE_HOME = root
  const env = loadRuntimeEnv()
  const session = new BrowserSession(persistentConfig(), 'zh', env, makeStubDriver('false'))
  const lockPath = join(root, 'dsh-tui-browser-use', 'profiles', 'default', 'lock')

  const first = await session.status()
  assert.equal(first.available, false, 'A: first start fails')
  assert.equal(first.session.mode, 'persistent', 'A: first failure keeps persistent mode')
  assert.equal(first.session.degraded, false, 'A: first failure is not degraded')
  assert.equal(existsSync(lockPath), false, 'A: lock released after first failed start')

  const second = await session.status()
  assert.equal(second.session.mode, 'persistent', 'A: second failure still persistent (no self-degradation)')
  assert.equal(second.session.degraded, false, 'A: second failure still not degraded')
  assert.equal(existsSync(lockPath), false, 'A: lock released after second failed start')

  await session.close()
  console.log('[A] failed start releases lock; repeated attempts stay persistent — OK')
}

async function scenarioB({ BrowserSession, loadRuntimeEnv }) {
  const root = join(rootBase, 'b')
  process.env.XDG_CACHE_HOME = root
  const env = loadRuntimeEnv()
  const session = new BrowserSession(persistentConfig(), 'zh', env, makeStubDriver('throw'))
  const lockPath = join(root, 'dsh-tui-browser-use', 'profiles', 'default', 'lock')

  const first = await session.status()
  assert.equal(first.available, false, 'B: throwing driver treated as failed start')
  assert.equal(existsSync(lockPath), false, 'B: lock released after a throwing start')

  // Replace the throwing driver with a false-returning one and prove the next
  // attempt is a clean persistent retry, not a poisoned degraded session.
  const repaired = new BrowserSession(persistentConfig(), 'zh', env, makeStubDriver('false'))
  const retry = await repaired.status()
  assert.equal(retry.session.mode, 'persistent', 'B: retry after throw stays persistent')
  assert.equal(retry.session.degraded, false, 'B: retry after throw is not degraded')

  await session.close()
  await repaired.close()
  console.log('[B] throwing driver releases lock; retry stays persistent — OK')
}

async function scenarioC({ BrowserSession, loadRuntimeEnv }) {
  const root = join(rootBase, 'c')
  process.env.XDG_CACHE_HOME = root
  const lockDir = join(root, 'dsh-tui-browser-use', 'profiles', 'default')
  const lockPath = join(lockDir, 'lock')
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 })

  const env = loadRuntimeEnv()
  const session = new BrowserSession(persistentConfig(), 'zh', env, makeStubDriver('false'))

  const first = await session.status()
  assert.equal(first.session.mode, 'isolated', 'C: live foreign lock degrades to isolated')
  assert.equal(first.session.degraded, true, 'C: degradation is reported')

  const second = await session.status()
  assert.equal(second.session.mode, 'isolated', 'C: foreign lock still degrades on retry')
  assert.equal(second.session.degraded, true, 'C: failed start must NOT erase the real degraded reason')

  await session.close()
  rmSync(lockPath, { force: true })
  console.log('[C] real lock conflict keeps degraded=true through failed starts — OK')
}

const { BrowserSession, loadRuntimeEnv } = await load()
await scenarioA({ BrowserSession, loadRuntimeEnv })
await scenarioB({ BrowserSession, loadRuntimeEnv })
await scenarioC({ BrowserSession, loadRuntimeEnv })
console.log('\n[session-start-failure-check] ALL PASS')
process.exit(0)
