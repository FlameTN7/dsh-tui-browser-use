/**
 * secret-probe-check — pure-logic regression for AGENTS.md §6 credential probing.
 *
 * Locks the user-approved policy (2026-08-31):
 *   A. credentials service present → `resolve({env})` wins, stale process env
 *      is NEVER consulted;
 *   B. credentials service present but key unconfigured → null even when a
 *      process env value exists (profile refs are the intended source);
 *   C. no credentials seam (stub / third-party host) → env fallback still works.
 *
 * Run: `node --import tsx/esm scripts/secret-probe-check.mjs`
 */
import assert from 'node:assert/strict'

const { probeSecretAsync } = await import('../src/secret-probe.js')

const ENV_NAME = 'DSH_TUI_SECRET_PROBE_TEST_KEY'
const oldEnv = process.env[ENV_NAME]

try {
  // A. Credentials resolve wins over a conflicting env value.
  process.env[ENV_NAME] = 'from-env'
  {
    const ctx = { get: () => ({ resolve: async (ref) => ref?.env === ENV_NAME ? { key: 'from-resolve' } : undefined }) }
    assert.equal(await probeSecretAsync(ctx, [ENV_NAME]), 'from-resolve')
    console.log('[A] credentials.resolve wins over env — OK')
  }

  // B. Credentials service present but key unconfigured → null (NO env fallback).
  {
    const ctx = { get: () => ({ resolve: async () => undefined, get: () => undefined }) }
    assert.equal(await probeSecretAsync(ctx, [ENV_NAME]), null)
    console.log('[B] credentials service blocks env fallback — OK')
  }

  // C. No credentials service → env fallback keeps stub/third-party hosts working.
  {
    const ctx = { get: () => undefined }
    assert.equal(await probeSecretAsync(ctx, [ENV_NAME]), 'from-env')
    console.log('[C] env fallback only without a credentials service — OK')
  }

  console.log('\n[secret-probe-check] ALL PASS')
} finally {
  if (oldEnv === undefined) delete process.env[ENV_NAME]
  else process.env[ENV_NAME] = oldEnv
}
process.exit(0)
