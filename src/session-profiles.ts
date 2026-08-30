/**
 * dsh-tui-browser-use — session profile directory conventions (竞品 B5/B6).
 *
 * Phase 3: manage the private browser login state so "run one independent
 * session" and "keep a TUI-owned login state" coexist, under a cache directory
 * that is comfortable to pack/migrate. This module is deliberately PURE where
 * possible (path resolution, validation, downgrade decision) so it is unit
 * testable without a browser; the handful of fs-backed helpers (lock, storage-
 * state atomic write) are thin wrappers over `node:fs` that a regression script
 * can exercise against a temp directory.
 *
 * Layout (under `defaultProfileRoot()`):
 *   profiles/<name>/user-data/                 full browser profile (login state)
 *   states/<name>.storage-state.json           bare cookie+localStorage snapshot
 *   ephemeral/<run-id>/user-data/              isolated-session temp profile
 *
 * Precedence (AGENTS.md §5, unchanged): explicit `DSH_TUI_BROWSER_USER_DATA_DIR`
 * / `DSH_TUI_BROWSER_STORAGE_STATE` env overrides win over everything and put
 * the session in `external` mode (the plugin does not manage those paths). The
 * new config `session.mode=persistent|isolated` / `session.profile=<name>`
 * drives the managed paths when no env override is present.
 */
import { chmodSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync, renameSync, rmSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { BrowserUseConfig } from './types.js'

/** Managed session modes. `external` = env override (not managed by this plugin). */
export type SessionMode = 'persistent' | 'isolated'

/** The full session mode reported by `browser_status` (adds `external`). */
export type EffectiveSessionMode = 'persistent' | 'isolated' | 'external'

/** A profile name must be a single safe path segment; anything else → 'default'. */
export const PROFILE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/

/** Default profile name used when `session.profile` is absent/invalid. */
export const DEFAULT_PROFILE_NAME = 'default'

/** Validate a profile name against the safe-segment rule (B5). */
export function validProfileName(name: string): boolean {
  // `..` / `.` are single segments that the regex would match but must NOT be
  // accepted — they resolve to the parent / current directory (path traversal).
  return PROFILE_NAME_RE.test(name) && name !== '.' && name !== '..'
}

/**
 * The default cache root for browser profiles, per platform convention:
 * - Linux:   `$XDG_CACHE_HOME/dsh-tui-browser-use` (else `~/.cache/...`)
 * - macOS:   `~/Library/Caches/dsh-tui-browser-use`
 * - Windows: `%LOCALAPPDATA%\dsh-tui-browser-use`
 * Tests inject a fixed `rootOverride` so resolution is deterministic cross-platform.
 */
export function defaultProfileRoot(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA
    if (base) return join(base, 'dsh-tui-browser-use')
  } else if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'dsh-tui-browser-use')
  } else {
    const xdg = process.env.XDG_CACHE_HOME
    if (xdg) return join(xdg, 'dsh-tui-browser-use')
  }
  // Fallback for win32 without LOCALAPPDATA / any other platform: home cache.
  return join(homedir(), '.cache', 'dsh-tui-browser-use')
}

