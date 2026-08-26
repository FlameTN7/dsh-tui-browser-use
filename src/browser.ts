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

import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import type { ErrorCode, NavigateParams, NavigateResult, ClickParams, ClickResult, TypeParams, TypeResult, EvaluateParams, EvaluateResult, ScreenshotParams, ScreenshotResult, StatusResult, I18nTemplate, BrowserUseConfig } from './types.js'
import { t } from './i18n.js'

// ── Structural Playwright types (no hard dependency) ─────────────────────

interface PwElementHandle {
  click(): Promise<void>
  fill(text: string): Promise<void>
  type(text: string): Promise<void>
  innerText(): Promise<string>
  isVisible(): Promise<boolean>
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
  locator(selector: string): { getByText?(text: string): { first(): Promise<PwElementHandle> }; textContent?: (text: string) => unknown }
  waitForLoadState(state?: string): Promise<void>
  setViewportSize(size: { width: number; height: number }): Promise<void>
}

interface PwBrowser {
  close(): Promise<void>
  newPage(): Promise<PwPage>
  version(): string
  context(): { newPage(): Promise<PwPage> }
}

interface PwChromium {
  launch(opts: { channel?: string; executablePath?: string; headless?: boolean; args?: string[]; proxy?: { server: string } }): Promise<PwBrowser>
}

interface PwModule {
  chromium: PwChromium
}

// Chromium runs as root in this container; headless launch needs these flags or
// the first start can stall on the sandbox/GPU path and intermittently time out.
const CONTAINER_LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']

/**
 * Optional HTTP proxy for the browser when the container must reach external
 * sites through a host proxy. Set `DSH_TUI_BROWSER_PROXY=http://host:port`.
 * Empty/absent means direct connect.
 */
function browserProxy(): { server: string } | undefined {
  const v = process.env.DSH_TUI_BROWSER_PROXY
  return v && v.length > 0 ? { server: v } : undefined
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
    if (n >= 4) {
      if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true
      if (
        (buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa && buf[3] === 0xce) ||
        (buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe)
      ) return true
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

/** The long-lived browser session shared across tool calls. */
export class BrowserSession {
  private engine: PwBrowser | null = null
  private page: PwPage | null = null
  private pw: PwModule | null = null
  private startError: string | null = null
  private lang: 'zh' | 'en'
  // We don't hard-require a config at construction; the plugin injects it.
  config: BrowserUseConfig

  constructor(config: BrowserUseConfig, lang: 'zh' | 'en') {
    this.config = config
    this.lang = lang
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
    const candidates = [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/opt/chromium-1148/chrome-linux/chrome',
      '/opt/chromium/chrome-linux/chrome',
    ]
    for (const p of candidates) {
      if (existsSync(p) && isRealBrowserBinary(p)) return p
    }
    return undefined
  }

  /**
   * Ensure a browser and page exist, probing sources in order:
   * system Chrome (`channel:'chrome'`) → explicit binary (`executablePath`) →
   * Playwright-bundled Chromium.
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
      // Probe system Chrome first (fewest install friction on most dev boxes).
      try {
        this.engine = await pw.chromium.launch({ channel: 'chrome', headless: true, args: CONTAINER_LAUNCH_ARGS, ...(proxy ? { proxy } : {}) })
      } catch {
        const executablePath = this.resolveExecutablePath()
        if (executablePath) {
          // Fall back to an explicit binary (container / unusual install); if
          // it still fails (e.g. an imperfect binary), fall through to the
          // Playwright-bundled Chromium rather than surfacing the error.
          try {
            this.engine = await pw.chromium.launch({ executablePath, headless: true, args: CONTAINER_LAUNCH_ARGS, ...(proxy ? { proxy } : {}) })
          } catch {
            this.engine = await pw.chromium.launch({ headless: true, args: CONTAINER_LAUNCH_ARGS, ...(proxy ? { proxy } : {}) })
          }
        } else {
          // Final fall back to the Playwright-bundled Chromium.
          this.engine = await pw.chromium.launch({ headless: true, args: CONTAINER_LAUNCH_ARGS, ...(proxy ? { proxy } : {}) })
        }
      }
      const dim = dimensionPair(this.config.screenshot.maxDimension)
      this.page = await this.engine.newPage()
      await this.page.setViewportSize({ width: dim.width, height: dim.height })
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

  /** Release the browser and mark the session unstarted. */
  async close(): Promise<void> {
    if (this.engine) {
      try { await this.engine.close() } catch { /* ignore */ }
      this.engine = null
      this.page = null
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
      const resp = await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
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
      if (params.selector) {
        await page.click(params.selector)
      } else if (params.text) {
        await page.click(`text=${params.text}`)
      } else {
        throw new BrowserToolError('browser-error', t('error.argument', this.lang, { message: 'selector or text required' }))
      }
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
      await page.fill(params.selector, params.text)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.lang, { message: msg }))
    }
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
    const maxTiles = 12
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
