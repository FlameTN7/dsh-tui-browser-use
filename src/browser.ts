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

import { existsSync, openSync, readSync, closeSync, statSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ErrorCode, NavigateParams, NavigateResult, ClickParams, ClickResult, TypeParams, TypeResult, EvaluateParams, EvaluateResult, ScreenshotParams, StatusResult, SnapshotParams, SnapshotNode, SnapshotResult, NavigationResult, ScrollParams, ScrollResult, PressParams, PressResult, WaitParams, WaitResult, HoverParams, HoverResult, CookiesParams, CookiesResult, ConsoleMessagesParams, ConsoleMessagesResult, NetworkRequestsParams, NetworkRequestsResult, PdfParams, PdfResult, I18nTemplate, BrowserUseConfig } from './types.js'
import { t } from './i18n.js'

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

interface PwModule {
  chromium: PwChromium
  firefox?: { launch(opts: PwLaunchOptions): Promise<PwBrowser> }
  webkit?: { launch(opts: PwLaunchOptions): Promise<PwBrowser> }
}

/**
 * The browser engine to drive. Default `chromium`; `DSH_TUI_BROWSER_ENGINE`
 * can select `firefox` or `webkit` for cross-engine coverage. Falls back to
 * chromium if the selected engine isn't installed.
 */
function browserEngine(): 'chromium' | 'firefox' | 'webkit' {
  const v = process.env.DSH_TUI_BROWSER_ENGINE
  if (v === 'firefox' || v === 'webkit') return v
  return 'chromium'
}

// Chromium running as root in a headless container needs these flags or the
// first start can stall on the sandbox/GPU path and intermittently time out.
const CONTAINER_LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']

/**
 * Whether to inject the container/root chromium flags. Only when running as
 * root (sandbox can't be used) or when the user explicitly opts in via
 * `DSH_TUI_BROWSER_NO_SANDBOX=1`. A normal non-root user keeps Chromium's
 * sandbox (process isolation) intact — we don't silently disable security.
 */
function chromiumNeedsContainerArgs(): boolean {
  if (process.env.DSH_TUI_BROWSER_NO_SANDBOX === '1') return true
  try { return typeof process.getuid === 'function' && process.getuid() === 0 } catch { return false }
}

/**
 * Launch args appropriate to the engine. Chromium-as-root in this container
 * needs `--no-sandbox`/`--disable-dev-shm-usage`/`--disable-gpu`; Firefox/WebKit
 * do not take chromium's GPU/sandbox flags, so pass an empty args array.
 */
function engineLaunchArgs(engine: 'chromium' | 'firefox' | 'webkit'): string[] {
  if (engine !== 'chromium') return []
  return chromiumNeedsContainerArgs() ? CONTAINER_LAUNCH_ARGS : []
}

/**
 * Optional HTTP proxy for the browser when the container must reach external
 * sites through a host proxy. Set `DSH_TUI_BROWSER_PROXY=http://host:port`.
 * Localhost / loopback are always bypassed so the proxy does not hijack local
 * pages, tests, or same-host services; `DSH_TUI_BROWSER_PROXY_BYPASS` overrides
 * the bypass list (comma-separated). Empty/absent means direct connect.
 */
function browserProxy(): { server: string; bypass?: string } | undefined {
  const v = process.env.DSH_TUI_BROWSER_PROXY
  if (!v || v.length === 0) return undefined
  const bypass = process.env.DSH_TUI_BROWSER_PROXY_BYPASS ??
    'localhost,127.0.0.1,::1,10.0.8.1'
  return { server: v, bypass }
}

/**
 * How to handle a browser dialog (alert/confirm/prompt/beforeunload). Dialogs
 * block the page and would otherwise hang an agent action; Playwright auto-dismisses
 * them, but we make the behavior explicit and configurable.
 */
function dialogMode(): 'accept' | 'dismiss' | 'ignore' {
  const v = process.env.DSH_TUI_BROWSER_DIALOG
  if (v === 'accept' || v === 'ignore') return v
  return 'dismiss'
}

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
 * A candidate browser binary must be a real native executable, not a distro
 * wrapper. On some distros `/usr/bin/chromium-browser` is a tiny snap stub
 * (a `#!/bin/sh` script) that fails when passed to `executablePath`, while a
 * genuine Chromium is a large ELF/Mach-O binary. Accept a file only when it is
 * either a large native binary or starts with a known executable magic.
 */
