/**
 * runtime-env-check — pure-logic regression for Phase 2.3.
 *
 * `runtime-env.ts` is the primary place this plugin reads `process.env` for
 * plugin configuration. It must centralise every `DSH_TUI_*` override with the
 * SAME defaults/validation as the previous scattered reads, so a
 * behaviour-identical refactor stays verified:
 *   - numeric overrides accept only finite, non-negative values → fallback;
 *   - enum overrides fall back to the safe default (chromium / dismiss);
 *   - file-expiry special-cases 0/empty/negative → permanent (null).
 *
 * Run: `node --import tsx/esm scripts/runtime-env-check.mjs`
 */
import assert from 'node:assert/strict'

const rt = await import('../src/runtime-env.js')

// Inject a fake environment so we never depend on the live process env.
function envFrom(map) {
  return (name) => map[name]
}

// 1. Defaults with no overrides.
{
  const e = rt.loadRuntimeEnv(() => undefined)
  assert.equal(e.engine, 'chromium', 'default engine chromium')
  assert.equal(e.dialog, 'dismiss', 'default dialog dismiss')
  assert.equal(e.noSandbox, false, 'noSandbox off by default')
  assert.equal(e.navTimeoutMs, 45_000, 'nav fallback 45000')
  assert.equal(e.actionTimeoutMs, 12_000, 'action fallback 12000')
  assert.equal(e.settleTimeoutMs, 6_000, 'settle fallback 6000')
  assert.equal(e.maxTiles, 24, 'maxTiles fallback 24')
  assert.equal(e.inputRate, 0.28, 'input rate default')
  assert.equal(e.outputRate, 0.42, 'output rate default')
  assert.equal(e.cacheHitRate, 0.028, 'cache-hit rate default')
  assert.equal(e.fileExpiresSeconds, 86_400, 'file expiry default 24h')
  assert.equal(e.deepseekBaseUrl, '', 'deepseek base url default empty')
  assert.equal(e.debug, false, 'debug off by default')
  assert.ok(Array.isArray(e.sensitiveQueryKeys) && e.sensitiveQueryKeys.includes('token'), 'sensitive keys populated')
  assert.equal(e.providerOverride, undefined, 'provider override undefined')
  console.log('[1] defaults with no overrides — OK')
}

// 2. Every override is honoured via the injected readEnv.
{
  const e = rt.loadRuntimeEnv(envFrom({
    DSH_TUI_BROWSER_ENGINE: 'firefox',
    DSH_TUI_BROWSER_NO_SANDBOX: '1',
    DSH_TUI_BROWSER_EXECUTABLE: '/opt/chrome/chrome',
    DSH_TUI_BROWSER_PROXY: 'http://proxy:8080',
    DSH_TUI_BROWSER_PROXY_BYPASS: 'local,10.0.0.0',
    DSH_TUI_BROWSER_DIALOG: 'accept',
    DSH_TUI_BROWSER_USER_DATA_DIR: '/tmp/profile',
    DSH_TUI_BROWSER_STORAGE_STATE: '/tmp/state.json',
    DSH_TUI_BROWSER_TIMEOUT_NAVIGATION: '90000',
    DSH_TUI_BROWSER_TIMEOUT_ACTION: '25000',
    DSH_TUI_BROWSER_TIMEOUT_SETTLE: '9000',
    DSH_TUI_BROWSER_MAX_TILES: '48',
    DSH_TUI_BROWSER_SENSITIVE_QUERY_KEYS: 'token,auth',
    DSH_TUI_BROWSER_INPUT_RATE: '1.5',
    DSH_TUI_BROWSER_OUTPUT_RATE: '2.5',
    DSH_TUI_BROWSER_CACHE_HIT_RATE: '0.1',
    DSH_TUI_BROWSER_FILE_EXPIRES_SECONDS: '3600',
    DSH_TUI_BROWSER_PROVIDER: 'openai',
    DSH_TUI_BROWSER_MODEL: 'gpt-5',
    DSH_TUI_BROWSER_BASE_URL: 'https://gw.example.com',
    DEEPSEEK_BASE_URL: 'https://ds.example.com',
    DSH_TUI_BROWSER_DEBUG: '1',
  }))
  assert.equal(e.engine, 'firefox')
  assert.equal(e.noSandbox, true)
  assert.equal(e.executablePath, '/opt/chrome/chrome')
  assert.equal(e.proxyServer, 'http://proxy:8080')
  assert.equal(e.proxyBypass, 'local,10.0.0.0')
  assert.equal(e.dialog, 'accept')
  assert.equal(e.userDataDir, '/tmp/profile')
  assert.equal(e.storageStatePath, '/tmp/state.json')
  assert.equal(e.navTimeoutMs, 90_000)
  assert.equal(e.actionTimeoutMs, 25_000)
  assert.equal(e.settleTimeoutMs, 9_000)
  assert.equal(e.maxTiles, 48)
  assert.deepEqual(e.sensitiveQueryKeys, ['token', 'auth'])
  assert.equal(e.inputRate, 1.5)
  assert.equal(e.outputRate, 2.5)
  assert.equal(e.cacheHitRate, 0.1)
  assert.equal(e.fileExpiresSeconds, 3_600)
  assert.equal(e.providerOverride, 'openai')
  assert.equal(e.modelOverride, 'gpt-5')
  assert.equal(e.baseUrlOverride, 'https://gw.example.com')
  assert.equal(e.deepseekBaseUrl, 'https://ds.example.com')
  assert.equal(e.debug, true)
  console.log('[2] every override honoured — OK')
}

