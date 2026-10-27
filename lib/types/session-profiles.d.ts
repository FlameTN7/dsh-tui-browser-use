import type { BrowserUseConfig } from './types.js';
/** Managed session modes. `external` = env override (not managed by this plugin). */
export type SessionMode = 'persistent' | 'isolated';
/** The full session mode reported by `browser_status` (adds `external`). */
export type EffectiveSessionMode = 'persistent' | 'isolated' | 'external';
/** A profile name must be a single safe path segment; anything else → 'default'. */
export declare const PROFILE_NAME_RE: RegExp;
/** Default profile name used when `session.profile` is absent/invalid. */
export declare const DEFAULT_PROFILE_NAME = "default";
/** Validate a profile name against the safe-segment rule (B5). */
export declare function validProfileName(name: string): boolean;
/**
 * Redact a path for display in `browser_status` (no secrets, no full home).
 * Replaces the home-directory prefix with `~`. Returns the input unchanged when
 * it cannot be safely redacted (e.g. already outside home or empty).
 */
export declare function sanitizePath(path: string | undefined): string | undefined;
/** The base directory set under the profile root (not run-specific). */
export interface SessionPaths {
    root: string;
    profilesDir: string;
    statesDir: string;
    ephemeralDir: string;
}
/** A fully-resolved set of paths + mode for one browser session. */
export interface ResolvedSessionPaths extends SessionPaths {
    /** effective mode. `external` = env override (plugin does not manage paths). */
    mode: EffectiveSessionMode;
    profileName: string;
    /** Directory handed to the browser as `userDataDir` (may be undefined). */
    userDataDir: string | undefined;
    /** Storage-state import/export path (may be undefined). */
    storageStatePath: string | undefined;
    /** Persistent lock file path (undefined for isolated/external). */
    lockPath: string | undefined;
    /** The per-run profile dir to report in status (may be undefined). */
    profileDir: string | undefined;
    /** Isolated-session temp dir to best-effort clean up on close (isolated only). */
    ephemeralRunDir: string | undefined;
}
/** Compute the static directory set under a profile root. */
export declare function pathsFor(root: string): SessionPaths;
/**
 * Resolve a canonical profile (persistent) path set under `root`.
 * The name is validated first; an invalid name degrades to `default`.
 */
export declare function profilePathsFor(root: string, rawName: string | undefined): {
    root: string;
    profilesDir: string;
    statesDir: string;
    ephemeralDir: string;
    profileDir: string;
    userDataDir: string;
    storageStatePath: string;
    lockPath: string;
};
/** Build a brand-new isolated (ephemeral) path set under `root`. */
export declare function ephemeralPathsFor(root: string): {
    root: string;
    profilesDir: string;
    statesDir: string;
    ephemeralDir: string;
    profileDir: string;
    userDataDir: string;
    ephemeralRunDir: string;
};
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
export declare function resolveSession(config: Pick<BrowserUseConfig, 'session'>, env: {
    userDataDir?: string;
    storageStatePath?: string;
}, rootOverride?: string): ResolvedSessionPaths;
/**
 * Downgrade a session to an isolated (ephemeral) one after a persistent lock
 * conflict. Reuses the same root so the fallback stays within the same cache
 * tree; the browser is launched with a brand-new temp profile (never hangs).
 */
export declare function degradeToIsolated(current: ResolvedSessionPaths, rootOverride?: string): ResolvedSessionPaths;
/** Try to create a lock file atomically (`O_CREAT|O_EXCL`). */
export declare function acquireLock(lockPath: string): {
    held: true;
} | {
    held: false;
    reason: 'locked' | 'error';
};
/** Best-effort lock release. Never throws — a stale lock degrades on next start. */
export declare function releaseLock(lockPath: string): void;
/**
 * Atomically write a storage-state snapshot to `path` with 0600 permissions,
 * using temp-file + rename so a crash never leaves a truncated state file.
 */
export declare function writeStorageState(path: string, data: unknown): void;
/**
 * Best-effort purge of an isolated session run dir (B6: id-validate → exact
 * match → running-lock absent → best-effort rm). Only ever removes a path that
 * is a DIRECT child of `<root>/ephemeral/`, so a bad id can never nuke a sibling
 * profile or state dir. Never throws; a failed cleanup does not affect close.
 */
export declare function purgeEphemeral(runDir: string | undefined): void;
//# sourceMappingURL=session-profiles.d.ts.map