function isRealBrowserBinary(p: string): boolean {
  let fd: number | null = null
  try {
    // Read only the first few bytes to sniff the magic; never read a whole
    // multi-hundred-MB browser binary into memory.
    fd = openSync(p, 'r')
    const buf = Buffer.alloc(4)
    const n = readSync(fd, buf, 0, 4, 0)
    // Reject shell-script wrappers (snap stubs start with `#!`).
    if (n >= 2 && buf[0] === 0x23 && buf[1] === 0x21) return false
    // ELF magic (Linux). Mach-O magic (macOS): FEEDFACE / CFFAEDFE.
    // PE magic (Windows): "MZ" (4D 5A).
    if (n >= 4) {
      if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true
      if (
        (buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa && buf[3] === 0xce) ||
        (buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe)
      ) return true
      if (buf[0] === 0x4d && buf[1] === 0x5a) return true
    }
  } catch {
    return false
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* ignore */ } }
  }
  // Fallback: a browser binary is large; accept anything substantial even if
  // the magic was unfamiliar.
  try { return statSync(p).size > 20 * 1024 * 1024 } catch { return false }
}

// ── Structural config helpers ────────────────────────────────────────────

/** Compute `width×height` from a `maxDimension` config string. */
function dimensionPair(dim: string): { width: number; height: number } {
  const [w = 1280, h = 720] = dim.toLowerCase().split('x').map((s) => Number.parseInt(s.trim(), 10))
  return { width: Number.isFinite(w) ? w : 1280, height: Number.isFinite(h) ? h : 720 }
}

