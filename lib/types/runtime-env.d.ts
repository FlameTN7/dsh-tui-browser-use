/**
 * dsh-tui-browser-use — runtime environment (centralised env reads).
 *
 * AGENTS.md §2 / 竞品 B3: `BrowserSession` and the vision path must receive
 * their configuration through injection, not read `process.env` scattered
 * across modules. This module is the primary place that reads the host
 * environment for plugin config; everything else (browser / vision /
 * provider-router / index) consumes the resolved `RuntimeEnv` value object.
 * (A few path helpers outside this module still read platform env directly,
 * e.g. `session-profiles` for the cache root — kept local for testability.)
 *
 * Semantics are deliberately IDENTICAL to the previous inline reads:
 *   - numeric overrides accept only a finite, non-negative value, else the
 *     documented fallback;
 *   - enum overrides fall back to the safe default (chromium / dismiss);
 *   - `DSH_TUI_BROWSER_FILE_EXPIRES_SECONDS` special-cases 0/empty/negative
 *     to "permanent" (null), matching the old file-expiry behaviour.
 *
 * The only env reads legitimately OUTSIDE this module are the harness-boundary
 * aspects that must stay in index.ts: the async credentials seam
 * (`probeSecretAsync(ctx, envKeys)`, AGENTS.md §6) and the host UI language
 * (`DSH_TUI_LANG`), which is a harness concern, not plugin config.
 */
/** Browser engine selector. */
export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';
/** Dialogue-handling policy. */
export type DialogMode = 'accept' | 'dismiss' | 'ignore';
/** Default sensitive query-name list (mirrors the previous module constant). */
export declare const DEFAULT_SENSITIVE_QUERY_KEYS: string[];
/** Default DeepSeek cost rates (USD per 1M tokens). */
export declare const DEFAULT_RATES: {
    readonly input: 0.28;
    readonly output: 0.42;
    readonly cacheHit: 0.028;
};
/** Default file expiry: 24h. `null` means "permanent" (omit `expires_after`). */
export declare const DEFAULT_FILE_EXPIRES_SECONDS = 86400;
/** A fully-resolved snapshot of every environment override this plugin honours. */
export interface RuntimeEnv {
    engine: BrowserEngine;
    noSandbox: boolean;
    executablePath: string | undefined;
    proxyServer: string | undefined;
    proxyBypass: string | undefined;
    dialog: DialogMode;
    userDataDir: string | undefined;
    storageStatePath: string | undefined;
    navTimeoutMs: number;
    actionTimeoutMs: number;
    settleTimeoutMs: number;
    /** Tiling fallback cap (config takes precedence over this).
     * Lazily re-read from env on every access (a `/settings` edit to
     * `tiling.maxTiles` takes effect mid-session). Read-only by contract. */
    readonly maxTiles: number;
    sensitiveQueryKeys: string[];
    /** Allow writes outside CWD/workspace/tmp (security opt-in, H1/P0-2). */
    writeAny: boolean;
    /** Extra allowed write root (defaults to process.cwd()); helps containment. */
    writeWorkspace: string | undefined;
    /** Allow `file:` downloads / cloud-metadata URLs (security opt-in, P0-3). */
    allowUnsafeUrl: boolean;
    inputRate: number;
    outputRate: number;
    cacheHitRate: number;
    /** USD→CNY exchange rate for cost estimation (default 7.2). */
    cnyUsdRate: number;
    /** `null` → permanent file (omit `expires_after`). */
    fileExpiresSeconds: number | null;
    providerOverride: string | undefined;
    modelOverride: string | undefined;
    baseUrlOverride: string | undefined;
    deepseekBaseUrl: string;
    /** Max bytes a single `browser_download` will buffer (P2-2). */
    maxDownloadBytes: number;
    debug: boolean;
}
/** Parse the engine selector; anything unrecognised → chromium. */
export declare function parseEngine(raw: string | undefined): BrowserEngine;
/** Parse the dialog policy; anything unrecognised → dismiss. */
export declare function parseDialog(raw: string | undefined): DialogMode;
/** Parse the sensitive query-key list (comma-separated, trimmed, non-empty). */
export declare function parseSensitiveKeys(raw: string | undefined): string[];
/** Parse file expiry seconds. 0/empty/negative/non-numeric → permanent (null). */
export declare function parseFileExpires(raw: string | undefined): number | null;
/**
 * Load the full runtime environment. The optional `readEnv` lets tests inject a
 * fake environment without mutating `process.env`; it defaults to reading the
 * live process environment (the only place this plugin reads `process.env`).
 */
export declare function loadRuntimeEnv(readEnv?: (name: string) => string | undefined): RuntimeEnv;
//# sourceMappingURL=runtime-env.d.ts.map