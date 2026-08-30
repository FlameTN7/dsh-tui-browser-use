/**
 * session-profile-check — pure-logic regression for Phase 3.1.
 *
 * Verifies the session-profile directory conventions and file discipline
 * (竞品 B5/B6) WITHOUT a browser:
 *   - profile-name validation (`^[A-Za-z0-9._-]{1,64}$`)
 *   - path resolution precedence (env override > persistent > isolated > default)
 *   - lock-file O_EXCL semantics (acquire → held; second acquire → locked; release)
 *   - storage-state atomic write (temp+rename+0600) + home-redaction
 *   - persistent-lock conflict degrades to an isolated session with a NEW
 *     ephemeral run dir (never hangs)
 *
 * Run: `node --import tsx/esm scripts/session-profile-check.mjs`
 */
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sp = await import('../src/session-profiles.js')

// Use the SAME fake root for every resolution check, so results are
// deterministic across platforms (no dependence on XDG/HOME/LOCALAPPDATA).
const root = mkdtempSync(join(tmpdir(), 'dsh-session-check-'))

// 1. Profile-name validation.
{
  assert.equal(sp.validProfileName('default'), true)
  assert.equal(sp.validProfileName('my-profile_1.v2'), true)
  assert.equal(sp.validProfileName('..'), false)         // path-traversal-ish
  assert.equal(sp.validProfileName('a/b'), false)        // includes a separator
  assert.equal(sp.validProfileName(''), false)
  assert.equal(sp.validProfileName('x'.repeat(65)), false) // > 64
  assert.equal(sp.validProfileName('x'.repeat(64)), true)  // == 64
  console.log('[1] profile-name validation — OK')
}

// 2. path resolution precedence: env override wins and is unmanaged (external).
{
  const r = sp.resolveSession(
    { session: { mode: 'persistent', profile: 'acct' } },
    { userDataDir: '/tmp/env-profile', storageStatePath: '/tmp/env-state.json' },
    root,
  )
  assert.equal(r.mode, 'external', 'env override → external')
  assert.equal(r.userDataDir, '/tmp/env-profile')
  assert.equal(r.storageStatePath, '/tmp/env-state.json')
  assert.equal(r.lockPath, undefined, 'external has no managed lock')
  assert.equal(r.ephemeralRunDir, undefined, 'external has no ephemeral dir')
  console.log('[2] env override precedence (external) — OK')
}

// 3. persistent mode → named profile path set + lock + storage-state.
{
  const r = sp.resolveSession(
    { session: { mode: 'persistent', profile: 'acct' } },
    {},
    root,
  )
  assert.equal(r.mode, 'persistent')
  assert.equal(r.userDataDir, join(root, 'profiles', 'acct', 'user-data'))
  assert.equal(r.storageStatePath, join(root, 'states', 'acct.storage-state.json'))
  assert.equal(r.lockPath, join(root, 'profiles', 'acct', 'lock'))
  assert.equal(r.ephemeralRunDir, undefined)
  assert.ok(r.lockPath && existsSync(join(root, 'profiles')) === false, 'paths not created eagerly')
  console.log('[3] persistent path set — OK')
}

// 4. isolated mode → fresh ephemeral run dir + no lock/state.
{
  const r = sp.resolveSession(
    { session: { mode: 'isolated', profile: 'acct' } },
    {},
    root,
  )
  assert.equal(r.mode, 'isolated')
  assert.ok(r.userDataDir && r.userDataDir.startsWith(join(root, 'ephemeral')), 'ephemeral user-data under root/ephemeral')
  assert.equal(r.storageStatePath, undefined)
  assert.equal(r.lockPath, undefined)
  assert.ok(r.ephemeralRunDir && r.ephemeralRunDir.startsWith(join(root, 'ephemeral')), 'ephemeral run dir under root/ephemeral')
  console.log('[4] isolated ephemeral path set — OK')
}

