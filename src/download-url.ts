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

import { sanitizeUrl } from './browser.js'

/** The URL actually requested — the raw value, never scrubbed. */
export function requestUrl(raw: string): string {
  return raw
}

/**
 * The URL shown in results/errors — sanitized. Prefers the response's final URL
 * (after redirects) when present, else the raw URL, and scrubs sensitive query
 * keys on either.
 */
export function displayUrl(raw: string, final: string): string {
  return sanitizeUrl(final || raw)
}
