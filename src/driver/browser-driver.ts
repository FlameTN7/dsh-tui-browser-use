/**
 * dsh-tui-browser-use — browser driver contract.
 *
 * AGENTS.md §2 / 竞品 B2: the Playwright-specific behaviour is isolated behind
 * a `BrowserDriver` interface so the harness/plugin can swap the backend (e.g.
 * a stub driver in tests, or a future headless-shell driver). `BrowserSession`
 * keeps the orchestration that is NOT driver-specific — the serial mutex
 * (`run`), timeout envelope, dialog policy, console/network ring buffers,
 * snapshot/tiling/status/saveScreenshots.
 *
 * The driver is a FULL BACKEND seam: it exposes the semantic page- and
 * context-level operations the session/page-ops layer needs, and it does NOT
 * leak a raw Playwright `page`/`context` handle. Navigation, interaction,
 * observation, cookies and download all route through driver methods, so a
 * non-Playwright backend can be swapped in without touching the session. All
 * Playwright handles stay private to the driver implementation; the structural
 * types below exist only as the implementation surface for `PlaywrightDriver`
 * and to keep the plugin compiling without pulling in the playwright type
 * package at build time (AGENTS.md §2).
 */

// ── Structural Playwright types (no hard dependency) ─────────────────────

export interface PwElementHandle {
  click(): Promise<void>
  fill(text: string): Promise<void>
  type(text: string): Promise<void>
  innerText(): Promise<string>
  isVisible(): Promise<boolean>
}

/** A Playwright locator handle (structural, minimal for click/fill/wait).
 * Action methods accept an optional `{ timeout }` so a caller can bound a slow
 * SPA mount; `waitFor` carries the same state enum Playwright uses. */
export interface PwLocator {
  click(opts?: { timeout?: number }): Promise<void>
  fill(text: string, opts?: { timeout?: number }): Promise<void>
  type(text: string): Promise<void>
  clear(opts?: { timeout?: number }): Promise<void>
  hover(opts?: { timeout?: number }): Promise<void>
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
  /** Close this page. Cancels in-flight operations on it (used to quarantine a stale op after a cooperative abort, P1-2). */
  close(): Promise<void>
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
  /** Seed cookies/localStorage from a parsed storage-state object (Playwright). */
  setStorageState(storageState: Record<string, unknown>): Promise<void>
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
  newContext(opts?: { storageState?: string | Record<string, unknown> }): Promise<PwContext>
  version(): string
  context(): { newPage(): Promise<PwPage> }
}

export interface PwChromium {
  launch(opts: { channel?: string; executablePath?: string; headless?: boolean; args?: string[]; proxy?: { server: string; bypass?: string } }): Promise<PwBrowser>
  /** NOTE: Playwright's `launchPersistentContext` does NOT accept `storageState`; seed it via `PwContext.setStorageState` after launch. */
  launchPersistentContext(userDataDir: string, opts: { channel?: string; executablePath?: string; headless?: boolean; args?: string[]; proxy?: { server: string; bypass?: string } }): Promise<PwContext>
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

// ── Driver-level result / option shapes (Playwright-agnostic) ────────────
// These are the ONLY types that cross the driver boundary. `BrowserSession` /
// page-ops never see a raw Playwright handle; only plain data and primitives.

/** A navigation result (status + resolved URL); URL NOT sanitized here. */
export interface DriverNavResult {
  status: number | null
  url: string
}

/** Screenshot capture options (type `png`|`jpeg`, optional quality). */
export interface DriverScreenshotOptions {
  type?: string
  quality?: number
}

/** A browser cookie (plain shape, mirrors `PwCookie`). */
export interface DriverCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: string
}

/** A cookie to add (session-level shape accepted by `addCookies`). */
export interface DriverAddCookie {
  name: string
  value: string
  url?: string
  domain?: string
  path?: string
}

/** An HTTP response from the session request context (used by download). */
export interface DriverHttpResponse {
  ok(): boolean
  status(): number
  url(): string
  body(): Promise<Buffer>
  headers(): Record<string, string>
}

