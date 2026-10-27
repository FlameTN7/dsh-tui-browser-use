/**
 * dsh-tui-browser-use — download URL handling (pure).
 *
 * `browser_download` requests a URL that often carries auth in the query string
 * (signed URL / token / signature). Scrubbing that URL before the request would
 * send a broken link and get a 403/404. So the request MUST use the raw URL;
 * only the URL surfaced in the result/error is sanitized, so a secret never
 * leaks into the model context (AGENTS.md §4).
 *
 * This module separates those two intents so it can be regression-tested as a
 * pure function, without a browser or a live `context.request.get`.
 */
/** The URL actually requested — the raw value, never scrubbed. */
export declare function requestUrl(raw: string): string;
/**
 * The URL shown in results/errors — sanitized. Prefers the response's final URL
 * (after redirects) when present, else the raw URL, and scrubs sensitive query
 * keys on either. The `sensitiveKeys` come from the runtime env so a caller can
 * honour a configured override; it defaults to the built-in set when omitted.
 */
export declare function displayUrl(raw: string, final: string, sensitiveKeys?: string[]): string;
/**
 * SSRF policy (P0-3): classify a URL the plugin is about to LOAD/NAVIGATE or
 * DOWNLOAD so the caller can block it before issuing the request. Returns
 * `'file'` for `file:` URLs (local file read) and `'metadata'` for the
 * cloud-metadata endpoints (credential-exfil targets). Loopback and
 * RFC1918 addresses stay allowed for local-dev compatibility. `allowUnsafeUrl`
 * (the `DSH_TUI_BROWSER_ALLOW_UNSAFE_URL=1` opt-out) disables the policy. A
 * relative/unparseable URL returns `null` — it has no host to validate, so the
 * caller handles it downstream. Note this is a minimal heuristic: it does NOT
 * enumerate every link-local address or IPv6-mapped form (e.g. `[::ffff:169.254.169.254]`),
 * so a determined SSRF probe may need a fuller allow/deny host list.
 */
export declare function unsafeUrlKind(raw: string, allowUnsafeUrl: boolean): 'file' | 'metadata' | null;
//# sourceMappingURL=download-url.d.ts.map