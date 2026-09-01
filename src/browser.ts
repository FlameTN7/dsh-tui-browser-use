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
 * This module is the ORCHESTRATOR. It owns the serial mutex (`run`), the
 * launch/lifecycle (`ensureStarted`/`close`/`status`), the session/profile
 * state (locks, degraded, ephemeral cleanup), and the console/network ring
 * buffers. The page-driving operations (navigate, click, type, scroll, capture,
 * snapshot, pdf, download) live in `page-ops.ts` ({@link PageOps}), which this
 * session constructs with itself as the host and to which it delegates.
 */

import { mkdirSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { t } from './i18n.js'
import { effectiveViewport, detectCapability } from './capabilities.js'
import { resolveProvider, resolveRoute, hasRoutableBaseUrl } from './provider-router.js'
import { loadRuntimeEnv, type RuntimeEnv } from './runtime-env.js'
import { PlaywrightDriver } from './driver/playwright-driver.js'
import type { BrowserDriver } from './driver/browser-driver.js'
import { BrowserToolError, sanitizeUrl } from './browser-utils.js'
import { PageOps, type PageOpsHost } from './page-ops.js'
import {
  resolveSession,
  acquireLock,
  releaseLock,
  writeStorageState,
  purgeEphemeral,
  sanitizePath,
  degradeToIsolated,
  type ResolvedSessionPaths,
} from './session-profiles.js'
import type {
  BrowserUseConfig,
  NavigateParams,
  NavigateResult,
  ClickParams,
  ClickResult,
  TypeParams,
  TypeResult,
  ScrollParams,
  ScrollResult,
  PressParams,
  PressResult,
  WaitParams,
  WaitResult,
  HoverParams,
  HoverResult,
  EvaluateParams,
  EvaluateResult,
  ScreenshotParams,
  PdfParams,
  PdfResult,
  DownloadParams,
  DownloadResult,
  CookiesParams,
  CookiesResult,
  SnapshotParams,
  SnapshotResult,
  CaptureSegmentsResult,
  ConsoleMessagesParams,
  ConsoleMessagesResult,
  NetworkRequestsParams,
  NetworkRequestsResult,
  StatusResult,
  I18nTemplate,
} from './types.js'

// Re-export the shared helpers + error so external callers/tests (download-url,
// file-interaction-check, index, tools) keep their existing import paths.
export { sanitizeUrl, cookieValue, splitSaveStem, BrowserToolError } from './browser-utils.js'

/** The long-lived browser session shared across tool calls. */
export class BrowserSession implements PageOpsHost {
  private _startError: string | null = null
  /** UI language for user-facing errors. */
  readonly lang: 'zh' | 'en'
  /** The injected browser backend (swappable via constructor). Defaults to Playwright. */
  readonly driver: BrowserDriver
  // We don't hard-require a config at construction; the plugin injects it.
  config: BrowserUseConfig

  // ── Serial mutex (P1 #9) ───────────────────────────────────────────────
  // Single shared browser page → tool calls MUST never interleave Playwright
  // operations (e.g. a click racing a screenshot). Every public tool method is
  // funnelled through `run()`, which chains each task onto the previous so the
  // session is a strict serial queue.
  private chain: Promise<unknown> = Promise.resolve()
  // Re-entrancy guard for `run()`. AsyncLocalStorage propagates the flag across
  // `await` inside a queued task, so a page-op that (incorrectly) calls `run()`
  // while a task is in-flight is detected as a self-deadlock and rejected —
  // while a legitimate second `run()` from the harness (a separate async
  // context) is left untouched and simply queued.
  private static readonly RUN_CTX = new AsyncLocalStorage<true>()

  // ── Parameterized timeouts (P1 #9), env-overridable ────────────────────
  readonly navTimeoutMs: number
  readonly actionTimeoutMs: number
  readonly settleTimeoutMs: number

  // ── Session-state persistence (P1 #8 / Phase 3) ─────────────────────────
  // `sessionPaths` resolves the effective mode/paths from config + env each
  // construction. `userDataDir` retains the full browser profile (cookies/
  // localStorage) across runs; `storageStatePath` exports/imports a bare
  // cookie+localStorage snapshot. Precedence (AGENTS.md §5, unchanged): env
  // overrides win (external mode); otherwise `session.mode` picks a managed
  // persistent/isolated profile. A missing/unreadable path degrades to a fresh
  // session rather than failing.
  private sessionPaths: ResolvedSessionPaths
  /** Whether we currently hold a persistent lock file (to release on close). */
  private sessionLocked = false
  /** Whether a persistent lock conflict degraded this run to an isolated session. */
  private degraded = false

  // ── Console / network capture (P1 #7) ───────────────────────────────────
  // Ring buffers of recent console messages and network requests so the agent
  // can inspect page errors / XHR without a full devtools trace. Capped so a
  // chatty page never grows memory unbounded.
  private consoleLog: string[] = []
  private networkLog: string[] = []
  private static readonly CAPTURE_CAP = 500

  /** The injected runtime environment (timeouts, dialog, session paths, ...). */
  readonly env: RuntimeEnv

  /** The page-driving operations, delegating to the live browser handles. */
  private readonly ops: PageOps

  constructor(config: BrowserUseConfig, lang: 'zh' | 'en', env: RuntimeEnv = loadRuntimeEnv(), driver: BrowserDriver = new PlaywrightDriver()) {
    this.config = config
    this.lang = lang
    this.env = env
    this.driver = driver
    this.navTimeoutMs = env.navTimeoutMs
    this.actionTimeoutMs = env.actionTimeoutMs
    this.settleTimeoutMs = env.settleTimeoutMs
    this.sessionPaths = resolveSession(config, env)
    this.ops = new PageOps(this)
  }

  // ── PageOpsHost ─────────────────────────────────────────────────────────
  // The driver is the sole browser boundary; page-ops reads only the start
  // error (for a graceful `browser-error`), never a raw handle.
  get startError(): string | null { return this._startError }

  /** Resolve the effective viewport size (P0-03). Prefers the explicit
   * `viewport` config; falls back to the deprecated `screenshot.maxDimension`
   * alias used by older configs / test scripts, then the 1024×768 default. */
  private viewportSize(): { width: number; height: number } {
    return effectiveViewport(this.config)
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (BrowserSession.RUN_CTX.getStore()) {
      throw new Error('BrowserSession.run() called from inside a queued task (re-entrant). Page-op methods must not call session.run().')
    }
    const result = this.chain.then(() => BrowserSession.RUN_CTX.run(true, () => task()))
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
    if (!this.driver.running) return
    await this.run(async () => {
      await this.driver.setViewportSize({ width: dim.width, height: dim.height }).catch(() => undefined)
    })
  }

  /**
   * Ensure a browser and page exist, probing sources in order:
   * system Chrome (`channel:'chrome'`) → explicit binary (`executablePath`) →
   * Playwright-bundled Chromium. `DSH_TUI_BROWSER_ENGINE` selects `firefox`/
   * `webkit` for cross-engine coverage; the chromium path stays the default.
   * The launch + probe logic lives in the injected {@link BrowserDriver}; this
   * session forwards the effective config/env and delegates its orchestration
   * (run/timeout/snapshot/tiling) through driver primitives.
   */
  async ensureStarted(): Promise<boolean> {
    if (this.driver.running) return true
    // Re-resolve the session paths on each fresh start so a live `/settings`
    // edit to `session.mode`/`session.profile` is honoured the next time the
    // browser is actually started (matching the proxy restart semantics).
    this.sessionPaths = resolveSession(this.config, this.env)
    // Reset the per-attempt flags before re-evaluating the lock below; a stale
    // `true` from a previous attempt must never leak into this one.
    this.sessionLocked = false
    this.degraded = false
    // Whether THIS attempt acquired the persistent lock (not inherited from an
    // earlier attempt). Only a lock this attempt acquired may be released on a
    // failed start — a lock-conflict fallback owns no lock.
    let lockAcquiredHere = false
    // Persistent mode: acquire the profile lock so two processes cannot share a
    // profile (B5). On conflict we DEGRADE to an isolated session rather than
    // hanging — reported via `status().session.degraded`. The paths are reset to
    // a brand-new ephemeral run dir so the browser never touches the locked
    // profile dir.
    if (this.sessionPaths.mode === 'persistent' && this.sessionPaths.lockPath) {
      const lock = acquireLock(this.sessionPaths.lockPath)
      if (lock.held) {
        this.sessionLocked = true
        lockAcquiredHere = true
      } else {
        this.degraded = true
        this.sessionPaths = degradeToIsolated(this.sessionPaths)
      }
    }
    // Lazy-create the user-data dir (B6): profiles are only materialised on the
    // FIRST tool call that actually starts the browser, never at construction.
    if (this.sessionPaths.userDataDir) {
      try { mkdirSync(this.sessionPaths.userDataDir, { recursive: true }) } catch { /* best-effort */ }
    }
    // Forward the RESOLVED paths (not the raw env) so a managed persistent /
    // isolated profile is what the browser actually launches with. The spread
    // keeps every other env override intact.
    const startEnv: RuntimeEnv = {
      ...this.env,
      userDataDir: this.sessionPaths.userDataDir,
      storageStatePath: this.sessionPaths.storageStatePath,
    }
    let started: boolean
    try {
      started = await this.driver.start({
        config: this.config,
        env: startEnv,
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
    } catch (err) {
      // The driver contract says `start` returns false rather than throwing, but
      // a third-party driver may still throw. Treat it as a failed start and
      // surface the reason instead of leaking the exception past `ensureStarted`.
      this._startError = `browser-launch-failed:${err instanceof Error ? err.message : String(err)}`
      started = false
    }
    if (!started) {
      this._startError = this._startError ?? this.driver.startError ?? t('error.browser-missing', this.lang)
      // Release only a lock THIS attempt acquired (P1-1): a failed start must
      // not poison later attempts — otherwise the next ensureStarted() sees its
      // own live PID in the lock and degrades to isolated forever. On a real
      // lock conflict we acquired nothing, and `degraded` must stay true so the
      // failure report still explains the fallback correctly.
      if (lockAcquiredHere && this.sessionPaths.lockPath) {
        releaseLock(this.sessionPaths.lockPath)
        this.sessionLocked = false
      }
      // A failed isolated attempt materialised a fresh ephemeral dir; the next
      // attempt resolves a NEW run id, so purge this one instead of leaking it.
      if (this.sessionPaths.ephemeralRunDir) purgeEphemeral(this.sessionPaths.ephemeralRunDir)
      return false
    }
    this._startError = null
    return true
  }

  /** Release the browser and mark the session unstarted. */
  async close(): Promise<void> {
    // Persistent mode: export the login snapshot to the resolved path before
    // tearing the browser down (best-effort, atomic temp+rename+0600). This is
    // what lets a managed profile survive restarts. A missing/unreadable target
    // degrades silently (the browser is always closed regardless).
    if (this.sessionPaths.storageStatePath && this.driver.running) {
      try {
        const data = await this.driver.storageState()
        writeStorageState(this.sessionPaths.storageStatePath, data)
        if (this.env.debug) {
          process.stderr.write(`[dsh-tui-browser-use] storage state exported: ${this.sessionPaths.storageStatePath} cookies=${(data.cookies as unknown[] | undefined)?.length ?? 0}\n`)
        }
      } catch (err) {
        // Never block close, but surface the failure in debug output — a silent
        // catch here has hidden storage-state export failures in the field.
        if (this.env.debug) {
          process.stderr.write(`[dsh-tui-browser-use] storage state export failed: ${String(err)}\n`)
        }
      }
    }
    await this.driver.close()
    // Release a held persistent lock so the next start can re-acquire it.
    if (this.sessionLocked && this.sessionPaths.lockPath) {
      releaseLock(this.sessionPaths.lockPath)
      this.sessionLocked = false
    }
    // Best-effort cleanup of an isolated session run dir (never blocks close).
    purgeEphemeral(this.sessionPaths.ephemeralRunDir)
  }

  // ── Tools ──────────────────────────────────────────────────────────────
  // The page-driving operations delegate to `PageOps`, which drives the browser
  // through the injected driver. Keeping the signatures here means the tool
  // registries, scripts and external callers keep their existing `session.*`
  // surface unchanged.

  navigate(params: NavigateParams, signal?: AbortSignal): Promise<NavigateResult> { return this.ops.navigate(params, signal) }
  click(params: ClickParams, signal?: AbortSignal): Promise<ClickResult> { return this.ops.click(params, signal) }
  type(params: TypeParams, signal?: AbortSignal): Promise<TypeResult> { return this.ops.type(params, signal) }
  back(signal?: AbortSignal): Promise<NavigateResult> { return this.ops.back(signal) }
  forward(signal?: AbortSignal): Promise<NavigateResult> { return this.ops.forward(signal) }
  reload(signal?: AbortSignal): Promise<NavigateResult> { return this.ops.reload(signal) }
  scroll(params: ScrollParams, signal?: AbortSignal): Promise<ScrollResult> { return this.ops.scroll(params, signal) }
  press(params: PressParams, signal?: AbortSignal): Promise<PressResult> { return this.ops.press(params, signal) }
  wait(params: WaitParams, signal?: AbortSignal): Promise<WaitResult> { return this.ops.wait(params, signal) }
  hover(params: HoverParams, signal?: AbortSignal): Promise<HoverResult> { return this.ops.hover(params, signal) }
  evaluate(params: EvaluateParams, signal?: AbortSignal): Promise<EvaluateResult> { return this.ops.evaluate(params, signal) }
  captureScreenshot(params: ScreenshotParams): Promise<Buffer> { return this.ops.captureScreenshot(params) }
  captureSegments(opts?: { maxImageBytes?: number }): Promise<CaptureSegmentsResult> { return this.ops.captureSegments(opts) }
  pdf(params: PdfParams): Promise<PdfResult> { return this.ops.pdf(params) }
  download(params: DownloadParams, signal?: AbortSignal): Promise<DownloadResult> { return this.ops.download(params, signal) }
  saveScreenshots(buffers: Buffer[], savePath: string, format: string): Promise<{ savedPath: string; savedPaths: string[] }> { return this.ops.saveScreenshots(buffers, savePath, format) }
  snapshot(params: SnapshotParams): Promise<SnapshotResult> { return this.ops.snapshot(params) }
  cookies(params: CookiesParams): Promise<CookiesResult> { return this.ops.cookies(params) }
  /** @deprecated DOM observation is unified under `browser_snapshot`; kept for back-compat. */
  elementSummary(): Promise<string> { return this.ops.elementSummary() }

  async consoleMessages(params: ConsoleMessagesParams): Promise<ConsoleMessagesResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this._startError ?? t('error.browser-missing', this.lang))
    const out = [...this.consoleLog]
    if (params.clear !== false) this.consoleLog = []
    return { messages: out }
  }

  async networkRequests(params: NetworkRequestsParams): Promise<NetworkRequestsResult> {
    if (!(await this.ensureStarted())) throw new BrowserToolError('browser-error', this._startError ?? t('error.browser-missing', this.lang))
    const out = [...this.networkLog]
    if (params.clear !== false) this.networkLog = []
    return { requests: out }
  }

  /** Report browser availability plus the effective config snapshot. */
  async status(): Promise<StatusResult> {
    const available = await this.ensureStarted()
    let version = 'unknown'
    if (available) {
      try { version = this.driver.version() } catch { /* keep unknown */ }
    }
    // Report the effective session/profile (Phase 3). The profile dir is
    // SANITIZED (home redacted) and never carries secrets; a persistent lock
    // conflict's `degraded` flag is surfaced so the agent knows the run fell
    // back to an isolated session.
    // Vision routing diagnostics: report the effective provider + whether the
    // route is usable, so the agent sees WHY vision may be off instead of a bare
    // `vision-unavailable`. Only config/env drive this (no API-key probe), so it
    // is always safe to surface.
    const visionMode = this.config.visionMode
    const isOff = visionMode === 'off'
    const provider = resolveProvider(visionMode === 'deepseek-file-api', this.env.providerOverride)
    const route = resolveRoute(provider, { baseUrl: this.env.baseUrlOverride, model: this.env.modelOverride })
    const cap = detectCapability(provider, route.defaultModel, this.config.providers)
    const missingBaseUrl = !hasRoutableBaseUrl(provider, this.env.baseUrlOverride)
    const visionReason = isOff
      ? 'vision-off'
      : missingBaseUrl
        ? 'missing-dsh-tui-browser-base-url'
        : (!cap.supportsVision ? 'provider-not-vision-capable' : undefined)

    return {
      available,
      version,
      config: structuredClone(this.config),
      session: {
        mode: this.sessionPaths.mode,
        profile: this.sessionPaths.profileName,
        profileDir: sanitizePath(this.sessionPaths.profileDir) ?? null,
        degraded: this.degraded,
      },
      vision: {
        mode: visionMode,
        provider,
        model: route.defaultModel,
        available: !isOff && cap.supportsVision && !missingBaseUrl,
        ...(visionReason ? { reason: visionReason } : {}),
      },
    }
  }
}

// Re-export the i18n template type so tools.ts can build error strings.
export type { I18nTemplate }
