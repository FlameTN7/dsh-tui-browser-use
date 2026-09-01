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
 * `abortSignalOf`) fires first → we surface `timed-out` and discard the stale
 * Playwright promise; the session is still serialized, so a leftover operation
 * cannot interleave with the next tool.
 */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined, message = 'operation aborted before dispatch'): Promise<T> {
  if (!signal) return p
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new BrowserToolError('timed-out', message))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
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