/** A short unique run id for an isolated-session ephemeral dir. */
export function runId(): string {
  return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`
}

/**
 * Redact a path for display in `browser_status` (no secrets, no full home).
 * Replaces the home-directory prefix with `~`. Returns the input unchanged when
 * it cannot be safely redacted (e.g. already outside home or empty).
 */
export function sanitizePath(path: string | undefined): string | undefined {
  if (!path) return path
  const home = homedir()
  if (home && path === home) return '~'
  if (home && path.startsWith(home + sep())) return `~${path.slice(home.length)}`
  return path
}

/** Cross-platform path separator (kept local to avoid a `path` runtime import in tests). */
function sep(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

/** The base directory set under the profile root (not run-specific). */
export interface SessionPaths {
  root: string
  profilesDir: string
  statesDir: string
  ephemeralDir: string
}

/** A fully-resolved set of paths + mode for one browser session. */
export interface ResolvedSessionPaths extends SessionPaths {
  /** effective mode. `external` = env override (plugin does not manage paths). */
  mode: EffectiveSessionMode
  profileName: string
  /** Directory handed to the browser as `userDataDir` (may be undefined). */
  userDataDir: string | undefined
  /** Storage-state import/export path (may be undefined). */
  storageStatePath: string | undefined
  /** Persistent lock file path (undefined for isolated/external). */
  lockPath: string | undefined
  /** The per-run profile dir to report in status (may be undefined). */
  profileDir: string | undefined
  /** Isolated-session temp dir to best-effort clean up on close (isolated only). */
  ephemeralRunDir: string | undefined
}

/** Compute the static directory set under a profile root. */
export function pathsFor(root: string, profileName: string): SessionPaths {
  return {
    root,
    profilesDir: join(root, 'profiles'),
    statesDir: join(root, 'states'),
    ephemeralDir: join(root, 'ephemeral'),
  }
}

/**
 * Resolve a canonical profile (persistent) path set under `root`.
 * The name is validated first; an invalid name degrades to `default`.
 */
export function profilePathsFor(root: string, rawName: string | undefined): {
  root: string
  profilesDir: string
  statesDir: string
  ephemeralDir: string
  profileDir: string
  userDataDir: string
  storageStatePath: string
  lockPath: string
} {
  const name = validProfileName(rawName ?? '') ? (rawName as string) : DEFAULT_PROFILE_NAME
  return {
    ...pathsFor(root, name),
    profileDir: join(root, 'profiles', name),
    userDataDir: join(root, 'profiles', name, 'user-data'),
    storageStatePath: join(root, 'states', `${name}.storage-state.json`),
    lockPath: join(root, 'profiles', name, 'lock'),
  }
}

/** Build a brand-new isolated (ephemeral) path set under `root`. */
export function ephemeralPathsFor(root: string): {
  root: string
  profilesDir: string
  statesDir: string
  ephemeralDir: string
  profileDir: string
  userDataDir: string
  ephemeralRunDir: string
} {
  const id = runId()
  const base = pathsFor(root, DEFAULT_PROFILE_NAME)
  const runDir = join(base.ephemeralDir, id)
  return {
    ...base,
    profileDir: runDir,
    userDataDir: join(runDir, 'user-data'),
    ephemeralRunDir: runDir,
  }
}

/**
 * Resolve the effective session for a plugin config + runtime env.
 *
 * Precedence (highest first):
 *   1. `DSH_TUI_BROWSER_USER_DATA_DIR` / `DSH_TUI_BROWSER_STORAGE_STATE` env
 *      overrides → `external` mode (plugin does not manage paths).
 *   2. `session.mode === 'persistent'` → a named, lock-protected profile.
 *   3. `session.mode === 'isolated'` → a fresh ephemeral profile every run.
 *   4. session block absent / unset → `external` with no managed dirs, matching
 *      the historical default (fresh browser session, no plugin-owned profile).
 */
export function resolveSession(
  config: Pick<BrowserUseConfig, 'session'>,
  env: { userDataDir?: string; storageStatePath?: string },
  rootOverride?: string,
): ResolvedSessionPaths {
  const root = rootOverride ?? defaultProfileRoot()
  const sess = config.session
  const profileName = sess?.profile ? (validProfileName(sess.profile) ? sess.profile : DEFAULT_PROFILE_NAME) : DEFAULT_PROFILE_NAME
  const base = pathsFor(root, profileName)
  const envManaged = Boolean(env.userDataDir || env.storageStatePath)

  if (envManaged) {
    return {
      ...base,
      mode: 'external',
      profileName,
      userDataDir: env.userDataDir,
      storageStatePath: env.storageStatePath,
      lockPath: undefined,
      profileDir: env.userDataDir,
      ephemeralRunDir: undefined,
    }
  }

  if (sess?.mode === 'persistent') {
    const p = profilePathsFor(root, profileName)
    return {
      ...p,
      mode: 'persistent',
      profileName,
      userDataDir: p.userDataDir,
      storageStatePath: p.storageStatePath,
      lockPath: p.lockPath,
      profileDir: p.profileDir,
      ephemeralRunDir: undefined,
    }
  }

  if (sess?.mode === 'isolated') {
    const e = ephemeralPathsFor(root)
    return {
      ...e,
      mode: 'isolated',
      profileName,
      userDataDir: e.userDataDir,
      storageStatePath: undefined,
      lockPath: undefined,
      profileDir: e.profileDir,
      ephemeralRunDir: e.ephemeralRunDir,
    }
  }

  // session block absent / mode unset → historical default (no managed profile).
  return {
    ...base,
    mode: 'external',
    profileName,
    userDataDir: undefined,
    storageStatePath: undefined,
    lockPath: undefined,
    profileDir: undefined,
    ephemeralRunDir: undefined,
  }
}

/**
 * Downgrade a session to an isolated (ephemeral) one after a persistent lock
 * conflict. Reuses the same root so the fallback stays within the same cache
 * tree; the browser is launched with a brand-new temp profile (never hangs).
 */
export function degradeToIsolated(current: ResolvedSessionPaths, rootOverride?: string): ResolvedSessionPaths {
  const root = rootOverride ?? current.root
  const e = ephemeralPathsFor(root)
  return {
    ...e,
    mode: 'isolated',
    profileName: current.profileName,
    userDataDir: e.userDataDir,
    storageStatePath: undefined,
    lockPath: undefined,
    profileDir: e.profileDir,
    ephemeralRunDir: e.ephemeralRunDir,
  }
}

// ── fs-backed helpers (thin; testable against a temp dir) ────────────────

/** Try to create a lock file atomically (`O_CREAT|O_EXCL`). */
export function acquireLock(lockPath: string): { held: true } | { held: false; reason: 'locked' | 'error' } {
  try {
    // Profiles are lazily created; ensure the lock's parent dir exists first.
    mkdirSync(dirname(lockPath), { recursive: true })
    const fd = openSync(lockPath, 'wx')
    try { writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 }) } catch { /* best-effort */ }
    closeSync(fd)
    return { held: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      // Stale-lock detection: if the recorded PID is no longer running, the
      // lock is orphaned (e.g. the owner was killed with SIGKILL) — remove it
      // and retry once. A valid live owner keeps the lock as-is.
      if (tryReleaseStaleLock(lockPath)) {
        return acquireLock(lockPath)
      }
      return { held: false, reason: 'locked' }
    }
    return { held: false, reason: 'error' }
  }
}

/**
 * True when the lock file exists but its recorded PID is not a live process.
 * A malformed lock (no parseable PID) is also treated as stale. Never throws.
 */
function tryReleaseStaleLock(lockPath: string): boolean {
  try {
    const pidText = readFileSync(lockPath, 'utf8').trim()
    const pid = Number.parseInt(pidText, 10)
    if (!Number.isFinite(pid) || pid <= 0) {
      unlinkSync(lockPath)
      return true
    }
    try {
      process.kill(pid, 0) // signal 0 = existence check only
      return false // process alive → lock is valid
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ESRCH') { // no such process
        unlinkSync(lockPath)
        return true
      }
      // EPERM = exists but not ours → assume alive; anything else → keep.
      return false
    }
  } catch {
    return false // read/unlink failed — do not touch
  }
}

/** Best-effort lock release. Never throws — a stale lock degrades on next start. */
export function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath) } catch { /* best-effort */ }
}

/**
 * Atomically write a storage-state snapshot to `path` with 0600 permissions,
 * using temp-file + rename so a crash never leaves a truncated state file.
 */
export function writeStorageState(path: string, data: unknown): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = `${path}.${process.pid}.${runId()}.tmp`
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* best-effort */ }
  renameSync(tmp, path)
  try { chmodSync(path, 0o600) } catch { /* best-effort */ }
}

/**
 * Best-effort purge of an isolated session run dir (B6: id-validate → exact
 * match → running-lock absent → best-effort rm). Only ever removes a path that
 * is a DIRECT child of `<root>/ephemeral/`, so a bad id can never nuke a sibling
 * profile or state dir. Never throws; a failed cleanup does not affect close.
 */
export function purgeEphemeral(runDir: string | undefined): void {
  if (!runDir) return
  try {
    const parent = dirname(runDir)
    if (!parent.endsWith(`${sep()}ephemeral`)) return
    rmSync(runDir, { recursive: true, force: true })
  } catch { /* best-effort */ }
}
