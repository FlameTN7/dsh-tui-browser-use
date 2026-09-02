/**
 * dsh-tui-browser-use — browser helper utilities.
 *
 * Pure, Playwright-agnostic helpers shared by the browser session orchestration
 * (browser.ts) and the page-operations class (page-ops.ts). These carry no
 * session state and never reach into the harness; they are the single source of
 * truth for the abort-shot-circuit race, the capture-time JPEG quality staircase,
 * and the sensitive-data redaction (URL/cookie). Frame-aware locator resolution
 * and capture live inside the `BrowserDriver` (the sole Playwright boundary), so
 * this module stays free of a hard runtime dependency on the playwright type
 * package (AGENTS.md §2).
 */

import type { ErrorCode } from './types.js'
import { DEFAULT_SENSITIVE_QUERY_KEYS } from './runtime-env.js'

/**
 * Throw a `timed-out` BrowserToolError when the cooperative abort signal has
 * already fired. Called at the START of every dispatchable browser operation
 * (navigate/click/type/scroll/download/...) so a tool whose wall-clock budget
 * expired does not issue a Playwright call that could still mutate the page —
 * the operation is short-circuited BEFORE it is dispatched (竞品 B8).
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new BrowserToolError('timed-out', 'operation aborted before dispatch')
  }
}

/**
 * Race a Playwright navigation/eval promise against the abort signal. Playwright
 * does not accept an abort signal, so a `page.goto` to a hung host can outlive
 * the tool's wall-clock budget and get the tool hard-killed by the host instead
 * of returning its own envelope. The budget (`AbortSignal.timeout` composed in
 * `abortSignalOf`) fires first → we surface `timed-out` and, via the optional
 * `cancel` callback, cancels the underlying op (the driver closes the page it
 * ran on) so it cannot keep mutating a page the session has already released.
 *
 * 审核 P1-2 (fully fixed): without a `cancel` hook the underlying Playwright
 * promise would be left running after the session queue advanced, so a stale
 * navigation/eval could interleave with the next tool on the same page. The
 * driver passes a `cancel` that quarantines the op (discard the page it ran on);
 * the session then lazily provisions a fresh page for the next call, preserving
 * serialization. `cancel` is only invoked when the abort actually wins the race
 * (i.e. `p` has NOT already settled), so a healthy page is never torn down just
 * because the abort fired a moment after the op finished.
 */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined, message = 'operation aborted before dispatch', cancel?: () => void): Promise<T> {
  if (!signal) return p
  // The abort may already have fired (e.g. a budget that elapsed between the
  // caller's `throwIfAborted` and this race). `addEventListener` does NOT fire
  // retroactively on an already-aborted signal, so without this guard the
  // promise would never settle and the stale op would never be quarantined.
  if (signal.aborted) {
    // The op (`p`) is already in-flight; quarantine it and swallow its eventual
    // rejection. Without attaching a handler here the page close (from `cancel`)
    // would reject `p` and surface as an unhandledRejection.
    p.catch(() => undefined)
    cancel?.()
    return Promise.reject(new BrowserToolError('timed-out', message))
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      reject(new BrowserToolError('timed-out', message))
      // Quarantine the stale op AFTER the envelope rejects, so the tool's own
      // `timed-out` surface is not affected by the cancellation cost.
      cancel?.()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => { settled = true; resolve(v) },
      (e) => { settled = true; reject(e) },
    ).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Split a save path into its directory, a "stem" (basename minus one final
 * extension), and that extension (with the leading dot, e.g. `.jpg`; empty
 * string when the path is extensionless). Unlike a bare `lastIndexOf('.')`,
 * an extensionless path keeps its full basename as the stem (e.g.
 * `/tmp/multi-noext` → `{dir:'/tmp/', stem:'multi-noext', ext:''}`, NOT
 * `multi-noex`). A leading-dot file (`.hidden`) is treated as extensionless so
 * its name is preserved.
 */
export function splitSaveStem(savePath: string): { dir: string; stem: string; ext: string } {
  const dir = savePath.slice(0, Math.max(savePath.lastIndexOf('/'), savePath.lastIndexOf('\\')) + 1)
  const base = savePath.slice(dir.length)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  return { dir, stem, ext }
}

/** JPEG quality staircase steps (descending), never going above `base`, floor at 40. */
export function jpegQualitySteps(base: number): number[] {
  const b = Number.isFinite(base) && base > 0 ? base : 80
  const steps = [b, 60, 40].filter((q) => q >= 40 && q <= b)
  return Array.from(new Set(steps)).sort((x, y) => y - x)
}

/**
 * Scrub sensitive query params from a URL; best-effort, never throws. The
 * `sensitiveKeys` default comes from the runtime env, but a caller that holds a
 * `RuntimeEnv` passes its own list so a live `/settings`-visible override is
 * honoured. Keeping the default here lets tests and external callers use the
 * function without threading an env object through.
 */
export function sanitizeUrl(raw: string, sensitiveKeys: string[] = DEFAULT_SENSITIVE_QUERY_KEYS): string {
  if (!raw) return raw
  const keys = sensitiveKeys.map((k) => k.toLowerCase()).filter(Boolean)
  // A query name is sensitive when it equals a configured key, or when one of
  // its `_`/`-`-separated segments equals one (`auth_token`, `api_key`, ...).
  // Plain substring matching was too greedy: `monkey`/`hockey`/`author` were
  // wiped because they merely CONTAIN `key`/`auth`.
  const isSensitive = (name: string): boolean => {
    const n = name.toLowerCase()
    if (keys.includes(n)) return true
    return n.split(/[_-]/).some((segment) => keys.includes(segment))
  }
  try {
    const u = new URL(raw)
    // Never surface userinfo: Basic-Auth credentials in an href are as
    // sensitive as a token and must not reach the model context.
    if (u.username !== '' || u.password !== '') {
      u.username = ''
      u.password = ''
    }
    for (const key of [...u.searchParams.keys()]) {
      if (isSensitive(key)) u.searchParams.delete(key)
    }
    return u.toString()
  } catch {
    // Relative href / unparseable: rewrite each `?name=value` pair by hand,
    // honouring the caller-configured sensitive key list. Also strip any
    // `//user:pass@` userinfo (Basic-Auth credentials) before query rewriting,
    // and decode percent-encoded query names so `%74oken` cannot bypass.
    let out = raw
    // Clear `//user:pass@` userinfo in protocol-relative hrefs (`new URL()`
    // throws without a base, so the fallback would otherwise leak credentials).
    // The regex requires `//` so a scheme like `mailto:user@host` is untouched.
    out = out.replace(/^\/\/([^/@?#]+)@/, '//')
    const isSensitiveDecoded = (name: string): boolean => {
      try { return isSensitive(decodeURIComponent(name)) } catch { return isSensitive(name) }
    }
    return out.replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, sep: string, name: string) =>
      isSensitiveDecoded(name) ? `${sep}${name}=***` : match)
  }
}

/** Mask a cookie value unless the caller explicitly asked to read it (P1-04). */
export function cookieValue(value: string, readValues: boolean): string {
  return readValues ? value : '***'
}

/** A tool error that carries a canonical {@link ErrorCode}. */
export class BrowserToolError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'BrowserToolError'
    this.code = code
  }
}