// 5. session block absent → historical default (external, no managed dirs).
{
  const r = sp.resolveSession({}, {}, root)
  assert.equal(r.mode, 'external')
  assert.equal(r.userDataDir, undefined)
  assert.equal(r.storageStatePath, undefined)
  assert.equal(r.lockPath, undefined)
  assert.equal(r.ephemeralRunDir, undefined)
  console.log('[5] session absent → historical default (external) — OK')
}

// 6. invalid profile name degrades to `default`.
{
  const r = sp.resolveSession(
    { session: { mode: 'persistent', profile: '../evil' } },
    {},
    root,
  )
  assert.equal(r.profileName, 'default')
  assert.ok(r.userDataDir && r.userDataDir.endsWith('profiles/default/user-data'), 'invalid name → default dir')
  console.log('[6] invalid profile name degrades — OK')
}

// 7. lock file semantics (O_EXCL).
{
  const lockPath = join(root, 'profiles', 'l1', 'lock')
  const held = sp.acquireLock(lockPath)
  assert.equal(held.held, true, 'first acquire holds')
  assert.ok(existsSync(lockPath), 'lock file exists')
  const second = sp.acquireLock(lockPath)
  assert.equal(second.held, false, 'second acquire fails')
  assert.equal(second.reason, 'locked', 'reason is locked')
  sp.releaseLock(lockPath)
  assert.equal(existsSync(lockPath), false, 'released lock gone')
  // Re-acquire after release succeeds.
  const again = sp.acquireLock(lockPath)
  assert.equal(again.held, true, 're-acquire after release')
  sp.releaseLock(lockPath)
  console.log('[7] lock O_EXCL semantics — OK')
}

// 8. storage-state atomic write → file exists + mode 0600 + valid JSON.
{
  const statePath = join(root, 'states', 's8.storage-state.json')
  const payload = { cookies: [{ name: 'sid', value: '' }], origins: [] }
  sp.writeStorageState(statePath, payload)
  assert.ok(existsSync(statePath), 'state file written')
  const mode = statSync(statePath).mode & 0o777
  assert.equal(mode, 0o600, 'state file is 0600')
  const { readFileSync } = await import('node:fs')
  const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.deepEqual(parsed, payload, 'payload round-trips')
  // No leftover temp files in the states dir.
  assert.equal(readdirSync(join(root, 'states')).length, 1, 'no temp files left behind')
  console.log('[8] storage-state atomic write — OK')
}

// 9. sanitizePath redacts home prefix but leaves outside-home paths.
{
  const { homedir } = await import('node:os')
  const home = homedir()
  if (home) {
    const inside = sp.sanitizePath(join(home, '.cache', 'dsh-tui'))
    assert.ok(inside && inside.startsWith('~'), 'home prefix redacted to ~')
    assert.ok(!inside.startsWith(home), 'no full home leaked')
  }
  // A path outside the home dir is returned unchanged.
  assert.equal(sp.sanitizePath('/tmp/no-secret'), '/tmp/no-secret')
  assert.equal(sp.sanitizePath(undefined), undefined)
  console.log('[9] sanitizePath redaction — OK')
}

// 10. persistent-lock conflict degrades to isolated with a NEW ephemeral run dir.
{
  const r = sp.resolveSession({ session: { mode: 'persistent', profile: 'acct' } }, {}, root)
  assert.equal(r.mode, 'persistent')
  const degraded = sp.degradeToIsolated(r, root)
  assert.equal(degraded.mode, 'isolated')
  assert.ok(degraded.ephemeralRunDir && degraded.ephemeralRunDir.startsWith(join(root, 'ephemeral')), 'degraded into ephemeral run dir')
  assert.ok(degraded.ephemeralRunDir !== r.ephemeralRunDir, 'degraded dir is fresh')
  assert.notEqual(degraded.ephemeralRunDir, r.profileDir, 'never reuses the locked persistent dir')
  console.log('[10] degenerate to isolated on lock conflict — OK')
}

// Cleanup the temp root.
try { rmSync(root, { recursive: true, force: true }) } catch { /* best-effort */ }

console.log('\n[session-profile-check] ALL PASS')
process.exit(0)
