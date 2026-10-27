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
/** Default sensitive query-name list (mirrors the previous module constant). */
export const DEFAULT_SENSITIVE_QUERY_KEYS = 'token,key,signature,sig,secret,api_key,apikey,access_token,session,cred,auth'
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
/** Default DeepSeek cost rates (USD per 1M tokens). */
export const DEFAULT_RATES = { input: 0.28, output: 0.42, cacheHit: 0.028 };
/** Default file expiry: 24h. `null` means "permanent" (omit `expires_after`). */
export const DEFAULT_FILE_EXPIRES_SECONDS = 86_400;
/** Parse a non-empty string env value; `undefined` when empty/absent. */
function envOrUndefined(raw) {
    return raw && raw.length > 0 ? raw : undefined;
}
/** Parse a finite, non-negative number; otherwise the fallback. */
function numAttr(raw, fallback) {
    const n = raw ? Number.parseFloat(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}
/**
 * Parse a timeout/cap override. Zero is INVALID for timeouts and tile caps
 * (Playwright treats `timeout: 0` as "wait forever"), so it falls back to the
 * documented default just like negative/NaN values.
 */
function positiveAttr(raw, fallback) {
    const n = raw ? Number.parseFloat(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
/** Parse the engine selector; anything unrecognised → chromium. */
export function parseEngine(raw) {
    return raw === 'firefox' || raw === 'webkit' ? raw : 'chromium';
}
/** Parse the dialog policy; anything unrecognised → dismiss. */
export function parseDialog(raw) {
    return raw === 'accept' || raw === 'ignore' ? raw : 'dismiss';
}
/** Parse the sensitive query-key list (comma-separated, trimmed, non-empty). */
export function parseSensitiveKeys(raw) {
    return (raw ?? DEFAULT_SENSITIVE_QUERY_KEYS.join(','))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}
/** Parse file expiry seconds. 0/empty/negative/non-numeric → permanent (null). */
export function parseFileExpires(raw) {
    if (raw === undefined || raw === '')
        return DEFAULT_FILE_EXPIRES_SECONDS;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}
/**
 * Load the full runtime environment. The optional `readEnv` lets tests inject a
 * fake environment without mutating `process.env`; it defaults to reading the
 * live process environment (the only place this plugin reads `process.env`).
 */
export function loadRuntimeEnv(readEnv = (n) => process.env[n]) {
    return {
        engine: parseEngine(readEnv('DSH_TUI_BROWSER_ENGINE')),
        noSandbox: readEnv('DSH_TUI_BROWSER_NO_SANDBOX') === '1',
        executablePath: envOrUndefined(readEnv('DSH_TUI_BROWSER_EXECUTABLE')),
        proxyServer: envOrUndefined(readEnv('DSH_TUI_BROWSER_PROXY')),
        proxyBypass: envOrUndefined(readEnv('DSH_TUI_BROWSER_PROXY_BYPASS')),
        dialog: parseDialog(readEnv('DSH_TUI_BROWSER_DIALOG')),
        userDataDir: envOrUndefined(readEnv('DSH_TUI_BROWSER_USER_DATA_DIR')),
        storageStatePath: envOrUndefined(readEnv('DSH_TUI_BROWSER_STORAGE_STATE')),
        navTimeoutMs: positiveAttr(readEnv('DSH_TUI_BROWSER_TIMEOUT_NAVIGATION'), 45_000),
        actionTimeoutMs: positiveAttr(readEnv('DSH_TUI_BROWSER_TIMEOUT_ACTION'), 12_000),
        settleTimeoutMs: positiveAttr(readEnv('DSH_TUI_BROWSER_TIMEOUT_SETTLE'), 6_000),
        // maxTiles is read LAZILY on every access (the tiling code historically
        // re-read `DSH_TUI_BROWSER_MAX_TILES` at capture time, and a /settings edit
        // to `tiling.maxTiles` must take effect mid-session). Keeping it a getter
        // preserves that live behaviour while still centralising the read here.
        get maxTiles() { return positiveAttr(readEnv('DSH_TUI_BROWSER_MAX_TILES'), 24); },
        sensitiveQueryKeys: parseSensitiveKeys(readEnv('DSH_TUI_BROWSER_SENSITIVE_QUERY_KEYS')),
        writeAny: readEnv('DSH_TUI_BROWSER_WRITE_ANY') === '1',
        writeWorkspace: envOrUndefined(readEnv('DSH_TUI_BROWSER_WORKSPACE')),
        allowUnsafeUrl: readEnv('DSH_TUI_BROWSER_ALLOW_UNSAFE_URL') === '1',
        inputRate: numAttr(readEnv('DSH_TUI_BROWSER_INPUT_RATE'), DEFAULT_RATES.input),
        outputRate: numAttr(readEnv('DSH_TUI_BROWSER_OUTPUT_RATE'), DEFAULT_RATES.output),
        cacheHitRate: numAttr(readEnv('DSH_TUI_BROWSER_CACHE_HIT_RATE'), DEFAULT_RATES.cacheHit),
        cnyUsdRate: numAttr(readEnv('DSH_TUI_BROWSER_CNY_USD_RATE'), 7.2),
        fileExpiresSeconds: parseFileExpires(readEnv('DSH_TUI_BROWSER_FILE_EXPIRES_SECONDS')),
        providerOverride: envOrUndefined(readEnv('DSH_TUI_BROWSER_PROVIDER')),
        modelOverride: envOrUndefined(readEnv('DSH_TUI_BROWSER_MODEL')),
        baseUrlOverride: envOrUndefined(readEnv('DSH_TUI_BROWSER_BASE_URL')),
        deepseekBaseUrl: envOrUndefined(readEnv('DEEPSEEK_BASE_URL')) ?? '',
        maxDownloadBytes: positiveAttr(readEnv('DSH_TUI_BROWSER_MAX_DOWNLOAD_BYTES'), 100 * 1024 * 1024),
        debug: envOrUndefined(readEnv('DSH_TUI_BROWSER_DEBUG')) !== undefined,
    };
}
//# sourceMappingURL=runtime-env.js.map