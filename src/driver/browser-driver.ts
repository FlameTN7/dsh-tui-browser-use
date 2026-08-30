/**
 * dsh-tui-browser-use — browser driver contract.
 *
 * AGENTS.md §2 / 竞品 B2: the Playwright-specific behaviour is isolated behind
 * a `BrowserDriver` interface so the harness/plugin can swap the backend (e.g.
 * a stub driver in tests, or a future headless-shell driver) without touching
 * the tool registries. `BrowserSession` keeps the orchestration that is NOT
 * driver-specific — the serial mutex (`run`), timeout envelope, dialog policy,
 * console/network ring buffers, snapshot/tiling/status/saveScreenshots — and
 * delegates the low-level browser primitives to a `BrowserDriver`.
 *
 * All Playwright handles are structural-typed here so the plugin compiles
 * without pulling in the playwright type package at build time (AGENTS.md §2).
 * The default implementation is `PlaywrightDriver` (playwright-driver.ts).
 */

// ── Structural Playwright types (no hard dependency) ─────────────────────

export interface PwElementHandle {
  click(): Promise<void>
  fill(text: string): Promise<void>
  type(text: string): Promise<void>
  innerText(): Promise<string>
  isVisible(): Promise<boolean>
}

/** A Playwright locator handle (structural, minimal for click/fill/wait). */
export interface PwLocator {
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
export interface PwConsoleMessage {
  type(): string
  text(): string
}

/** A browser network request (structural). */
export interface PwRequest {
  url(): string
  method(): string
}

/** A browser network response (structural). */
export interface PwResponse {
  url(): string
  status(): number
}

/** A browser cookie (structural). */
export interface PwCookie {
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
export interface PwKeyboard {
  press(key: string): Promise<void>
}

/** A browser dialog (alert/confirm/prompt/beforeunload). */
export interface PwDialog {
  accept(): Promise<void>
  dismiss(): Promise<void>
  type(): string
  message(): string
}

export interface PwPage {
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
export interface PwFrame {
  locator(selector: string): PwLocator
  getByText(text: string): PwLocator
  getByRole(role: string, opts?: { name?: string }): PwLocator
  getByLabel(text: string): PwLocator
  url(): string
}

/** A browser context (cookie/localStorage isolation; storageState persistence). */
export interface PwContext {
  newPage(): Promise<PwPage>
  storageState(opts?: { path?: string }): Promise<Record<string, unknown>>
  close(): Promise<void>
  cookies(urls?: string[]): Promise<PwCookie[]>
  addCookies(cookies: Array<{ name: string; value: string; url?: string; domain?: string; path?: string }>): Promise<void>
  clearCookies(): Promise<void>
  /** API request handle, used by `browser_download` to carry session cookies/auth. */
  request: PwApiRequestContext
  /** The owning browser (available on persistent contexts from `launchPersistentContext`). */
  browser(): PwBrowser
}

export interface PwApiResponse {
  ok(): boolean
  status(): number
  url(): string
  body(): Promise<Buffer>
  headers(): Record<string, string>
}

export interface PwApiRequestContext {
  get(url: string, opts?: { timeout?: number }): Promise<PwApiResponse>
}

export interface PwBrowser {
  close(): Promise<void>
  newPage(): Promise<PwPage>
  newContext(opts?: { storageState?: string }): Promise<PwContext>
  version(): string
  context(): { newPage(): Promise<PwPage> }
}

export interface PwChromium {
  launch(opts: { channel?: string; executablePath?: string; headless?: boolean; args?: string[]; proxy?: { server: string; bypass?: string } }): Promise<PwBrowser>
  launchPersistentContext(userDataDir: string, opts: { channel?: string; executablePath?: string; headless?: boolean; args?: string[]; proxy?: { server: string; bypass?: string }; storageState?: string }): Promise<PwContext>
}

/** Common launch options shared by every Playwright browser engine. */
export type PwLaunchOptions = { channel?: string; executablePath?: string; headless?: boolean; args?: string[]; proxy?: { server: string; bypass?: string }; userDataDir?: string }

export interface PwModule {
  chromium: PwChromium
  firefox?: { launch(opts: PwLaunchOptions): Promise<PwBrowser>; launchPersistentContext(userDataDir: string, opts: PwLaunchOptions & { storageState?: string }): Promise<PwContext> }
  webkit?: { launch(opts: PwLaunchOptions): Promise<PwBrowser>; launchPersistentContext(userDataDir: string, opts: PwLaunchOptions & { storageState?: string }): Promise<PwContext> }
}

export type PwBrowserEngine = 'chromium' | 'firefox' | 'webkit'

// ── The driver contract ──────────────────────────────────────────────────

/** A navigation response (Playwright's `Response`-like shape, nullable on some engines). */
export type PwNavigation = { status(): number | null; url(): string } | null

/** Callbacks a driver fires during `start` so the session keeps its own state. */
export interface DriverHandlers {
  onDialog?(dialog: PwDialog): void
  onConsole?(message: PwConsoleMessage): void
  onRequest?(request: PwRequest): void
  onResponse?(response: PwResponse): void
  onRequestFailed?(request: PwRequest): void
}

/** Options for `BrowserDriver.start`. */
export interface DriverStartOptions {
  /** The effective plugin config (viewport, screenshot format, tiling, proxy, ...). */
  config: import('../types.js').BrowserUseConfig
  /** The runtime environment (engine, executable, proxy, dialog, ...). */
  env: import('../runtime-env.js').RuntimeEnv
  /** UI language for errors. */
  lang: 'zh' | 'en'
  /** Dialog/console/network event callbacks (session-owned state). */
  handlers?: DriverHandlers
}

/**
 * The low-level browser backend. A driver owns the browser lifecycle and
 * exposes the primitives `BrowserSession` orchestrates. Drivers must be
 * launch-lazy: `start` may be called repeatedly and must surface a missing
 * browser as `false` (with a human-readable reason) rather than throwing.
 */
export interface BrowserDriver {
  /** Launch the browser + page, applying proxy/engine/userDataDir/storageState. */
  start(opts: DriverStartOptions): Promise<boolean>
  /** The reason `start` returned false (e.g. "browser not installed"). */
  readonly startError: string | null
  /** Whether the browser is currently running. */
  readonly running: boolean
  close(): Promise<void>
  /** Browser version string for diagnostics. */
  version(): string

