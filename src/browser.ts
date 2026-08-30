/**
 * dsh-tui-browser-use — Playwright browser core.
 *
 * Drives a real browser for the agent tools. Playwright is the plugin's own
 * dependency (AGENTS.md §2), but the module is written so the plugin loads
 * even when the browser binary is missing: `playwright` is dynamic-imported
 * lazily, and the first tool call performs the startup probe (system Chrome
 * `channel:'chrome'` → Playwright Chromium). A missing browser surfaces as
 * `browser-error` with an actionable fix hint — never a silent crash.
 *
 * All Playwright interactions are structural-typed here so the module
 * compiles without depending on the playwright type package at build time.
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ErrorCode, NavigateParams, NavigateResult, ClickParams, ClickResult, TypeParams, TypeResult, EvaluateParams, EvaluateResult, ScreenshotParams, StatusResult, SnapshotParams, SnapshotNode, SnapshotResult, NavigationResult, ScrollParams, ScrollResult, PressParams, PressResult, WaitParams, WaitResult, HoverParams, HoverResult, CookiesParams, CookiesResult, ConsoleMessagesParams, ConsoleMessagesResult, NetworkRequestsParams, NetworkRequestsResult, PdfParams, PdfResult, DownloadParams, DownloadResult, I18nTemplate, BrowserUseConfig, CaptureSegmentsResult } from './types.js'
import { t } from './i18n.js'
import { effectiveViewport } from './capabilities.js'
import { requestUrl, displayUrl } from './download-url.js'
import { DEFAULT_MAX_IMAGE_BYTES } from './image-pipeline.js'
import { DEFAULT_SENSITIVE_QUERY_KEYS, loadRuntimeEnv, type RuntimeEnv } from './runtime-env.js'
import { PlaywrightDriver } from './driver/playwright-driver.js'
import type { BrowserDriver } from './driver/browser-driver.js'

// ── Structural Playwright types (no hard dependency) ─────────────────────

interface PwElementHandle {
  click(): Promise<void>
  fill(text: string): Promise<void>
  type(text: string): Promise<void>
  innerText(): Promise<string>
  isVisible(): Promise<boolean>
}

/** A Playwright locator handle (structural, minimal for click/fill/wait). */
interface PwLocator {
  click(): Promise<void>
  fill(text: string): Promise<void>
  type(text: string): Promise<void>
  clear(): Promise<void>
  hover(): Promise<void>
  first(): PwLocator
  waitFor(opts?: { state?: 'visible' | 'hidden' | 'attached' | 'detached'; timeout?: number }): Promise<void>
  count(): Promise<number>
}

/** A browser console message (structural). */
interface PwConsoleMessage {
  type(): string
  text(): string
}

/** A browser network request (structural). */
interface PwRequest {
  url(): string
  method(): string
}

/** A browser network response (structural). */
interface PwResponse {
  url(): string
  status(): number
}

/** A browser cookie (structural). */
interface PwCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: string
}

/** A Playwright keyboard handle (structural). */
interface PwKeyboard {
  press(key: string): Promise<void>
}

/** A browser dialog (alert/confirm/prompt/beforeunload). */
interface PwDialog {
  accept(): Promise<void>
  dismiss(): Promise<void>
  type(): string
  message(): string
}

interface PwPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<{ status(): number | null; url(): string } | null>
  title(): Promise<string>
  content(): Promise<string>
  url(): string
  screenshot(opts?: { type?: string; quality?: number; fullPage?: boolean; path?: string }): Promise<Buffer>
  click(selector: string): Promise<void>
  fill(selector: string, text: string): Promise<void>
  type(selector: string, text: string): Promise<void>
  evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>
  $(selector: string): Promise<PwElementHandle | null>
  locator(selector: string): PwLocator
  getByText(text: string): PwLocator
  getByRole(role: string, opts?: { name?: string }): PwLocator
  getByLabel(text: string): PwLocator
  frames(): PwFrame[]
  waitForLoadState(state?: string): Promise<void>
  setViewportSize(size: { width: number; height: number }): Promise<void>
  goBack(opts?: { waitUntil?: string; timeout?: number }): Promise<{ status(): number | null; url(): string } | null>
  goForward(opts?: { waitUntil?: string; timeout?: number }): Promise<{ status(): number | null; url(): string } | null>
  reload(opts?: { waitUntil?: string; timeout?: number }): Promise<{ status(): number | null; url(): string } | null>
  pdf(opts?: { format?: string; printBackground?: boolean; path?: string }): Promise<Buffer>
  keyboard: PwKeyboard
  on(event: 'dialog', handler: (dialog: PwDialog) => void): void
  on(event: 'console', handler: (message: PwConsoleMessage) => void): void
  on(event: 'request', handler: (request: PwRequest) => void): void
  on(event: 'response', handler: (response: PwResponse) => void): void
  on(event: 'requestfailed', handler: (request: PwRequest) => void): void
}