// 3. Invalid numeric / enum values fall back to the safe default.
{
  const e = rt.loadRuntimeEnv(envFrom({
    DSH_TUI_BROWSER_TIMEOUT_NAVIGATION: '-5', // negative → fallback
    DSH_TUI_BROWSER_MAX_TILES: 'abc',         // non-numeric → fallback
    DSH_TUI_BROWSER_ENGINE: 'edge',           // unknown → chromium
    DSH_TUI_BROWSER_DIALOG: 'maybe',          // unknown → dismiss
    DSH_TUI_BROWSER_INPUT_RATE: '-1',
    DSH_TUI_BROWSER_FILE_EXPIRES_SECONDS: '0', // 0 → permanent (null)
  }))
  assert.equal(e.navTimeoutMs, 45_000, 'negative nav → fallback')
  assert.equal(e.maxTiles, 24, 'non-numeric maxTiles → fallback')
  assert.equal(e.engine, 'chromium', 'unknown engine → chromium')
  assert.equal(e.dialog, 'dismiss', 'unknown dialog → dismiss')
  assert.equal(e.inputRate, 0.28, 'negative rate → fallback')
  assert.equal(e.fileExpiresSeconds, null, '0 file-expiry → permanent')
  console.log('[3] invalid values fall back to defaults — OK')
}

// 4. parseFileExpires boundary cases.
{
  assert.equal(rt.parseFileExpires(undefined), 86_400)
  assert.equal(rt.parseFileExpires(''), 86_400)
  assert.equal(rt.parseFileExpires('3600'), 3_600)
  assert.equal(rt.parseFileExpires('0'), null)
  assert.equal(rt.parseFileExpires('-5'), null)
  assert.equal(rt.parseFileExpires('junk'), null)
  console.log('[4] parseFileExpires boundary — OK')
}

// 5. parseEngine / parseDialog / parseSensitiveKeys pure helpers.
{
  assert.equal(rt.parseEngine('webkit'), 'webkit')
  assert.equal(rt.parseEngine('firefox'), 'firefox')
  assert.equal(rt.parseEngine('nope'), 'chromium')
  assert.equal(rt.parseDialog('accept'), 'accept')
  assert.equal(rt.parseDialog('ignore'), 'ignore')
  assert.equal(rt.parseDialog('nope'), 'dismiss')
  assert.deepEqual(rt.parseSensitiveKeys('a, b ,,c'), ['a', 'b', 'c'])
  assert.deepEqual(rt.parseSensitiveKeys(undefined), rt.DEFAULT_SENSITIVE_QUERY_KEYS)
  console.log('[5] parseEngine / parseDialog / parseSensitiveKeys — OK')
}

console.log('\n[runtime-env-check] ALL PASS')
process.exit(0)