  /** The live page (may be null before `start` succeeds). */
  readonly page: PwPage | null
  /** The live context (cookie/request handle). */
  readonly context: PwContext | null

  // ── Navigation ─────────────────────────────────────────────────────────
  // Every navigation method accepts an optional AbortSignal so a wall-clock
  // timeout can short-circuit a pre-dispatch (B8): the signal is checked
  // BEFORE the operation is issued. The Playwright implementation uses
  // `domcontentloaded` + best-effort `load` wait; a fast navigation is
  // naturally covered by the goto call itself.
  navigate(url: string, timeoutMs: number, signal?: AbortSignal): Promise<PwNavigation>
  goBack(timeoutMs: number, signal?: AbortSignal): Promise<PwNavigation>
  goForward(timeoutMs: number, signal?: AbortSignal): Promise<PwNavigation>
  reload(timeoutMs: number, signal?: AbortSignal): Promise<PwNavigation>

  // ── Page primitives ────────────────────────────────────────────────────
  waitLoad(): Promise<void>
  /** Double-rAF settle so a freshly-painted page is captured. */
  settleRaf(): Promise<void>
  /**
   * Mutation-aware settle (B8): resolves when the document is ready AND no
   * DOM mutations have occurred for a short quiet window, bounded by a hard
   * `timeoutMs` cap. More robust than a bare double-rAF for pages that render
   * asynchronously after an action, yet never runs longer than `timeoutMs`.
   */
  settleStable(timeoutMs: number): Promise<void>
  title(): Promise<string>
  url(): string
  eval<T = unknown>(expr: string): Promise<T>
  scrollTo(x: number, y: number): Promise<void>
  scrollBy(x: number, y: number): Promise<void>
  scrollPos(): Promise<{ x: number; y: number }>
  keyboardPress(key: string): Promise<void>
  screenshot(opts: { type: string; quality?: number }): Promise<Buffer>
  /** PDF bytes for the current page. */
  pdf(opts: { format: string; printBackground: boolean }): Promise<Buffer>

  // ── Locator helpers (frame-aware + wait-to-actionable) ─────────────────
  resolveFrameAware(selector?: string, text?: string): Promise<PwLocator>
  waitForLocator(locator: PwLocator, timeoutMs: number): Promise<void>
  clickLocator(locator: PwLocator): Promise<void>
  hoverLocator(locator: PwLocator): Promise<void>
  fillLocator(locator: PwLocator, text: string): Promise<void>
  clearLocator(locator: PwLocator): Promise<void>

  // ── Context operations ─────────────────────────────────────────────────
  cookies(): Promise<PwCookie[]>
  clearCookies(): Promise<void>
  addCookies(cookies: Array<{ name: string; value: string; url?: string; domain?: string; path?: string }>): Promise<void>
  requestGet(url: string, timeoutMs: number): Promise<PwApiResponse>
}