/** A child frame, with the same locator query surface as the page. */
interface PwFrame {
  locator(selector: string): PwLocator
  getByText(text: string): PwLocator
  getByRole(role: string, opts?: { name?: string }): PwLocator
  getByLabel(text: string): PwLocator
  url(): string
}

/** A browser context (cookie/localStorage isolation; storageState persistence). */
interface PwContext {
  newPage(): Promise<PwPage>
  storageState(opts?: { path?: string }): Promise<Record<string, unknown>>
  close(): Promise<void>
  cookies(urls?: string[]): Promise<PwCookie[]>
  addCookies(cookies: Array<{ name: string; value: string; url?: string; domain?: string; path?: string }>): Promise<void>
  clearCookies(): Promise<void>
  /** API request handle, used by `browser_download` to carry session cookies/auth. */
  request: PwApiRequestContext
}

interface PwApiResponse {
  ok(): boolean
  status(): number
  url(): string
  body(): Promise<Buffer>
  headers(): Record<string, string>
}

interface PwApiRequestContext {
  get(url: string, opts?: { timeout?: number }): Promise<PwApiResponse>
}

interface PwBrowser {
  close(): Promise<void>
  newPage(): Promise<PwPage>
  newContext(opts?: { storageState?: string }): Promise<PwContext>
  version(): string
  context(): { newPage(): Promise<PwPage> }
}

interface PwChromium {
  launch(opts: { channel?: string; executablePath?: string; headless?: boolean; args?: string[]; proxy?: { server: string; bypass?: string } }): Promise<PwBrowser>
}

/** Common launch options shared by every Playwright browser engine. */
type PwLaunchOptions = { channel?: string; executablePath?: string; headless?: boolean; args?: string[]; proxy?: { server: string; bypass?: string }; userDataDir?: string }

/**
 * Wait for a dynamically-rendered target (SPA / lazy content) to be actionable
 * before an interaction. Retries a few times because a click/type on an element
 * that is attached but still animating can miss. Mirrors browser-use's
 * `_wait_for_minimum_elements` + Playwright MCP's `--timeout-action`.
 */
