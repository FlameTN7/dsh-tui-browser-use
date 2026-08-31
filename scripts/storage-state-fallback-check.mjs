/**
 * storage-state-fallback-check — browser regression for AGENTS.md §5.
 *
 * Two storage-state behaviours must hold on a REAL Playwright launch:
 *   1. external mode + malformed storage-state JSON → the launch still succeeds
 *      with a FRESH session (read failure falls back, never a startup error);
 *   2. persistent mode (userDataDir) → a valid storage-state snapshot is
 *      actually SEEDED into the context. `launchPersistentContext` does not
 *      accept Playwright's `storageState` option (it silently ignores it), so
 *      the driver must apply it via `BrowserContext.setStorageState`.
 *
 * Uses DSH_TUI_BROWSER_EXECUTABLE when set; otherwise the driver's normal
 * probe (system Chrome → /opt → bundled Chromium).
 *
 * Run: `node scripts/storage-state-fallback-check.mjs`
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = join(require.resolve('../package.json'), '..')
const { PlaywrightDriver } = await import(join(root, 'src/driver/playwright-driver.js'))

const dir = mkdtempSync(join(tmpdir(), 'ss-check-'))
const engine = 'chromium'
const executablePath = process.env.DSH_TUI_BROWSER_EXECUTABLE

/** Minimal RuntimeEnv subset the driver reads during `start`. */
function env(over = {}) {
  return {
    engine,
    noSandbox: false,
    executablePath,
    proxyServer: undefined,
    proxyBypass: undefined,
    dialog: 'dismiss',
    userDataDir: undefined,
    storageStatePath: undefined,
    navTimeoutMs: 45_000,
    actionTimeoutMs: 12_000,
    settleTimeoutMs: 6_000,
    maxTiles: 24,
    sensitiveQueryKeys: ['token'],
    inputRate: 0.28,
    outputRate: 0.42,
    cacheHitRate: 0.028,
    fileExpiresSeconds: 86_400,
    providerOverride: undefined,
    modelOverride: undefined,
    baseUrlOverride: undefined,
    deepseekBaseUrl: '',
    debug: false,
    ...over,
  }
}

function config() {
  return {
    visionMode: 'off',
    viewport: { width: 1024, height: 768 },
    screenshot: { format: 'jpeg', quality: 80, maxDimension: '' },
    tiling: { mode: 'auto', threshold: '1200x1200', overlap: 60, maxTiles: 24 },
    providers: [],
  }
}

// 1. Malformed storage-state → fresh session, startup still succeeds.
{
  const bad = join(dir, 'bad.storage-state.json')
  writeFileSync(bad, '{ this is not valid json !!!')
  const driver = new PlaywrightDriver()
  const ok = await driver.start({ config: config(), env: env({ storageStatePath: bad }), lang: 'en' })
  assert.equal(ok, true, 'start succeeds despite malformed storage-state')
  const cookies = await driver.context.cookies()
  assert.equal(cookies.length, 0, 'fresh session has no imported cookies')
  await driver.close()
  console.log('[1] malformed storage-state degrades to a fresh session — OK')
}

// 2. Valid storage-state + userDataDir → snapshot is actually applied.
{
  const statePath = join(dir, 'good.storage-state.json')
  writeFileSync(statePath, JSON.stringify({
    cookies: [{
      name: 'ss_imported', value: 'yes', domain: 'example.com', path: '/',
      expires: -1, httpOnly: false, secure: false, sameSite: 'Lax',
    }],
    origins: [],
  }))
  const userDataDir = join(dir, 'profile')
  const driver = new PlaywrightDriver()
  const ok = await driver.start({ config: config(), env: env({ storageStatePath: statePath, userDataDir }), lang: 'en' })
  assert.equal(ok, true, 'persistent start succeeds')
  const cookies = await driver.context.cookies('https://example.com')
  assert.equal(cookies.some((c) => c.name === 'ss_imported'), true, 'storage-state cookie imported in persistent mode')
  await driver.close()
  console.log('[2] valid storage-state is seeded into launchPersistentContext — OK')
}

rmSync(dir, { recursive: true, force: true })
console.log('\n[storage-state-fallback-check] ALL PASS')
process.exit(0)