/** Numeric env override helper: returns the parsed value or the fallback. */
function envNum(name: string, fallback: number): number {
  const v = process.env[name]
  const n = v ? Number.parseFloat(v) : NaN
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** The long-lived browser session shared across tool calls. */
export class BrowserSession {
  private engine: PwBrowser | null = null
  private page: PwPage | null = null
  private ctx: PwContext | null = null
  private pw: PwModule | null = null
  private startError: string | null = null
  private lang: 'zh' | 'en'
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

  constructor(config: BrowserUseConfig, lang: 'zh' | 'en') {
    this.config = config
    this.lang = lang
    this.navTimeoutMs = envNum('DSH_TUI_BROWSER_TIMEOUT_NAVIGATION', 45_000)
    this.actionTimeoutMs = envNum('DSH_TUI_BROWSER_TIMEOUT_ACTION', 12_000)
    this.settleTimeoutMs = envNum('DSH_TUI_BROWSER_TIMEOUT_SETTLE', 6_000)
    this.dialog = dialogMode()
    this.userDataDir = process.env.DSH_TUI_BROWSER_USER_DATA_DIR || undefined
    this.storageStatePath = process.env.DSH_TUI_BROWSER_STORAGE_STATE || undefined
  }

  /**
   * Serialize a task onto the session queue: each caller waits for the previous
   * task to settle. The internal chain never rejects, so a failed task does not
   * wedge the queue; the task's own rejection is still surfaced to its caller.
   * Exposed publicly so the tool registry can funnel every tool call through the
   * same single-browser-page lock (P1 #9): concurrent tool calls become a strict
   * serial queue instead of interleaving Playwright operations.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(() => task())
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  /** Load the playwright module safely; returns null if it isn't installed. */
  private async loadPlaywright(): Promise<PwModule | null> {
    if (this.pw !== null) return this.pw
    try {
      const mod = (await import('playwright')) as unknown as PwModule
      this.pw = mod
      return mod
    } catch {
      this.pw = null
      return null
    }
  }

  /**
   * Resolve an explicit browser binary, honoring `DSH_TUI_BROWSER_EXECUTABLE`
   * then common install locations. Returns undefined to let Playwright pick its
   * bundled Chromium. Useful in constrained containers where neither system
   * Chrome nor a Playwright-downloaded Chromium is present but a Chromium
   * binary exists (e.g. installed via a tarball or a distro with a snap stub).
   */
  private resolveExecutablePath(): string | undefined {
    const env = process.env.DSH_TUI_BROWSER_EXECUTABLE
    if (env) return env
    // Platform-aware candidates: system Chromium/Chrome on Linux/macOS/Windows.
    const candidates = [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]
    // Scan /opt for a bundled Chromium (constrained containers commonly drop a
    // tarball under /opt/chromium-*/chrome-linux/chrome). Avoid hard-coding a
    // specific build number — glob the dir name instead.
    try {
      for (const entry of readdirSync('/opt')) {
        const nested = join('/opt', entry, 'chrome-linux', 'chrome')
        if (existsSync(nested) && isRealBrowserBinary(nested)) return nested
      }
    } catch { /* no /opt */ }
    for (const p of candidates) {
      if (existsSync(p) && isRealBrowserBinary(p)) return p
    }
    return undefined
  }

  /**
   * Ensure a browser and page exist, probing sources in order:
   * system Chrome (`channel:'chrome'`) → explicit binary (`executablePath`) →
   * Playwright-bundled Chromium. `DSH_TUI_BROWSER_ENGINE` selects `firefox`/
   * `webkit` for cross-engine coverage; the chromium path stays the default.
   */
  async ensureStarted(): Promise<boolean> {
    if (this.engine !== null && this.page !== null) return true
    const pw = await this.loadPlaywright()
    if (!pw) {
      this.startError = t('error.browser-missing', this.lang)
      return false
    }
    try {
      const proxy = browserProxy()
      const engine = browserEngine()
      // Non-chromium engines (firefox/webkit): use the bundled binary, no
      // channel/executable probe (they don't ship per-engine system channels).
      if (engine !== 'chromium') {
        const inject = pw[engine]
        if (!inject) {
          this.startError = t('error.browser-missing', this.lang) + ` (engine '${engine}' not installed)`
          this.engine = null
          this.page = null
          return false
        }
        this.engine = await inject.launch({ headless: true, args: engineLaunchArgs(engine), ...(proxy ? { proxy } : {}) })
      } else {
        // Probe system Chrome first (fewest install friction on most dev boxes).
        const chromiumArgs = engineLaunchArgs('chromium')
        try {
          this.engine = await pw.chromium.launch({ channel: 'chrome', headless: true, args: chromiumArgs, ...(proxy ? { proxy } : {}), ...(this.userDataDir ? { userDataDir: this.userDataDir } : {}) })
        } catch {
          const executablePath = this.resolveExecutablePath()
          if (executablePath) {
            // Fall back to an explicit binary (container / unusual install); if
            // it still fails (e.g. an imperfect binary), fall through to the
            // Playwright-bundled Chromium rather than surfacing the error.
            try {
              this.engine = await pw.chromium.launch({ executablePath, headless: true, args: chromiumArgs, ...(proxy ? { proxy } : {}), ...(this.userDataDir ? { userDataDir: this.userDataDir } : {}) })
            } catch {
              this.engine = await pw.chromium.launch({ headless: true, args: chromiumArgs, ...(proxy ? { proxy } : {}), ...(this.userDataDir ? { userDataDir: this.userDataDir } : {}) })
            }
          } else {
            // Final fall back to the Playwright-bundled Chromium.
            this.engine = await pw.chromium.launch({ headless: true, args: chromiumArgs, ...(proxy ? { proxy } : {}), ...(this.userDataDir ? { userDataDir: this.userDataDir } : {}) })
          }
        }
      }
      const dim = dimensionPair(this.config.screenshot.maxDimension)
      // Session-state persistence (P1 #8): an explicit context is used when a
      // storageState snapshot is configured (preloaded if it already exists) so
      // a login state can be saved back on close. Every path keeps a context
      // reference so cookies()/clearCookies() always have a target.
      const ctx = await this.engine.newContext({
        storageState: this.storageStatePath && existsSync(this.storageStatePath) ? this.storageStatePath : undefined,
      })
      this.ctx = ctx
      this.page = await ctx.newPage()
      await this.page.setViewportSize({ width: dim.width, height: dim.height })
      // Dialog handling: by default dismiss alert/confirm/prompt so a blocking
      // dialog cannot hang an agent action. `DSH_TUI_BROWSER_DIALOG=accept` or
      // `ignore` opts in/out of dismissing.
      if (this.dialog !== 'ignore') {
        this.page.on('dialog', (d) => {
          void (this.dialog === 'accept' ? d.accept() : d.dismiss()).catch(() => undefined)
        })
      }
      // Capture console + network for the browser_console_messages / browser_network_requests
      // tools. Both are best-effort ring buffers; a debug-friendly page can be inspected
      // without a devtools/DRP trace.
      this.page.on('console', (m) => {
        this.consoleLog.push(`[${m.type()}] ${m.text()}`)
        if (this.consoleLog.length > BrowserSession.CAPTURE_CAP) this.consoleLog.shift()
      })
      this.page.on('response', (r) => {
        this.networkLog.push(`${r.status()} ${r.url()}`)
        if (this.networkLog.length > BrowserSession.CAPTURE_CAP) this.networkLog.shift()
      })
      this.startError = null
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.startError = t('error.browser-missing', this.lang) + ` (${msg})`
      this.engine = null
      this.page = null
      return false
    }
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
    if (this.engine) {
      // Persist a login snapshot back to the configured path (best-effort).
      if (this.storageStatePath && this.ctx) {
        try { await this.ctx.storageState({ path: this.storageStatePath }) } catch { /* best-effort */ }
      }
      try { await this.engine.close() } catch { /* ignore */ }
      this.engine = null
      this.page = null
      this.ctx = null
    }
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
        url: resp?.url() ?? params.url,
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
      return { success: true, newUrl: page.url() || before }
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
    return { title: await page.title(), url: resp?.url() ?? fallbackUrl, status: resp?.status() ?? null }
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
      return { cookies }
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
   * Capture the page as one or more viewport screenshots, splitting tall pages
   * into readable segments via scroll-capture tiling.
   *
   * When `tiling.mode` is `off`, or the page fits within the viewport/threshold
   * under `auto`, it returns a single screenshot (identical to
   * {@link captureScreenshot}). Otherwise it scrolls the page in viewport-sized
   * steps and captures each segment, honoring the configured overlap. Each
   * segment is a native-resolution viewport capture, so a very tall page never
   * produces one oversized image that a vision model cannot read.
   */
  async captureSegments(): Promise<Buffer[]> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this.startError ?? 'browser unavailable')
    const page = this.requirePage()
    const type = this.config.screenshot.format === 'png' ? 'png' : 'jpeg'
    const quality = type === 'jpeg' ? this.config.screenshot.quality : undefined
    const dim = dimensionPair(this.config.screenshot.maxDimension)
    const overlap = Math.max(0, this.config.tiling.overlap || 0)

    // No tiling requested → single viewport capture.
    if (this.config.tiling.mode === 'off') {
      return [await page.screenshot({ type, quality })]
    }

    // Determine the scrollable height and the "needs tiling" threshold.
    const pageHeight = await page.evaluate<number>(
      'Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)',
    ).catch(() => 0)
    const dimH = this.config.tiling.threshold.split('x').map((s) => Number.parseInt(s.trim(), 10))
    const thresholdH = Number.isFinite(dimH[1] as number) ? (dimH[1] as number) : dim.height

    // `auto`: single capture when the page already fits the viewport/threshold.
    if (this.config.tiling.mode === 'auto' && pageHeight > 0 && pageHeight <= Math.max(thresholdH, dim.height)) {
      return [await page.screenshot({ type, quality })]
    }
    // Unknown height (e.g. detached document): fall back to a single capture.
    if (pageHeight <= 0) {
      return [await page.screenshot({ type, quality })]
    }

    // Scroll-capture tiling: step by (viewport height - overlap).
    const step = Math.max(1, dim.height - overlap)
    const buffers: Buffer[] = []
    const maxTiles = envNum('DSH_TUI_BROWSER_MAX_TILES', 12)
    for (let y = 0; y < pageHeight && buffers.length < maxTiles; y += step) {
      await page.evaluate(`window.scrollTo(0, ${y})`).catch(() => undefined)
      // Wait two animation frames so the segment is painted before capture.
      await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => undefined)
      buffers.push(await page.screenshot({ type, quality }))
    }
    // Restore the scroll position for the next tool call.
    await page.evaluate('window.scrollTo(0, 0)').catch(() => undefined)
    if (buffers.length === 0) buffers.push(await page.screenshot({ type, quality }))
    return buffers
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
      return { url: page.url(), path: outPath, bytes: buf.length }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
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
          const all = document.querySelectorAll(selector);
          for (const el of all) {
            if (nodes.length >= MAX) break;
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
          return nodes;
        })()`,
      )) ?? []
      return { nodes: nodes as SnapshotNode[] }
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
    if (available && this.engine) {
      try { version = this.engine.version() } catch { /* keep unknown */ }
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
