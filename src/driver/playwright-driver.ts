/**
 * dsh-tui-browser-use — default Playwright browser driver.
 *
 * Implements {@link BrowserDriver} over Playwright. Owns the launch probe
 * (system Chrome → explicit binary → bundled Chromium), the per-engine launch
 * args, the navigation primitives (domcontentloaded + best-effort load wait),
 * the frame-aware locator helpers, and the context operations. It is the part
 * of the plugin that would change if the browser backend were swapped.
 *
 * All state that is NOT driver-specific (serial mutex, timeout envelope,
 * dialog/console/network ring buffers, snapshot/tiling/status/saveScreenshots)
 * stays in `BrowserSession`. The B8 "pre-dispatch abort" is honoured here: a
 * navigation/action whose `AbortSignal` is already aborted returns immediately
 * instead of issuing a doomed call.
 */

import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeEnv } from '../runtime-env.js'
import { effectiveViewport } from '../capabilities.js'
import {
  type BrowserDriver,
  type DriverStartOptions,
  type PwApiResponse,
  type PwBrowser,
  type PwContext,
  type PwFrame,
  type PwLocator,
  type PwModule,
  type PwNavigation,
  type PwPage,
  type PwBrowserEngine,
  type PwCookie,
} from './browser-driver.js'

/** Chromium-as-root container flags (sandbox/GPU path can stall first start). */
const CONTAINER_LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']

/** The default proxy bypass list (localhost/loopback never proxied). */
const DEFAULT_PROXY_BYPASS = 'localhost,127.0.0.1,::1,10.0.8.1'

/** Whether to inject the container/root chromium flags. */
function chromiumNeedsContainerArgs(noSandbox: boolean): boolean {
  if (noSandbox) return true
  try { return typeof process.getuid === 'function' && process.getuid() === 0 } catch { return false }
}

/** Launch args appropriate to the engine. */
function engineLaunchArgs(engine: PwBrowserEngine, noSandbox: boolean): string[] {
  if (engine !== 'chromium') return []
  return chromiumNeedsContainerArgs(noSandbox) ? CONTAINER_LAUNCH_ARGS : []
}

/** Resolve the HTTP proxy (config `proxy` wins, then env, then direct). */
function resolveProxy(cfgProxy: string | undefined, env: RuntimeEnv): { server: string; bypass?: string } | undefined {
  const v = cfgProxy && cfgProxy.length > 0 ? cfgProxy : env.proxyServer
  if (!v || v.length === 0) return undefined
  return { server: v, bypass: env.proxyBypass ?? DEFAULT_PROXY_BYPASS }
}

/** A candidate browser binary must be a real native executable, not a stub. */
function isRealBrowserBinary(p: string): boolean {
  try {
    const st = statSync(p)
    if (!st.isFile() || st.size < 1_000_000) return false
    const fd = openSync(p, 'r')
    const buf = Buffer.alloc(8)
    const n = readSync(fd, buf, 0, 8, 0)
    closeSync(fd)
    const magic = buf.subarray(0, n).toString('hex')
    return magic.startsWith('7f454c46') || magic.startsWith('cffaedfe') || magic.startsWith('4d5a')
  } catch {
    return false
  }
}

/** Throw if the signal is already aborted (pre-dispatch short-circuit, B8). */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
}

export class PlaywrightDriver implements BrowserDriver {
  private _pw: PwModule | null = null
  private _engine: PwBrowser | null = null
  private _page: PwPage | null = null
  private _ctx: PwContext | null = null
  private _startError: string | null = null
  private _lang: 'zh' | 'en' = 'zh'

  get startError(): string | null { return this._startError }
  get running(): boolean { return this._engine !== null && this._page !== null }
  get page(): PwPage | null { return this._page }
  get context(): PwContext | null { return this._ctx }

  private async loadPlaywright(): Promise<PwModule | null> {
    if (this._pw !== null) return this._pw
    try {
      this._pw = (await import('playwright')) as unknown as PwModule
      return this._pw
    } catch {
      this._pw = null
      return null
    }
  }

