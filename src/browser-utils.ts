/**
 * dsh-tui-browser-use — browser helper utilities.
 *
 * Pure, Playwright-agnostic helpers shared by the browser session orchestration
 * (browser.ts) and the page-operations class (page-ops.ts). These carry no
 * session state and never reach into the harness; they are the single source of
 * truth for the abort-shot-circuit race, the frame-aware locator resolution,
 * the capture-time JPEG quality staircase, and the sensitive-data redaction
 * (URL/cookie). Keeping them here (rather than on `BrowserSession`) means both
 * the orchestrator and the page-ops layer share the SAME shapes, and the
 * module stays free of a hard runtime dependency on the playwright type package
 * (AGENTS.md §2).
 */

import type { ErrorCode } from './types.js'
import type { PwPage, PwFrame, PwLocator } from './driver/browser-driver.js'
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
 * Wait for a dynamically-rendered target (SPA / lazy content) to be actionable
 * before an interaction. Retries a few times because a click/type on an element
 * that is attached but still animating can miss. Mirrors browser-use's
 * `_wait_for_minimum_elements` + Playwright MCP's `--timeout-action`.
 */
export async function waitForLocator(locator: PwLocator, timeoutMs = 6000): Promise<void> {
  // `waitFor` starts from the current DOM; it does not re-query after a first
  // failed attempt, so cap each try and retry a few times.
  const perTry = Math.max(800, Math.min(3000, Math.round(timeoutMs / 3)))
  for (let i = 0; i < 3; i += 1) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout: perTry })
      return
    } catch { /* re-query next attempt */ }
  }
  // Final attempt surfaces the error (so the caller gets a useful message).
  await locator.first().waitFor({ state: 'visible', timeout: perTry })
}

/**
 * Resolve a locator from a caller-provided selector/text, honoring Playwright's
 * richer query strategies in addition to CSS:
 *   - `text=` / visible-text match (used by `browser_click({ text })`)
 *   - `role=button[name=x]` / ARIA role match
 *   - plain CSS selector (used by `browser_type({ selector })`)
 * Prefers the semantically-stable text/role match over brittle CSS class chains
 * (dynamic sites compile/hash their class names; accessible names do not).
 */
export function resolveLocator(target: PwPage | PwFrame, selector?: string, text?: string): PwLocator {
  if (text !== undefined && text.length > 0) {
    return target.getByText(text)
  }
  if (selector && /^role=/.test(selector)) {
    const m = /^role=([a-z]+)(?:\[name=(.+)\])?/i.exec(selector)
    if (m?.[1]) return target.getByRole(m[1], m[2] !== undefined ? { name: m[2] } : undefined)
  }
  if (selector && /^label=/.test(selector)) {
    return target.getByLabel(selector.slice('label='.length))
  }
  return target.locator(selector ?? '')
}

/**
 * Resolve an actionable locator across the page and its child frames. Tries the
 * main frame first, then each `page.frames()` (iframe), so a selector/text that
 * lives inside an embedded frame is still found. Uses `count()` (async) to pick
 * the first candidate that actually matches, rather than assuming a frame owns
 * the target. Returns the main-frame locator as a fallback.
 */
export async function resolveFrameAware(page: PwPage, selector?: string, text?: string): Promise<PwLocator> {
  const main = resolveLocator(page, selector, text)
  // Count is async, but a bare empty selector is never actionable.
  if (selector === undefined && text === undefined) return main
  try {
    const mainCount = await main.count()
    if (mainCount > 0) return main
  } catch { /* ignore and fall through to frames */ }
  const frames = page.frames()
  for (const frame of frames) {
    const loc = resolveLocator(frame, selector, text)
    try {
      const n = await loc.count()
      if (n > 0) return loc
    } catch { /* try next frame */ }
  }
  return main
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
 * Capture a screenshot and, for JPEG, drop the quality until the payload fits
 * the byte budget (the "capture-time compression" from proposal §5.3). PNG is
 * never re-encoded — it's captured once and the pipeline marks it `oversize`.
 */
export async function captureWithBudget(
  page: PwPage,
  type: string,
  quality: number | undefined,
  maxImageBytes: number,
): Promise<Buffer> {
  if (type !== 'jpeg') {
    return page.screenshot({ type, quality: undefined })
  }
  const steps = jpegQualitySteps(quality ?? 80)
  let last: Buffer | null = null
  for (const q of steps) {
    last = await page.screenshot({ type, quality: q })
    if (last.length <= maxImageBytes) return last
  }
  return last ?? (await page.screenshot({ type, quality }))
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
