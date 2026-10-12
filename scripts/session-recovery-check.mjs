import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserSession } from '../src/browser.js'
import { PlaywrightDriver } from '../src/driver/playwright-driver.js'
import { loadRuntimeEnv } from '../src/runtime-env.js'
import { resolveSession, acquireLock, releaseLock } from '../src/session-profiles.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-recovery-'))
const saved = Object.fromEntries(['HOME', 'LOCALAPPDATA', 'XDG_CACHE_HOME'].map(k => [k, process.env[k]]))
for (const key of Object.keys(saved)) process.env[key] = root

const configFor = (mode, profile) => ({
  visionMode: 'off', viewport: { width: 800, height: 600 },
  screenshot: { format: 'jpeg', quality: 80 },
  tiling: { mode: 'off', threshold: '1200x1200', overlap: 60 }, providers: [],
  session: { mode, profile },
})

function fixture(config) {
  const env = loadRuntimeEnv(() => undefined)
  const paths = resolveSession(config, env)
  assert.ok(paths.root.startsWith(root), 'profile I/O stays in the test directory')
  let enteredNavigation
  const navigationStarted = new Promise(resolve => { enteredNavigation = resolve })
  let failPage = false
  let launches = 0
  const context = {
    browser: () => engine,
    newPage: async () => {
      if (failPage) throw new Error('page recovery failed')
      return { setViewportSize: async () => {}, on() {}, close: async () => {},
        goto: () => { enteredNavigation(); return new Promise(() => {}) } }
    },
    close: async () => {},
    storageState: async () => ({ cookies: [], origins: [] }),
    setStorageState: async () => {},
  }
  const engine = { close: async () => {}, version: () => 'test' }
  const driver = new PlaywrightDriver()
  // Replace browser creation only; use the real driver abort/page recovery.
  driver._pw = { chromium: { launchPersistentContext: async () => { launches++; return context } } }
  driver.resolveExecutablePath = () => undefined
  const session = new BrowserSession(config, 'en', env, driver)
  return { session, paths, navigationStarted, launches: () => launches,
    failRecovery: () => { failPage = true },
    async abort() {
      const controller = new AbortController()
      const result = session.navigate({ url: 'https://example.test/hang' }, controller.signal)
      const rejected = assert.rejects(result, e => e.code === 'timed-out')
      await navigationStarted
      controller.abort()
      await rejected
    },
  }
}

try {
  for (const mode of ['persistent', 'isolated']) {
    const f = fixture(configFor(mode, mode))
    try {
      assert.equal(await f.session.ensureStarted(), true)
      const before = (await f.session.status()).session
      await f.abort()
      assert.equal(await f.session.ensureStarted(), true)
      const after = (await f.session.status()).session
      assert.equal(after.mode, mode, 'page recovery preserves the active session mode')
      assert.equal(after.profileDir, before.profileDir, 'page recovery preserves the active directory')
      assert.equal(after.degraded, false)
      assert.equal(f.launches(), 1, 'recovery reuses the browser context')
      await f.session.close()
      if (mode === 'persistent') {
        assert.equal(existsSync(f.paths.lockPath), false, 'close releases the original lock')
        assert.deepEqual(JSON.parse(readFileSync(f.paths.storageStatePath, 'utf8')), { cookies: [], origins: [] })
      } else {
        assert.equal(existsSync(before.profileDir), false, 'close removes the original ephemeral directory')
      }
    } finally { await f.session.close() }
  }

  const failed = fixture(configFor('persistent', 'failed-recovery'))
  try {
    assert.equal(await failed.session.ensureStarted(), true)
    await failed.abort()
    failed.failRecovery()
    assert.equal(await failed.session.ensureStarted(), false)
    assert.equal(existsSync(failed.paths.lockPath), false, 'failed recovery releases the held lock')
  } finally { await failed.session.close() }

  const conflict = fixture(configFor('persistent', 'foreign-lock'))
  assert.equal(acquireLock(conflict.paths.lockPath).held, true)
  try {
    assert.equal(await conflict.session.ensureStarted(), true)
    const before = (await conflict.session.status()).session
    await conflict.abort()
    assert.equal(await conflict.session.ensureStarted(), true)
    const after = (await conflict.session.status()).session
    assert.equal(after.mode, 'isolated')
    assert.equal(after.degraded, true)
    assert.equal(after.profileDir, before.profileDir)
    await conflict.session.close()
    assert.equal(existsSync(conflict.paths.lockPath), true, 'foreign lock is untouched')
    assert.equal(existsSync(before.profileDir), false)
  } finally {
    await conflict.session.close()
    releaseLock(conflict.paths.lockPath)
  }
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
}
console.log('[session-recovery-check] ALL PASS')