/**
 * The low-level browser backend. A driver owns the browser lifecycle AND all
 * page/context primitives, so a non-Playwright backend can be swapped in
 * without touching the session. Drivers must be launch-lazy: `start` may be
 * called repeatedly and must surface a missing browser as `false` (with a
 * human-readable reason) rather than throwing.
 *
 * The driver NEVER exposes a raw `page`/`context` handle — every operation a
 * caller needs is a method here. Playwright tricks that a caller wants (e.g.
 * the frame-aware, wait-for-actionable locator lookup used by interaction)
 * are encapsulated INSIDE the respective methods (`click`/`fill`/`hover`/
 * `waitForVisible`), so the boundary stays clean.
 *
 * Abort semantics (B8): navigation and evaluate accept an optional
 * `AbortSignal` and race the underlying Playwright call against it, so a tool
 * that exceeds its wall-clock budget returns `timed-out` instead of being
 * hard-killed. Interaction/observe primitives are bounded by their own
 * configured timeouts and are deliberately signal-exempt.
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

  /**
   * Mutation-aware settle (B8): resolves when the document is ready AND no
   * DOM mutations have occurred for a short quiet window, bounded by a hard
   * `timeoutMs` cap. More robust than a bare double-rAF for pages that render
   * asynchronously after an action, yet never runs longer than `timeoutMs`.
   */
  settleStable(timeoutMs: number): Promise<void>

  // ── Navigation ─────────────────────────────────────────────────────────
  /** Navigate to a URL (`domcontentloaded` + best-effort load wait semantics). */
  goto(url: string, opts?: { timeout?: number; signal?: AbortSignal }): Promise<DriverNavResult>
  goBack(opts?: { timeout?: number; signal?: AbortSignal }): Promise<DriverNavResult>
  goForward(opts?: { timeout?: number; signal?: AbortSignal }): Promise<DriverNavResult>
  reload(opts?: { timeout?: number; signal?: AbortSignal }): Promise<DriverNavResult>
  /** The current document title. */
  title(): Promise<string>
  /** The current page URL (NOT sanitized; the caller redacts). */
  currentUrl(): string
  /** Best-effort wait for a load state (e.g. `load`); never throws on failure. */
  waitForLoadState(state?: string): Promise<void>

  // ── Interaction (encapsulate frame-aware lookup + waitForLocator + act) ─
  /** Click the first target matching `selector`/`text`, waiting for it to be actionable. */
  click(selector?: string, text?: string, opts?: { timeout?: number }): Promise<void>
  /** Fill an input with `text` (optionally clearing it first). */
  fill(selector: string, text: string, opts?: { timeout?: number; clear?: boolean }): Promise<void>
  /** Hover the first target matching `selector`/`text`. */
  hover(selector?: string, text?: string, opts?: { timeout?: number }): Promise<void>
  /** Press a key on the focused page (e.g. `Enter`). */
  press(key: string): Promise<void>
  /** Wait for a selector/text to become visible, or throw after `timeout`. */
  waitForVisible(selector?: string, text?: string, opts?: { timeout?: number }): Promise<void>

  // ── Observation ────────────────────────────────────────────────────────
  /** Run a JS expression in the page context (string) and return its result. */
  evaluate<T>(expression: string, signal?: AbortSignal): Promise<T>
  /** Capture the current viewport as a PNG/JPEG buffer. */
  screenshot(opts?: DriverScreenshotOptions): Promise<Buffer>
  /** Print the current page to a PDF buffer. */
  pdf(opts?: { format?: string; printBackground?: boolean }): Promise<Buffer>

  // ── Viewport / session state ───────────────────────────────────────────
  /** Resize the live page viewport (no-op if not started). */
  setViewportSize(size: { width: number; height: number }): Promise<void>
  /** Export the session's cookie/localStorage state (for persistence). */
  storageState(): Promise<Record<string, unknown>>

  // ── Cookies / download (context-level) ─────────────────────────────────
  cookies(urls?: string[]): Promise<DriverCookie[]>
  addCookies(cookies: DriverAddCookie[]): Promise<void>
  clearCookies(): Promise<void>
  /** Perform a same-context HTTP GET (carries session cookies/auth). */
  requestGet(url: string, opts?: { timeout?: number; signal?: AbortSignal }): Promise<DriverHttpResponse>
}

// Re-export the default Playwright implementation from the contract module so a
// consumer can `import { createPlaywrightDriver } from 'dsh-tui-browser-use/driver'`
// (the `./driver` package subpath maps to this file) and get both the contract
// types AND the concrete backend in one import — otherwise the advertised
// "swap the browser backend" seam is unreachable through its own subpath.
export { createPlaywrightDriver } from './playwright-driver.js'