  private resolveExecutablePath(env: RuntimeEnv): string | undefined {
    if (env.executablePath) return env.executablePath
    const candidates = [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]
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

  async start(opts: DriverStartOptions): Promise<boolean> {
    if (this._engine !== null && this._page !== null) return true
    this._lang = opts.lang
    const pw = await this.loadPlaywright()
    if (!pw) {
      this._startError = 'browser-core-missing'
      return false
    }
    try {
      const proxy = resolveProxy(opts.config.proxy, opts.env)
      const engine: PwBrowserEngine = opts.env.engine
      const handlers = opts.handlers
      if (engine !== 'chromium') {
        const inject = pw[engine]
        if (!inject) {
          this._startError = `browser-engine-missing:${engine}`
          return false
        }
        this._engine = await inject.launch({ headless: true, args: engineLaunchArgs(engine, opts.env.noSandbox), ...(proxy ? { proxy } : {}) })
      } else {
        const args = engineLaunchArgs('chromium', opts.env.noSandbox)
        try {
          this._engine = await pw.chromium.launch({ channel: 'chrome', headless: true, args, ...(proxy ? { proxy } : {}), ...(opts.env.userDataDir ? { userDataDir: opts.env.userDataDir } : {}) })
        } catch {
          const executablePath = this.resolveExecutablePath(opts.env)
          if (executablePath) {
            try {
              this._engine = await pw.chromium.launch({ executablePath, headless: true, args, ...(proxy ? { proxy } : {}), ...(opts.env.userDataDir ? { userDataDir: opts.env.userDataDir } : {}) })
            } catch {
              this._engine = await pw.chromium.launch({ headless: true, args, ...(proxy ? { proxy } : {}), ...(opts.env.userDataDir ? { userDataDir: opts.env.userDataDir } : {}) })
            }
          } else {
            this._engine = await pw.chromium.launch({ headless: true, args, ...(proxy ? { proxy } : {}), ...(opts.env.userDataDir ? { userDataDir: opts.env.userDataDir } : {}) })
          }
        }
      }
      const ctx = await this._engine.newContext({
        storageState: opts.env.storageStatePath && existsSync(opts.env.storageStatePath) ? opts.env.storageStatePath : undefined,
      })
      this._ctx = ctx
      const page = await ctx.newPage()
      this._page = page
      const dim = effectiveViewport(opts.config)
      await page.setViewportSize({ width: dim.width, height: dim.height })
      if (opts.env.dialog !== 'ignore') {
        page.on('dialog', (d) => {
          void (opts.env.dialog === 'accept' ? d.accept() : d.dismiss()).catch(() => undefined)
        })
      }
      if (handlers) {
        page.on('console', (m) => handlers.onConsole?.(m))
        page.on('request', (r) => handlers.onRequest?.(r))
        page.on('response', (r) => handlers.onResponse?.(r))
        page.on('requestfailed', (r) => handlers.onRequestFailed?.(r))
      }
      this._startError = null
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this._startError = `browser-launch-failed:${msg}`
      this._engine = null
      this._page = null
      return false
    }
  }

  async close(): Promise<void> {
    try { await this._ctx?.close() } catch { /* ignore */ }
    try { await this._engine?.close() } catch { /* ignore */ }
    this._engine = null
    this._page = null
    this._ctx = null
  }

  version(): string {
    try { return this._engine?.version() ?? 'unknown' } catch { return 'unknown' }
  }

  private requirePage(): PwPage {
    if (!this._page) throw new Error('browser not started')
    return this._page
  }

  private requireContext(): PwContext {
    if (!this._ctx) throw new Error('browser context not started')
    return this._ctx
  }

  // ── Navigation ─────────────────────────────────────────────────────────

  async navigate(url: string, timeoutMs: number, signal?: AbortSignal): Promise<PwNavigation> {
    throwIfAborted(signal)
    const page = this.requirePage()
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForLoadState('load').catch(() => undefined)
    return resp
  }

  async goBack(timeoutMs: number, signal?: AbortSignal): Promise<PwNavigation> {
    throwIfAborted(signal)
    const page = this.requirePage()
    return page.goBack({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => null)
  }

  async goForward(timeoutMs: number, signal?: AbortSignal): Promise<PwNavigation> {
    throwIfAborted(signal)
    const page = this.requirePage()
    return page.goForward({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => null)
  }

  async reload(timeoutMs: number, signal?: AbortSignal): Promise<PwNavigation> {
    throwIfAborted(signal)
    const page = this.requirePage()
    return page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => null)
  }

  // ── Page primitives ────────────────────────────────────────────────────

  async waitLoad(): Promise<void> {
    await this.requirePage().waitForLoadState('load').catch(() => undefined)
  }

  async settleRaf(): Promise<void> {
    await this.requirePage().evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => undefined)
  }

  /**
   * Mutation-aware settle (B8): a fast path (double-rAF) resolves immediately
   * on a quiet page; only a page that keeps mutating extends toward a quiet
   * window and then the hard `timeoutMs` cap. This replaces a bare double-rAF
   * for pages that render asynchronously after an action, so a snapshot is not
   * taken mid-update, while never blocking longer than `timeoutMs`.
   */
  async settleStable(timeoutMs: number): Promise<void> {
    const cap = Math.max(60, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 6000)
    await this.requirePage().evaluate(
      `new Promise((resolve) => {
        const deadline = Date.now() + ${cap};
        const quietMs = Math.min(Math.max(Math.floor(${cap} / 5), 50), 250);
        const done = () => {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          if (mo) mo.disconnect();
          if (rs) document.removeEventListener('readystatechange', rs);
          resolve();
        };
        let finished = false;
        let timer = null;
        let mo = null;
        let rs = null;
        let mutationAt = Date.now();
        mo = new MutationObserver(() => { mutationAt = Date.now(); });
        mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        const check = () => {
          if (finished) return;
          const now = Date.now();
          if (document.readyState === 'complete' && now - mutationAt >= quietMs) return done();
          if (now >= deadline) return done();
          timer = setTimeout(check, Math.min(50, Math.max(16, deadline - now)));
        };
        rs = () => check();
        document.addEventListener('readystatechange', rs);
        // Fast path: a double-rAF flush. A quiet page (no recent mutation) resolves
        // right away; a page still mutating defers to the quiet window / hard cap.
        requestAnimationFrame(() => requestAnimationFrame(() => check()));
        // Hard-cap safety even if rAF never fires (background tab / paused page).
        timer = setTimeout(check, Math.min(60, Math.max(16, deadline - Date.now())));
      })`,
    ).catch(() => undefined)
  }

  async title(): Promise<string> {
    return this.requirePage().title()
  }

  url(): string {
    return this.requirePage().url()
  }

  async eval<T = unknown>(expr: string): Promise<T> {
    return this.requirePage().evaluate<T>(expr)
  }

  async scrollTo(x: number, y: number): Promise<void> {
    await this.requirePage().evaluate(`window.scrollTo(${x}, ${y})`).catch(() => undefined)
  }

  async scrollBy(x: number, y: number): Promise<void> {
    await this.requirePage().evaluate(`window.scrollBy(${x}, ${y})`).catch(() => undefined)
  }

  async scrollPos(): Promise<{ x: number; y: number }> {
    return this.requirePage().evaluate<{ x: number; y: number }>('({ x: window.scrollX, y: window.scrollY })').catch(() => ({ x: 0, y: 0 }))
  }

  async keyboardPress(key: string): Promise<void> {
    await this.requirePage().keyboard.press(key)
  }

  async screenshot(opts: { type: string; quality?: number }): Promise<Buffer> {
    return this.requirePage().screenshot({ type: opts.type, quality: opts.quality })
  }

  async pdf(opts: { format: string; printBackground: boolean }): Promise<Buffer> {
    return this.requirePage().pdf({ format: opts.format, printBackground: opts.printBackground })
  }

  // ── Locator helpers ────────────────────────────────────────────────────

  private resolveLocator(target: PwPage | PwFrame, selector?: string, text?: string): PwLocator {
    if (text !== undefined && text.length > 0) return target.getByText(text)
    if (selector && /^role=/.test(selector)) {
      const m = /^role=([a-z]+)(?:\[name=(.+)\])?/i.exec(selector)
      if (m?.[1]) return target.getByRole(m[1], m[2] !== undefined ? { name: m[2] } : undefined)
    }
    if (selector && /^label=/.test(selector)) return target.getByLabel(selector.slice('label='.length))
    return target.locator(selector ?? '')
  }

  async resolveFrameAware(selector?: string, text?: string): Promise<PwLocator> {
    const page = this.requirePage()
    const main = this.resolveLocator(page, selector, text)
    if (selector === undefined && text === undefined) return main
    try {
      const mainCount = await main.count()
      if (mainCount > 0) return main
    } catch { /* ignore and fall through */ }
    for (const frame of page.frames()) {
      const loc = this.resolveLocator(frame, selector, text)
      try {
        const n = await loc.count()
        if (n > 0) return loc
      } catch { /* try next frame */ }
    }
    return main
  }

  async waitForLocator(locator: PwLocator, timeoutMs: number): Promise<void> {
    const perTry = Math.max(800, Math.min(3000, Math.round(timeoutMs / 3)))
    for (let i = 0; i < 3; i += 1) {
      try {
        await locator.first().waitFor({ state: 'visible', timeout: perTry })
        return
      } catch { /* re-query next attempt */ }
    }
    await locator.first().waitFor({ state: 'visible', timeout: perTry })
  }

  async clickLocator(locator: PwLocator): Promise<void> {
    await locator.first().click()
  }

  async hoverLocator(locator: PwLocator): Promise<void> {
    await locator.first().hover()
  }

  async fillLocator(locator: PwLocator, text: string): Promise<void> {
    await locator.first().fill(text)
  }

  async clearLocator(locator: PwLocator): Promise<void> {
    await locator.first().clear()
  }

  // ── Context operations ─────────────────────────────────────────────────

  async cookies(): Promise<PwCookie[]> {
    return this.requireContext().cookies()
  }

  async clearCookies(): Promise<void> {
    await this.requireContext().clearCookies()
  }

  async addCookies(cookies: Array<{ name: string; value: string; url?: string; domain?: string; path?: string }>): Promise<void> {
    await this.requireContext().addCookies(cookies)
  }

  async requestGet(url: string, timeoutMs: number): Promise<PwApiResponse> {
    return this.requireContext().request.get(url, { timeout: timeoutMs })
  }
}

/** Construct the default Playwright-backed browser driver. */
export function createPlaywrightDriver(): BrowserDriver {
  return new PlaywrightDriver()
}