async function waitForLocator(locator: PwLocator, timeoutMs = 6000): Promise<void> {
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
function resolveLocator(target: PwPage | PwFrame, selector?: string, text?: string): PwLocator {
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
async function resolveFrameAware(page: PwPage, selector?: string, text?: string): Promise<PwLocator> {
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
// ── Structural config helpers ────────────────────────────────────────────

/**
 * Split a save path into its directory and a "stem" (basename minus one final
 * extension). Unlike a bare `lastIndexOf('.')`, an extensionless path keeps its
 * full basename as the stem (e.g. `/tmp/multi-noext` → `{dir:'/tmp/',
 * stem:'multi-noext'}`, NOT `multi-noex`). A leading-dot file (`.hidden`) is
 * treated as extensionless so its name is preserved.
 */
export function splitSaveStem(savePath: string): { dir: string; stem: string } {
  const dir = savePath.slice(0, Math.max(savePath.lastIndexOf('/'), savePath.lastIndexOf('\\')) + 1)
  const base = savePath.slice(dir.length)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return { dir, stem }
}

/** Numeric env override helper: returns the parsed value or the fallback. */
/** JPEG quality staircase steps (descending), never going above `base`, floor at 40. */
function jpegQualitySteps(base: number): number[] {
  const b = Number.isFinite(base) && base > 0 ? base : 80
  const steps = [b, 60, 40].filter((q) => q >= 40 && q <= b)
  return Array.from(new Set(steps)).sort((x, y) => y - x)
}

/**
 * Capture a screenshot and, for JPEG, drop the quality until the payload fits
 * the byte budget (the "capture-time compression" from proposal §5.3). PNG is
 * never re-encoded — it's captured once and the pipeline marks it `oversize`.
 */
async function captureWithBudget(
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

// ── Sensitive-data redaction (P1-04) ──────────────────────────────────────
//
// Cookie values, URLs in the network log, and `href` in the a11y snapshot can
// carry credentials (session tokens, API keys, signed URLs). Default to
// redacting so a page's auth state never leaks into the model context. The
// query-key list is configurable via DSH_TUI_BROWSER_SENSITIVE_QUERY_KEYS.

/**
 * Scrub sensitive query params from a URL; best-effort, never throws. The
 * `sensitiveKeys` default comes from the runtime env, but a caller that holds a
 * `RuntimeEnv` passes its own list so a live `/settings`-visible override is
 * honoured. Keeping the default here lets tests and external callers use the
 * function without threading an env object through.
 */
export function sanitizeUrl(raw: string, sensitiveKeys: string[] = DEFAULT_SENSITIVE_QUERY_KEYS): string {
  if (!raw) return raw
  try {
    const u = new URL(raw)
    for (const key of [...u.searchParams.keys()]) {
      if (sensitiveKeys.some((k) => key.toLowerCase().includes(k.toLowerCase()))) {
        u.searchParams.delete(key)
      }
    }
    return u.toString()
  } catch {
    // Relative href / unparseable: strip common `?key=value` pairs by hand.
    return raw.replace(/([?&](?:token|key|signature|sig|secret|api_key|apikey|access_token|session|cred|auth)=)[^&]*/gi, '$1***')
  }
}

/** Mask a cookie value unless the caller explicitly asked to read it (P1-04). */
export function cookieValue(value: string, readValues: boolean): string {
  return readValues ? value : '***'
}

/** The long-lived browser session shared across tool calls. */
export class BrowserSession {
  private page: PwPage | null = null
  private ctx: PwContext | null = null
  private startError: string | null = null
  private lang: 'zh' | 'en'
  /** The injected browser backend (swappable via constructor). Defaults to Playwright. */
  private readonly driver: BrowserDriver
  // We don't hard-require a config at construction; the plugin injects it.
  config: BrowserUseConfig

  // ── Serial mutex (P1 #9) ───────────────────────────────────────────────
  // Single shared browser page → tool calls MUST never interleave Playwright
  // operations (e.g. a click racing a screenshot). Every public tool method is
  // funnelled through `run()`, which chains each task onto the previous so the
  // session is a strict serial queue.
  private chain: Promise<unknown> = Promise.resolve()

  // ── Parameterized timeouts (P1 #9), env-overridable ────────────────────
  private readonly navTimeoutMs: number
  private readonly actionTimeoutMs: number
  private readonly settleTimeoutMs: number

  // ── Session-state persistence (P1 #8) ───────────────────────────────────
  // userDataDir retains the full browser profile (cookies/localStorage) across
  // runs; storageStatePath exports/imports a bare cookie+localStorage snapshot.
  // Both are env-driven (DSH_TUI_BROWSER_USER_DATA_DIR / _STORAGE_STATE); a
  // missing or unreadable path degrades to a fresh session rather than failing.
  private readonly userDataDir: string | undefined
  private readonly storageStatePath: string | undefined
  private readonly dialog: 'accept' | 'dismiss' | 'ignore'

  // ── Console / network capture (P1 #7) ───────────────────────────────────
  // Ring buffers of recent console messages and network requests so the agent
  // can inspect page errors / XHR without a full devtools trace. Capped so a
  // chatty page never grows memory unbounded.
  private consoleLog: string[] = []
  private networkLog: string[] = []
  private static readonly CAPTURE_CAP = 500

  /** The injected runtime environment (timeouts, dialog, session paths, ...). */
  private readonly env: RuntimeEnv

  constructor(config: BrowserUseConfig, lang: 'zh' | 'en', env: RuntimeEnv = loadRuntimeEnv(), driver: BrowserDriver = new PlaywrightDriver()) {
    this.config = config
    this.lang = lang
    this.env = env
    this.driver = driver
    this.navTimeoutMs = env.navTimeoutMs
    this.actionTimeoutMs = env.actionTimeoutMs
    this.settleTimeoutMs = env.settleTimeoutMs
    this.dialog = env.dialog
    this.userDataDir = env.userDataDir
    this.storageStatePath = env.storageStatePath
  }

  /**
   * Serialize a task onto the session queue: each caller waits for the previous
   * task to settle. The internal chain never rejects, so a failed task does not
   * wedge the queue; the task's own rejection is still surfaced to its caller.
   * Exposed publicly so the tool registry can funnel every tool call through the
   * same single-browser-page lock (P1 #9): concurrent tool calls become a strict
   * serial queue instead of interleaving Playwright operations.
   */
  /** Resolve the effective viewport size (P0-03). Prefers the explicit
   * `viewport` config; falls back to the deprecated `screenshot.maxDimension`
   * alias used by older configs / test scripts, then the 1024×768 default. */
  private viewportSize(): { width: number; height: number } {
    return effectiveViewport(this.config)
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(() => task())
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * Hot-apply a new viewport size to the live page (R-07). When the browser is
   * already started, a `/settings` change to `viewport` must resize the current
   * page rather than only taking effect on the next session (which would
   * silently ignore a mid-session edit). Serialized through `run()` so it never
   * interleaves a pending Playwright tool call. A not-yet-started session is a
   * no-op (the next `ensureStarted()` reads the new config).
   */
  async applyViewport(size?: { width: number; height: number }): Promise<void> {
    const dim = size ?? this.viewportSize()
    const page = this.page
    if (!page) return
    await this.run(async () => {
      await page.setViewportSize({ width: dim.width, height: dim.height }).catch(() => undefined)
    })
  }

  /**
   * Ensure a browser and page exist, probing sources in order:
   * system Chrome (`channel:'chrome'`) → explicit binary (`executablePath`) →
   * Playwright-bundled Chromium. `DSH_TUI_BROWSER_ENGINE` selects `firefox`/
   * `webkit` for cross-engine coverage; the chromium path stays the default.
   * The launch + probe logic lives in the injected {@link BrowserDriver}; this
   * session forwards the effective config/env and caches the resulting
   * page/context for its own orchestration (run/timeout/snapshot/tiling).
   */
  async ensureStarted(): Promise<boolean> {
    if (this.page !== null && this.ctx !== null) return true
    const started = await this.driver.start({
      config: this.config,
      env: this.env,
      lang: this.lang,
      handlers: {
        onConsole: (m) => {
          this.consoleLog.push(`[${m.type()}] ${m.text()}`)
          if (this.consoleLog.length > BrowserSession.CAPTURE_CAP) this.consoleLog.shift()
        },
        onRequest: (r) => {
          this.networkLog.push(`REQ ${r.method()} ${sanitizeUrl(r.url(), this.env.sensitiveQueryKeys)}`)
          if (this.networkLog.length > BrowserSession.CAPTURE_CAP) this.networkLog.shift()
        },
        onResponse: (r) => {
          this.networkLog.push(`${r.status()} ${sanitizeUrl(r.url(), this.env.sensitiveQueryKeys)}`)
          if (this.networkLog.length > BrowserSession.CAPTURE_CAP) this.networkLog.shift()
        },
        onRequestFailed: (r) => {
          this.networkLog.push(`<no-response> ${sanitizeUrl(r.url(), this.env.sensitiveQueryKeys)}`)
          if (this.networkLog.length > BrowserSession.CAPTURE_CAP) this.networkLog.shift()
        },
      },
    })
    if (!started) {
      this.startError = this.driver.startError ?? t('error.browser-missing', this.lang)
      this.page = null
      this.ctx = null
      return false
    }
    // Cache the driver's live page/context so the rest of the session's
    // orchestration (run/timeout/snapshot/tiling) operates on the real handles.
    this.page = this.driver.page
    this.ctx = this.driver.context
    this.startError = null
    return true
  }

  private requirePage(): PwPage {
    if (!this.page) throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: 'browser not started' }))
    return this.page
  }

  private requireContext(): PwContext {
    if (!this.ctx) throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: 'browser context not started' }))
    return this.ctx
  }

  /** Release the browser and mark the session unstarted. */
  async close(): Promise<void> {
    // Persist a login snapshot back to the configured path (best-effort) before
    // tearing the browser down.
    if (this.storageStatePath && this.ctx) {
      try { await this.ctx.storageState({ path: this.storageStatePath }) } catch { /* best-effort */ }
    }
    await this.driver.close()
    this.page = null
    this.ctx = null
  }

  // ── Tools ──────────────────────────────────────────────────────────────

  async navigate(params: NavigateParams): Promise<NavigateResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      // Use `domcontentloaded` rather than `load`: many real external pages
      // (duckduckgo, wikipedia) keep running scripts so a `load` event can be
      // delayed far past a sane timeout. DOM-ready is enough to read the title
      // and interact; the follow-up `waitForLoadState('load')` is best-effort and
      // never blocks a successful navigate.
      const resp = await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: this.navTimeoutMs })
      await page.waitForLoadState('load').catch(() => undefined)
      // Let the layout settle a beat rather than racing a still-parsing document.
      await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => undefined)
      return {
        title: await page.title(),
        // R-11: sanitize the resolved URL so a signed/token-carrying redirect
        // target never leaks into the model context.
        url: sanitizeUrl(resp?.url() ?? params.url, this.env.sensitiveQueryKeys),
        status: resp?.status() ?? null,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
  }

  async click(params: ClickParams): Promise<ClickResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const page = this.requirePage()
    const before = page.url()
    try {
      // `text` (visible text) wins over `selector` (CSS); a bare selector keeps
      // using the CSS path. Searches main frame then child frames (iframe).
      // Wait for the target to be actionable (SPA/lazy).
      const locator = await resolveFrameAware(page, params.selector, params.text)
      await waitForLocator(locator, this.actionTimeoutMs)
      await locator.first().click()
      await page.waitForLoadState('load').catch(() => undefined)
      return { success: true, newUrl: sanitizeUrl(page.url() || before, this.env.sensitiveQueryKeys) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
  }

  async type(params: TypeParams): Promise<TypeResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      // `type` uses a CSS selector (the caller queries the field). Search main
      // frame then child frames, and wait for the input before filling so a SPA
      // that mounts its form late doesn't miss.
      const locator = await resolveFrameAware(page, params.selector, undefined)
      await waitForLocator(locator, this.actionTimeoutMs)
      const field = locator.first()
      if (params.clear) await field.clear().catch(() => undefined)
      await field.fill(params.text)
      // Optional trailing keypress (e.g. `Enter` to submit a form) — requires a
      // focused page, which Playwright keeps after fill.
      if (params.enter) {
        try { await page.keyboard.press(params.enter) } catch { /* key may be unsupported; ignore */ }
      }
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
  }

  /** Shared post-navigation settle used by back/forward/reload. */
  private async navSettle(resp: { status(): number | null; url(): string } | null, fallbackUrl: string): Promise<NavigationResult> {
    const page = this.requirePage()
    await page.waitForLoadState('load').catch(() => undefined)
    await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => undefined)
    return { title: await page.title(), url: sanitizeUrl(resp?.url() ?? fallbackUrl, this.env.sensitiveQueryKeys), status: resp?.status() ?? null }
  }

  async back(): Promise<NavigationResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      const before = page.url()
      const resp = await page.goBack({ waitUntil: 'domcontentloaded', timeout: this.navTimeoutMs }).catch(() => null)
      return await this.navSettle(resp, before)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
  }

  async forward(): Promise<NavigationResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      const before = page.url()
      const resp = await page.goForward({ waitUntil: 'domcontentloaded', timeout: this.navTimeoutMs }).catch(() => null)
      return await this.navSettle(resp, before)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
  }

  async reload(): Promise<NavigationResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      const before = page.url()
      const resp = await page.reload({ waitUntil: 'domcontentloaded', timeout: this.navTimeoutMs }).catch(() => null)
      return await this.navSettle(resp, before)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
  }

  async scroll(params: ScrollParams): Promise<ScrollResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const page = this.requirePage()
    const x = Math.trunc(Number(params.x) || 0)
    const y = Math.trunc(Number(params.y) || 0)
    try {
      await page.evaluate(`window.scrollBy(${x}, ${y})`)
      await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => undefined)
      const pos = await page.evaluate<{ x: number; y: number }>('({ x: window.scrollX, y: window.scrollY })').catch(() => ({ x, y }))
      return { x: Math.trunc(pos?.x ?? x), y: Math.trunc(pos?.y ?? y) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
  }

  async press(params: PressParams): Promise<PressResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      await page.keyboard.press(params.key)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
  }

  /** Wait for a selector to become visible, or sleep for `ms`. */
  async wait(params: WaitParams): Promise<WaitResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      if (params.selector) {
        const locator = await resolveFrameAware(page, params.selector, undefined)
        await waitForLocator(locator, params.timeoutMs ?? this.settleTimeoutMs)
        return { waited: true, visible: true }
      }
      const ms = Math.max(0, Math.min(Number(params.ms) || 0, 30_000))
      if (ms > 0) await new Promise((r) => setTimeout(r, ms))
      return { waited: true, ...(ms > 0 ? { ms } : {}) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
  }

  async hover(params: HoverParams): Promise<HoverResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      // `text` (visible text) wins over `selector`; search main frame then frames.
      const locator = await resolveFrameAware(page, params.selector, params.text)
      await waitForLocator(locator, this.actionTimeoutMs)
      await locator.first().hover()
      // Let any hover-triggered UI settle a beat.
      await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => undefined)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
  }

  async cookies(params: CookiesParams): Promise<CookiesResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const ctx = this.requireContext()
    try {
      if (params.clear) await ctx.clearCookies().catch(() => undefined)
      if (params.cookies && params.cookies.length > 0) {
        await ctx.addCookies(params.cookies).catch(() => undefined)
      }
      const cookies = await ctx.cookies()
      // Redact cookie values by default so auth state never leaks into the
      // model context; `readValues: true` is the explicit opt-in (P1-04).
      const readValues = params.readValues === true
      return { cookies: cookies.map((c) => ({ ...c, value: cookieValue(c.value, readValues) })) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
  }

  async consoleMessages(params: ConsoleMessagesParams): Promise<ConsoleMessagesResult> {
    if (!(await this.ensureStarted())) return { messages: [] }
    const out = [...this.consoleLog]
    if (params.clear !== false) this.consoleLog = []
    return { messages: out }
  }

  async networkRequests(params: NetworkRequestsParams): Promise<NetworkRequestsResult> {
    if (!(await this.ensureStarted())) return { requests: [] }
    const out = [...this.networkLog]
    if (params.clear !== false) this.networkLog = []
    return { requests: out }
  }

  async evaluate(params: EvaluateParams): Promise<EvaluateResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      const result = await page.evaluate(params.expression as unknown as string)
      return { result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
  }

  /** Capture the current viewport as a PNG buffer at the configured quality. */
  async captureScreenshot(_params: ScreenshotParams): Promise<Buffer> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const page = this.requirePage()
    const type = this.config.screenshot.format === 'png' ? 'png' : 'jpeg'
    return page.screenshot({ type, quality: type === 'jpeg' ? this.config.screenshot.quality : undefined })
  }

  /**
   * Capture the page as one or more viewport screenshots, splitting pages that
   * exceed the tiling threshold into readable segments via scroll-capture
   * tiling.
   *
   * When `tiling.mode` is `off`, or the page fits within the viewport/threshold
   * under `auto`, it returns a single screenshot (identical to
   * {@link captureScreenshot}). Otherwise it scrolls the page in viewport-sized
   * steps along BOTH axes and captures each segment, honoring the configured
   * overlap (so a very tall page never produces one oversized image a vision
   * model cannot read, and a very wide page is not clipped to the left viewport).
   *
   * The result reports whether any needed segment was dropped because the
   * `maxTiles` cap was reached (`truncated`), how many tiles were planned vs
   * captured, and the pixel extent covered — so callers can surface the loss to
   * the agent instead of silently omitting content.
   */
  async captureSegments(opts?: { maxImageBytes?: number }): Promise<CaptureSegmentsResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const page = this.requirePage()
    const type = this.config.screenshot.format === 'png' ? 'png' : 'jpeg'
    const quality = type === 'jpeg' ? this.config.screenshot.quality : undefined
    const budget = opts?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
    const dim = effectiveViewport(this.config)
    const vpW = dim.width
    const vpH = dim.height
    const overlap = Math.max(0, this.config.tiling.overlap || 0)
    const stepX = Math.max(1, vpW - overlap)
    const stepY = Math.max(1, vpH - overlap)

    const single = async (): Promise<CaptureSegmentsResult> => {
      const buf = await captureWithBudget(page, type, quality, budget)
      // Even when not tiling, report the page's real scrollable extent (not the
      // viewport size) so callers/agents see how much content exists (P1-09).
      const size = await page.evaluate<{ w: number; h: number }>(
        '({ w: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth), h: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) })',
      ).catch(() => ({ w: 0, h: 0 }))
      return {
        buffers: [buf], truncated: false, segmentsTotal: 1, captured: 1,
        capturedWidth: vpW, capturedHeight: vpH,
        pageWidth: size.w || vpW, pageHeight: size.h || vpH,
      }
    }

    // No tiling requested → single viewport capture.
    if (this.config.tiling.mode === 'off') return single()

    // Determine the scrollable width/height and the "needs tiling" thresholds.
    const size = await page.evaluate<{ w: number; h: number }>(
      '({ w: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth), h: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) })',
    ).catch(() => ({ w: 0, h: 0 }))
    const pageW = size.w
    const pageH = size.h
    const dimT = this.config.tiling.threshold.split('x').map((s) => Number.parseInt(s.trim(), 10))
    const thresholdW = Number.isFinite(dimT[0] as number) ? (dimT[0] as number) : vpW
    const thresholdH = Number.isFinite(dimT[1] as number) ? (dimT[1] as number) : vpH

    // `auto`: single capture when the page already fits the viewport/threshold in
    // BOTH axes. Unknown dimensions (e.g. detached document) also fall back to a
    // single capture.
    const fits = pageW > 0 && pageH > 0 && pageW <= Math.max(thresholdW, vpW) && pageH <= Math.max(thresholdH, vpH)
    if (this.config.tiling.mode === 'auto' && fits) return single()
    if (pageW <= 0 || pageH <= 0) return single()

    // Scroll-capture tiling: iterate top-to-bottom in BANDS, and within each
    // band left-to-right across the columns — ROW-major reading order, which is
    // how the model naturally reads a grid of tiles (top-left → bottom-right).
    // Both axes loop, so a page wider than the viewport is captured as multiple
    // columns instead of being clipped to the left viewport. Row-major matters
    // under the maxTiles cap: filling a whole band (all columns) before moving
    // down means truncation drops the BOTTOM of the page (the same semantic as a
    // tall page), never an entire right-hand column while a band is half-read.
    const maxTiles = this.config.tiling.maxTiles ?? this.env.maxTiles
    const neededCols = pageW > vpW ? Math.ceil((pageW - vpW) / stepX) + 1 : 1
    const neededRows = pageH > vpH ? Math.ceil((pageH - vpH) / stepY) + 1 : 1
    const segmentsTotal = neededCols * neededRows

    const buffers: Buffer[] = []
    let capturedWidth = 0
    let capturedHeight = 0
    outer: for (let cy = 0; cy < neededRows; cy += 1) {
      const y = cy * stepY
      for (let cx = 0; cx < neededCols; cx += 1) {
        if (buffers.length >= maxTiles) break outer
        const x = cx * stepX
        await page.evaluate(`window.scrollTo(${x}, ${y})`).catch(() => undefined)
        // Wait two animation frames so the segment is painted before capture.
        await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => undefined)
        buffers.push(await captureWithBudget(page, type, quality, budget))
        capturedWidth = Math.max(capturedWidth, x + vpW)
        capturedHeight = Math.max(capturedHeight, y + vpH)
      }
    }
    // Restore the scroll position for the next tool call.
    await page.evaluate('window.scrollTo(0, 0)').catch(() => undefined)
    if (buffers.length === 0) return single()

    const truncated = buffers.length < segmentsTotal
    return {
      buffers,
      truncated,
      segmentsTotal,
      captured: buffers.length,
      capturedWidth: Math.min(capturedWidth, pageW),
      capturedHeight: Math.min(capturedHeight, pageH),
      pageWidth: pageW,
      pageHeight: pageH,
    }
  }

  /**
   * Print the current page to a PDF. When `path` is omitted the PDF is written
   * to a temp file; the result always reports the absolute path and byte size so
   * the agent can hand the artifact off (e.g. for further processing).
   */
  async pdf(params: PdfParams): Promise<PdfResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      const format = params.format || 'A4'
      const printBackground = params.printBackground !== false
      const buf = await page.pdf({ format, printBackground })
      let outPath = params.path ?? ''
      if (!outPath) {
        outPath = join(tmpdir(), `browser-use-${Date.now()}.pdf`)
      } else {
        const dir = outPath.slice(0, Math.max(outPath.lastIndexOf('/'), outPath.lastIndexOf('\\')) + 1)
        if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
      }
      writeFileSync(outPath, buf)
      return { url: sanitizeUrl(page.url(), this.env.sensitiveQueryKeys), path: outPath, bytes: buf.length }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
  }

  /**
   * Download a file from a URL and write it to disk. Uses the page's request
   * context so cookies/auth from the current session carry over (e.g. a
   * signed download link the page just exposed). `path` is written as-is (when
   * omitted a temp file is used); the result reports the absolute path and byte
   * size so the agent can hand the artifact off.
   */
  async download(params: DownloadParams): Promise<DownloadResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const context = this.requireContext()
    // Request the RAW URL (a signed/token URL must not be scrubbed) — only the
    // displayed URL is sanitized so a secret never leaks into the model context.
    const url = requestUrl(params.url)
    try {
      const resp = await context.request.get(url, { timeout: this.navTimeoutMs })
      if (!resp.ok()) {
        throw new BrowserToolError('browser-error', t('error.download', this.lang, { message: `HTTP ${resp.status()}` }))
      }
      const buf = await resp.body()
      let outPath = params.savePath ?? ''
      if (!outPath) {
        outPath = join(tmpdir(), `browser-use-${Date.now()}.bin`)
      } else {
        const dir = outPath.slice(0, Math.max(outPath.lastIndexOf('/'), outPath.lastIndexOf('\\')) + 1)
        if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
      }
      writeFileSync(outPath, buf)
      return {
        url: displayUrl(params.url, resp.url() ?? params.url, this.env.sensitiveQueryKeys),
        path: outPath,
        bytes: buf.length,
        contentType: resp.headers()['content-type'],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
  }

  /**
   * Write captured screenshot buffers to disk. A single buffer goes to
   * `savePath` verbatim; multiple tiled buffers are written as
   * `<stem>-<i>.<ext>` beside it (never clobbering each other). Returns the
   * absolute paths written (first + all). The page is NOT re-captured — the
   * caller passes the buffers it already captured.
   */
  async saveScreenshots(buffers: Buffer[], savePath: string, format: string): Promise<{ savedPath: string; savedPaths: string[] }> {
    if (!buffers.length) throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: 'no screenshot buffers to save' }))
    const ext = format === 'png' ? 'png' : 'jpg'
    const outDir = savePath.slice(0, Math.max(savePath.lastIndexOf('/'), savePath.lastIndexOf('\\')) + 1)
    if (outDir && !existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    const saved: string[] = []
    if (buffers.length === 1) {
      writeFileSync(savePath, buffers[0]!)
      return { savedPath: savePath, savedPaths: [savePath] }
    }
    // Multiple tiles: write `name-1.ext`, `name-2.ext`, ... beside `savePath`.
    // Use the shared `splitSaveStem` so an extensionless path keeps its stem
    // intact (e.g. `/tmp/multi-noext` → `multi-noext-1.png`, NOT `multi-noex-1.png`).
    const { dir, stem } = splitSaveStem(savePath)
    buffers.forEach((buf, i) => {
      const p = `${dir}${stem}-${i + 1}.${ext}`
      writeFileSync(p, buf)
      saved.push(p)
    })
    return { savedPath: saved[0] ?? '', savedPaths: saved }
  }

  /**
   * Return a structured accessibility snapshot of the current page — an indexed
   * list of interactive/semantic elements (role, accessible name, tag, disabled,
   * bounding box). This is the agent's default observation: it can reason about
   * what is clickable/typeable without a screenshot, and vision stays the
   * fallback for genuinely visual content (canvas, charts, images).
   *
   * Computed fully in the page context via DOM walking (no Playwright a11y
   * snapshot API dependency, which was removed upstream), so it works across
   * engines and keeps the plugin's structural typing. Node count is capped so a
   * huge page never bloats the model context.
   */
  async snapshot(params: SnapshotParams): Promise<SnapshotResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const page = this.requirePage()
    const maxNodes = Math.min(Math.max(Number(params.maxNodes) || 200, 1), 500)
    try {
      const nodes = (await page.evaluate<unknown[]>(
        `(() => {
          const MAX = ${maxNodes};
          const accName = (el) => {
            // aria-labelledby references one or more element ids whose text is the name.
            const labelledby = el.getAttribute('aria-labelledby');
            if (labelledby) {
              const names = labelledby.split(/\\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').filter(Boolean);
              if (names.length) return names.join(' ').trim();
            }
            const aria = el.getAttribute('aria-label');
            if (aria && aria.trim()) return aria.trim();
            const alt = el.getAttribute('alt');
            if (alt && alt.trim()) return alt.trim();
            // Label element for form controls.
            if (el.matches('input, textarea, select')) {
              const id = el.id;
              if (id) {
                const lbl = document.querySelector('label[for="' + id + '"]');
                if (lbl && lbl.textContent.trim()) return lbl.textContent.trim();
              }
            }
            const text = (el.innerText || el.textContent || '').trim();
            if (text) return text.slice(0, 160);
            const ph = el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('value') || el.getAttribute('title');
            if (ph && ph.trim()) return ph.trim().slice(0, 160);
            return '';
          };
          const selector = [
            'a[href]', 'button', '[role=button]', '[role=link]', '[role=menuitem]',
            '[role=tab]', '[role=checkbox]', '[role=radio]', '[role=switch]',
            '[role=textbox]', '[role=combobox]', '[role=slider]',
            'input:not([type=hidden])', 'textarea', 'select', '[contenteditable=true]',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[aria-label]', '[aria-labelledby]',
          ].join(',');
          const seen = new Set();
          const nodes = [];
          let totalMatching = 0;
          const all = document.querySelectorAll(selector);
          for (const el of all) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute('role') ||
              (tag === 'a' && el.hasAttribute('href') ? 'link' :
               tag === 'button' ? 'button' :
               tag === 'textarea' ? 'textbox' :
               tag === 'select' ? 'combobox' :
               tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6' ? 'heading' :
               tag === 'input' ? (el.getAttribute('type') || 'text') : tag);
            const name = accName(el);
            const key = tag + '|' + role + '|' + name + '|' + Math.round(rect.x) + '|' + Math.round(rect.y);
            if (seen.has(key)) continue;
            seen.add(key);
            totalMatching += 1;
            if (nodes.length >= MAX) continue;
            const node = {
              index: nodes.length + 1,
              role, name: name.slice(0, 160), tag,
              disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
              x: Math.round(rect.x), y: Math.round(rect.y),
              width: Math.round(rect.width), height: Math.round(rect.height),
            };
            const type = el.getAttribute('type');
            if (type) node.type = type;
            if (el.hasAttribute('placeholder')) node.placeholder = el.getAttribute('placeholder');
            if (el.hasAttribute('href')) node.href = el.getAttribute('href');
            if (el.checked !== undefined) node.checked = el.checked === true;
            nodes.push(node);
          }
          return { nodes, total: totalMatching, truncated: totalMatching > nodes.length };
        })()`,
      )) ?? { nodes: [] }
      const raw = (typeof nodes === 'object' && nodes && 'nodes' in nodes && Array.isArray((nodes as { nodes: SnapshotNode[] }).nodes))
        ? (nodes as { nodes: SnapshotNode[]; total?: number; truncated?: boolean })
        : { nodes: nodes as SnapshotNode[], total: undefined, truncated: undefined }
      const out = raw.nodes.map((n) => (n.href ? { ...n, href: sanitizeUrl(n.href, this.env.sensitiveQueryKeys) } : n))
      return { nodes: out, ...(raw.total !== undefined ? { total: raw.total } : {}), ...(raw.truncated !== undefined ? { truncated: raw.truncated } : {}) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
  }

  /** Gather a best-effort summary of visible interactive elements. */
  async elementSummary(): Promise<string> {
    if (!(await this.ensureStarted())) return ''
    const page = this.requirePage()
    try {
      const result = await page.evaluate(
        `(() => {
          const pick = (sel) => [...document.querySelectorAll(sel)]
            .filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0)
            .slice(0, 30)
            .map((el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('value') || el.textContent || '').trim().slice(0, 80))
            .filter(Boolean);
          const links = pick('a[href]');
          const buttons = pick('button, input[type=button], input[type=submit], [role=button]');
          const inputs = pick('input:not([type=hidden]), textarea, [contenteditable=true]');
          return ['links:', ...links, 'buttons:', ...buttons, 'inputs:', ...inputs].join('\\n');
        })()`,
      )
      return typeof result === 'string' ? result : ''
    } catch {
      return ''
    }
  }

  /** Report browser availability plus the effective config snapshot. */
  async status(): Promise<StatusResult> {
    const available = await this.ensureStarted()
    let version = 'unknown'
    if (available) {
      try { version = this.driver.version() } catch { /* keep unknown */ }
    }
    return { available, version, config: structuredClone(this.config) }
  }
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

/** Convenience: format an error into a failure envelope. */
export function errorEnvelope(code: ErrorCode, message: string): { ok: false; error: { code: ErrorCode; message: string } } {
  return { ok: false, error: { code, message } }
}

// Re-export the i18n template type so tools.ts can build error strings.
export type { I18nTemplate }
