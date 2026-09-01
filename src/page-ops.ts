/**
 * dsh-tui-browser-use — page primitive operations.
 *
 * Splits `BrowserSession` so the class is a thin orchestrator (serial mutex,
 * launch/lifecycle, console/network ring buffers, status) while the page-driving
 * work lives here. Every method delegates to the live `page`/`context` exposed
 * via the {@link PageOpsHost}, so no Playwright state is duplicated and the
 * plugin keeps its structural typing (AGENTS.md §2).
 *
 * The host supplies the effective config/env/timeouts and the live browser
 * handles; page-ops owns the "what to do on a page" logic (navigate, interact,
 * scroll, capture, snapshot, download) that the session funnels through its
 * serial `run()` queue.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { t } from './i18n.js'
import { effectiveViewport } from './capabilities.js'
import { DEFAULT_MAX_IMAGE_BYTES } from './image-pipeline.js'
import { requestUrl, displayUrl } from './download-url.js'
import {
  throwIfAborted,
  raceAbort,
  waitForLocator,
  resolveFrameAware,
  splitSaveStem,
  captureWithBudget,
  sanitizeUrl,
  cookieValue,
  BrowserToolError,
} from './browser-utils.js'
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
  SnapshotDelta,
  SnapshotNode,
  CaptureSegmentsResult,
} from './types.js'
import type { RuntimeEnv } from './runtime-env.js'
import type { BrowserDriver, PwPage, PwContext } from './driver/browser-driver.js'

/** The slice of `BrowserSession` state the page ops layer reads. */
export interface PageOpsHost {
  /** The live page (null until `ensureStarted` succeeds). */
  readonly page: PwPage | null
  /** The live context (null until `ensureStarted` succeeds). */
  readonly ctx: PwContext | null
  /** The reason `start` returned false (for a graceful `browser-error`). */
  readonly startError: string | null
  readonly env: RuntimeEnv
  readonly lang: 'zh' | 'en'
  readonly config: BrowserUseConfig
  readonly driver: BrowserDriver
  readonly navTimeoutMs: number
  readonly actionTimeoutMs: number
  readonly settleTimeoutMs: number
  /** Ensure a browser + page exist; returns false (not throws) when unavailable. */
  ensureStarted(): Promise<boolean>
}

/** The page-driving operations that operate on the live browser handles. */
export class PageOps {
  constructor(private readonly host: PageOpsHost) {}

  private requirePage(): PwPage {
    if (!this.host.page) throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: 'browser not started' }))
    return this.host.page
  }

  private requireContext(): PwContext {
    if (!this.host.ctx) throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: 'browser context not started' }))
    return this.host.ctx
  }

  /**
   * Mutation-aware settle (B8): waits for the document to be ready AND quiet
   * (no DOM mutations for a short window), bounded by a hard cap so a
   * continuously-mutating page never wedges an action. The cap is a fraction of
   * the configured settle timeout so a busy page (live clock, animation loop)
   * adds bounded latency instead of stalling to the full budget.
   */
  private async settlePage(): Promise<void> {
    const budget = Math.min(this.host.settleTimeoutMs, 1000)
    await this.host.driver.settleStable(budget).catch(() => undefined)
  }

  /**
   * Establish the snapshot baseline BEFORE an action (best-effort). A subsequent
   * `readSnapshotDelta` then reports what changed as a result of the action.
   */
  private async setSnapshotBaseline(maxNodes = 60): Promise<void> {
    try { await this.snapshot({ maxNodes }) } catch { /* best-effort delta */ }
  }

  /** Read the page-change delta since the baseline (best-effort). */
  private async readSnapshotDelta(maxNodes = 60): Promise<SnapshotDelta | undefined> {
    try { return (await this.snapshot({ maxNodes, delta: true })).delta } catch { return undefined }
  }

  async navigate(params: NavigateParams, signal?: AbortSignal): Promise<NavigateResult> {
    throwIfAborted(signal)
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      // Use `domcontentloaded` rather than `load`: many real external pages
      // (duckduckgo, wikipedia) keep running scripts so a `load` event can be
      // delayed far past a sane timeout. DOM-ready is enough to read the title
      // and interact; the follow-up `waitForLoadState('load')` is best-effort and
      // never blocks a successful navigate.
      throwIfAborted(signal)
      const resp = await raceAbort(page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: this.host.navTimeoutMs }), signal)
      await page.waitForLoadState('load').catch(() => undefined)
      // Let the layout settle rather than racing a still-parsing document.
      await this.settlePage()
      return {
        title: await page.title(),
        // R-11: sanitize the resolved URL so a signed/token-carrying redirect
        // target never leaks into the model context.
        url: sanitizeUrl(resp?.url() ?? params.url, this.host.env.sensitiveQueryKeys),
        status: resp?.status() ?? null,
      }
    } catch (err) {
      // Preserve a canonical tool error (e.g. B8 `timed-out`) — only wrap
      // unexpected runtime failures into the generic `browser-error`.
      if (err instanceof BrowserToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: msg }))
    }
  }

  async click(params: ClickParams, signal?: AbortSignal): Promise<ClickResult> {
    throwIfAborted(signal)
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
    const page = this.requirePage()
    const before = page.url()
    const wantDelta = params.delta === true
    if (wantDelta) await this.setSnapshotBaseline()
    try {
      // `text` (visible text) wins over `selector` (CSS); a bare selector keeps
      // using the CSS path. Searches main frame then child frames (iframe).
      // Wait for the target to be actionable (SPA/lazy).
      throwIfAborted(signal)
      const locator = await resolveFrameAware(page, params.selector, params.text)
      await waitForLocator(locator, this.host.actionTimeoutMs)
      throwIfAborted(signal)
      await locator.first().click({ timeout: this.host.actionTimeoutMs })
      await page.waitForLoadState('load').catch(() => undefined)
      await this.settlePage()
      const result: ClickResult = { success: true, newUrl: sanitizeUrl(page.url() || before, this.host.env.sensitiveQueryKeys) }
      if (wantDelta) { const d = await this.readSnapshotDelta(); if (d) result.delta = d }
      return result
    } catch (err) {
      // Preserve a canonical tool error (e.g. B8 `timed-out`) — only wrap
      // unexpected runtime failures into the generic `browser-error`.
      if (err instanceof BrowserToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: msg }))
    }
  }

  async type(params: TypeParams, signal?: AbortSignal): Promise<TypeResult> {
    throwIfAborted(signal)
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
    const page = this.requirePage()
    const wantDelta = params.delta === true
    if (wantDelta) await this.setSnapshotBaseline()
    try {
      // `type` uses a CSS selector (the caller queries the field). Search main
      // frame then child frames, and wait for the input before filling so a SPA
      // that mounts its form late doesn't miss.
      throwIfAborted(signal)
      const locator = await resolveFrameAware(page, params.selector, undefined)
      await waitForLocator(locator, this.host.actionTimeoutMs)
      throwIfAborted(signal)
      const field = locator.first()
      if (params.clear) await field.clear({ timeout: this.host.actionTimeoutMs }).catch(() => undefined)
      await field.fill(params.text, { timeout: this.host.actionTimeoutMs })
      // Optional trailing keypress (e.g. `Enter` to submit a form) — requires a
      // focused page, which Playwright keeps after fill.
      if (params.enter) {
        try { await page.keyboard.press(params.enter) } catch { /* key may be unsupported; ignore */ }
      }
      await this.settlePage()
      const result: TypeResult = { success: true }
      if (wantDelta) { const d = await this.readSnapshotDelta(); if (d) result.delta = d }
      return result
    } catch (err) {
      // Preserve a canonical tool error (e.g. B8 `timed-out`) — only wrap
      // unexpected runtime failures into the generic `browser-error`.
      if (err instanceof BrowserToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: msg }))
    }
  }

  /** Shared post-navigation settle used by back/forward/reload. */
  private async navSettle(resp: { status(): number | null; url(): string } | null, fallbackUrl: string): Promise<NavigateResult> {
    const page = this.requirePage()
    await page.waitForLoadState('load').catch(() => undefined)
    await this.settlePage()
    return { title: await page.title(), url: sanitizeUrl(resp?.url() ?? fallbackUrl, this.host.env.sensitiveQueryKeys), status: resp?.status() ?? null }
  }

  async back(signal?: AbortSignal): Promise<NavigateResult> {
    throwIfAborted(signal)
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      const before = page.url()
      throwIfAborted(signal)
      const resp = await raceAbort(page.goBack({ waitUntil: 'domcontentloaded', timeout: this.host.navTimeoutMs }), signal)
      return await this.navSettle(resp, before)
    } catch (err) {
      // Preserve a canonical tool error (e.g. B8 `timed-out`) — only wrap
      // unexpected runtime failures into the generic `browser-error`.
      if (err instanceof BrowserToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: msg }))
    }
  }

  async forward(signal?: AbortSignal): Promise<NavigateResult> {
    throwIfAborted(signal)
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      const before = page.url()
      throwIfAborted(signal)
      const resp = await raceAbort(page.goForward({ waitUntil: 'domcontentloaded', timeout: this.host.navTimeoutMs }), signal)
      return await this.navSettle(resp, before)
    } catch (err) {
      // Preserve a canonical tool error (e.g. B8 `timed-out`) — only wrap
      // unexpected runtime failures into the generic `browser-error`.
      if (err instanceof BrowserToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: msg }))
    }
  }

  async reload(signal?: AbortSignal): Promise<NavigateResult> {
    throwIfAborted(signal)
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      const before = page.url()
      throwIfAborted(signal)
      const resp = await raceAbort(page.reload({ waitUntil: 'domcontentloaded', timeout: this.host.navTimeoutMs }), signal)
      return await this.navSettle(resp, before)
    } catch (err) {
      // Preserve a canonical tool error (e.g. B8 `timed-out`) — only wrap
      // unexpected runtime failures into the generic `browser-error`.
      if (err instanceof BrowserToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: msg }))
    }
  }

  async scroll(params: ScrollParams, signal?: AbortSignal): Promise<ScrollResult> {
    throwIfAborted(signal)
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
    const page = this.requirePage()
    const x = Math.trunc(Number(params.x) || 0)
    const y = Math.trunc(Number(params.y) || 0)
    const wantDelta = params.delta === true
    if (wantDelta) await this.setSnapshotBaseline()
    try {
      throwIfAborted(signal)
      await page.evaluate(`window.scrollBy(${x}, ${y})`)
      await this.settlePage()
      const pos = await page.evaluate<{ x: number; y: number }>('({ x: window.scrollX, y: window.scrollY })').catch(() => ({ x, y }))
      const result: ScrollResult = { x: Math.trunc(pos?.x ?? x), y: Math.trunc(pos?.y ?? y) }
      if (wantDelta) { const d = await this.readSnapshotDelta(); if (d) result.delta = d }
      return result
    } catch (err) {
      // Preserve a canonical tool error (e.g. B8 `timed-out`) — only wrap
      // unexpected runtime failures into the generic `browser-error`.
      if (err instanceof BrowserToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: msg }))
    }
  }

  async press(params: PressParams, signal?: AbortSignal): Promise<PressResult> {
    throwIfAborted(signal)
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      throwIfAborted(signal)
      await page.keyboard.press(params.key)
      return { success: true }
    } catch (err) {
      // Preserve a canonical tool error (e.g. B8 `timed-out`) — only wrap
      // unexpected runtime failures into the generic `browser-error`.
      if (err instanceof BrowserToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: msg }))
    }
  }

  /** Wait for a selector to become visible, or sleep for `ms`. */
  async wait(params: WaitParams, signal?: AbortSignal): Promise<WaitResult> {
    throwIfAborted(signal)
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      if (params.selector) {
        throwIfAborted(signal)
        const locator = await resolveFrameAware(page, params.selector, undefined)
        await waitForLocator(locator, params.timeoutMs ?? this.host.settleTimeoutMs)
        return { waited: true, visible: true }
      }
      const ms = Math.max(0, Math.min(Number(params.ms) || 0, 30_000))
      if (ms > 0) {
        // Abortable sleep: a tool that exceeded its wall-clock budget must not
        // sit in a bare setTimeout while the harness already gave up (B8).
        if (signal) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms)
            signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
          })
          throwIfAborted(signal)
        } else {
          await new Promise((r) => setTimeout(r, ms))
        }
      }
      return { waited: true, ...(ms > 0 ? { ms } : {}) }
    } catch (err) {
      // Preserve a canonical tool error (e.g. B8 `timed-out`) — only wrap
      // unexpected runtime failures into the generic `browser-error`.
      if (err instanceof BrowserToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: msg }))
    }
  }

  async hover(params: HoverParams, signal?: AbortSignal): Promise<HoverResult> {
    throwIfAborted(signal)
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      // `text` (visible text) wins over `selector`; search main frame then frames.
      throwIfAborted(signal)
      const locator = await resolveFrameAware(page, params.selector, params.text)
      await waitForLocator(locator, this.host.actionTimeoutMs)
      throwIfAborted(signal)
      await locator.first().hover({ timeout: this.host.actionTimeoutMs })
      // Let any hover-triggered UI settle a beat.
      await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => undefined)
      return { success: true }
    } catch (err) {
      // Preserve a canonical tool error (e.g. B8 `timed-out`) — only wrap
      // unexpected runtime failures into the generic `browser-error`.
      if (err instanceof BrowserToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: msg }))
    }
  }

  async cookies(params: CookiesParams): Promise<CookiesResult> {
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
    const ctx = this.requireContext()
    try {
      if (params.clear) await ctx.clearCookies()
      if (params.cookies && params.cookies.length > 0) {
        await ctx.addCookies(params.cookies)
      }
      const cookies = await ctx.cookies()
      // Redact cookie values by default so auth state never leaks into the
      // model context; `readValues: true` is the explicit opt-in (P1-04).
      const readValues = params.readValues === true
      return { cookies: cookies.map((c) => ({ ...c, value: cookieValue(c.value, readValues) })) }
    } catch (err) {
      // Preserve a canonical tool error (e.g. B8 `timed-out`) — only wrap
      // unexpected runtime failures into the generic `browser-error`.
      if (err instanceof BrowserToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: msg }))
    }
  }

  async evaluate(params: EvaluateParams, signal?: AbortSignal): Promise<EvaluateResult> {
    throwIfAborted(signal)
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
    const page = this.requirePage()
    try {
      throwIfAborted(signal)
      const result = await raceAbort(page.evaluate(params.expression as unknown as string), signal)
      return { result }
    } catch (err) {
      // Preserve a canonical tool error (e.g. B8 `timed-out`) — only wrap
      // unexpected runtime failures into the generic `browser-error`.
      if (err instanceof BrowserToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: msg }))
    }
  }

  /** Capture the current viewport as a PNG buffer at the configured quality. */
  async captureScreenshot(_params: ScreenshotParams): Promise<Buffer> {
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
    const page = this.requirePage()
    const type = this.host.config.screenshot.format === 'png' ? 'png' : 'jpeg'
    return page.screenshot({ type, quality: type === 'jpeg' ? this.host.config.screenshot.quality : undefined })
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
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
    const page = this.requirePage()
    const type = this.host.config.screenshot.format === 'png' ? 'png' : 'jpeg'
    const quality = type === 'jpeg' ? this.host.config.screenshot.quality : undefined
    const budget = opts?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
    const dim = effectiveViewport(this.host.config)
    const vpW = dim.width
    const vpH = dim.height
    const overlap = Math.max(0, this.host.config.tiling.overlap || 0)
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
    if (this.host.config.tiling.mode === 'off') return single()

    // Determine the scrollable width/height and the "needs tiling" thresholds.
    const size = await page.evaluate<{ w: number; h: number }>(
      '({ w: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth), h: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) })',
    ).catch(() => ({ w: 0, h: 0 }))
    const pageW = size.w
    const pageH = size.h
    const dimT = this.host.config.tiling.threshold.split('x').map((s) => Number.parseInt(s.trim(), 10))
    const thresholdW = Number.isFinite(dimT[0] as number) ? (dimT[0] as number) : vpW
    const thresholdH = Number.isFinite(dimT[1] as number) ? (dimT[1] as number) : vpH

    // `auto`: single capture when the page already fits the viewport/threshold in
    // BOTH axes. Unknown dimensions (e.g. detached document) also fall back to a
    // single capture.
    const fits = pageW > 0 && pageH > 0 && pageW <= Math.max(thresholdW, vpW) && pageH <= Math.max(thresholdH, vpH)
    if (this.host.config.tiling.mode === 'auto' && fits) return single()
    if (pageW <= 0 || pageH <= 0) return single()

    // Scroll-capture tiling: iterate top-to-bottom in BANDS, and within each
    // band left-to-right across the columns — ROW-major reading order, which is
    // how the model naturally reads a grid of tiles (top-left → bottom-right).
    // Both axes loop, so a page wider than the viewport is captured as multiple
    // columns instead of being clipped to the left viewport. Row-major matters
    // under the maxTiles cap: filling a whole band (all columns) before moving
    // down means truncation drops the BOTTOM of the page (the same semantic as a
    // tall page), never an entire right-hand column while a band is half-read.
    const maxTiles = this.host.config.tiling.maxTiles ?? this.host.env.maxTiles
    const neededCols = pageW > vpW ? Math.ceil((pageW - vpW) / stepX) + 1 : 1
    const neededRows = pageH > vpH ? Math.ceil((pageH - vpH) / stepY) + 1 : 1
    const segmentsTotal = neededCols * neededRows

    // Remember where the page was so an observation never leaves it scrolled.
    const startScroll = await page.evaluate<{ x: number; y: number }>(
      '({ x: window.scrollX, y: window.scrollY })',
    ).catch(() => ({ x: 0, y: 0 }))

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
    // Restore the ORIGINAL scroll position for the next tool call (tiling is an
    // observation and must not move the page under the agent).
    await page.evaluate(`window.scrollTo(${startScroll.x}, ${startScroll.y})`).catch(() => undefined)
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
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
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
      return { url: sanitizeUrl(page.url(), this.host.env.sensitiveQueryKeys), path: outPath, bytes: buf.length }
    } catch (err) {
      // Preserve a canonical tool error (e.g. B8 `timed-out`) — only wrap
      // unexpected runtime failures into the generic `browser-error`.
      if (err instanceof BrowserToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: msg }))
    }
  }

  /**
   * Download a file from a URL and write it to disk. Uses the page's request
   * context so cookies/auth from the current session carry over (e.g. a
   * signed download link the page just exposed). `path` is written as-is (when
   * omitted a temp file is used); the result reports the absolute path and byte
   * size so the agent can hand the artifact off.
   */
  async download(params: DownloadParams, signal?: AbortSignal): Promise<DownloadResult> {
    throwIfAborted(signal)
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
    const context = this.requireContext()
    // Request the RAW URL (a signed/token URL must not be scrubbed) — only the
    // displayed URL is sanitized so a secret never leaks into the model context.
    const url = requestUrl(params.url)
    try {
      throwIfAborted(signal)
      const resp = await context.request.get(url, { timeout: this.host.navTimeoutMs })
      if (!resp.ok()) {
        throw new BrowserToolError('browser-error', t('error.download', this.host.lang, { message: `HTTP ${resp.status()}` }))
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
        url: displayUrl(params.url, resp.url() ?? params.url, this.host.env.sensitiveQueryKeys),
        path: outPath,
        bytes: buf.length,
        contentType: resp.headers()['content-type'],
      }
    } catch (err) {
      // Preserve a canonical tool error (e.g. B8 `timed-out`) — only wrap
      // unexpected runtime failures into the generic `browser-error`.
      if (err instanceof BrowserToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: msg }))
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
    if (!buffers.length) throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: 'no screenshot buffers to save' }))
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
    // If the caller's `savePath` carries an extension, honor it; otherwise fall
    // back to the config format's extension.
    const { dir, stem, ext } = splitSaveStem(savePath)
    const outExt = ext || (format === 'png' ? '.png' : '.jpg')
    buffers.forEach((buf, i) => {
      const p = `${dir}${stem}-${i + 1}${outExt}`
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
    if (!(await this.host.ensureStarted())) throw new BrowserToolError('browser-error', this.host.startError ?? 'browser unavailable')
    const page = this.requirePage()
    const maxNodes = Math.min(Math.max(Number(params.maxNodes) || 200, 1), 500)
    const wantDelta = params.delta === true
    try {
      const nodes = (await page.evaluate<unknown[]>(
        `(() => {
          const MAX = ${maxNodes};
          const DELTA = ${wantDelta ? 'true' : 'false'};
          const DELTA_CAP = 12;
          // Stable page-internal id registry (B7): a WeakMap holds element → id so
          // the same DOM node keeps its id across evaluate calls within the same
          // document. The "last" field keeps the previous snapshot's plain node
          // list so a later delta snapshot can diff against it. Full navigation
          // resets the window realm, clearing both — which is exactly right: old
          // ids are stale.
          const state = window.__dsh_browser_snapshot_state__ ||
            (window.__dsh_browser_snapshot_state__ = { nextId: 1, ids: new WeakMap(), last: null });
          const idOf = (el) => { let id = state.ids.get(el); if (!id) { id = state.nextId++; state.ids.set(el, id); } return id; };
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
              id: idOf(el), index: nodes.length + 1,
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
          // Content fingerprint to detect a "changed" node (includes position).
          const fp = (n) => JSON.stringify([n.role, n.name, n.tag, n.type || '', n.disabled, n.checked, n.placeholder || '', n.href || '', n.x, n.y, n.width, n.height]);
          const prev = state.last || [];
          const prevById = new Map(prev.map((n) => [n.id, n]));
          const currById = new Map(nodes.map((n) => [n.id, n]));
          let delta;
          if (DELTA) {
            const removed = prev.filter((n) => !currById.has(n.id)).map((n) => ({ id: n.id, role: n.role, name: n.name }));
            const added = nodes.filter((n) => !prevById.has(n.id));
            const changed = nodes.filter((n) => { const p = prevById.get(n.id); return p && fp(p) !== fp(n); });
            const reindexed = nodes.filter((n) => { const p = prevById.get(n.id); return p && p.index !== n.index; }).map((n) => ({ id: n.id, from: prevById.get(n.id).index, to: n.index }));
            let truncated = false;
            if (removed.length > DELTA_CAP) { removed.length = DELTA_CAP; truncated = true; }
            if (added.length > DELTA_CAP) { added.length = DELTA_CAP; truncated = true; }
            if (changed.length > DELTA_CAP) { changed.length = DELTA_CAP; truncated = true; }
            if (reindexed.length > DELTA_CAP) { reindexed.length = DELTA_CAP; truncated = true; }
            delta = { added, changed, removed, reindexed };
            if (truncated) delta.truncated = true;
          }
          state.last = nodes;
          return { nodes, total: totalMatching, truncated: totalMatching > nodes.length, ...(DELTA ? { delta } : {}) };
        })()`,
      )) ?? { nodes: [] }
      const raw = (typeof nodes === 'object' && nodes && 'nodes' in nodes && Array.isArray((nodes as { nodes: SnapshotNode[] }).nodes))
        ? (nodes as { nodes: SnapshotNode[]; total?: number; truncated?: boolean; delta?: SnapshotDelta })
        : { nodes: nodes as SnapshotNode[], total: undefined, truncated: undefined, delta: undefined }
      const out = raw.nodes.map((n) => (n.href ? { ...n, href: sanitizeUrl(n.href, this.host.env.sensitiveQueryKeys) } : n))
      const sanitizeNodes = (ns: SnapshotNode[]): SnapshotNode[] => ns.map((n) => (n.href ? { ...n, href: sanitizeUrl(n.href, this.host.env.sensitiveQueryKeys) } : n))
      const sanitizeDelta = (d: SnapshotDelta): SnapshotDelta => {
        const r: SnapshotDelta = {}
        if (d.added) r.added = sanitizeNodes(d.added)
        if (d.changed) r.changed = sanitizeNodes(d.changed)
        if (d.removed) r.removed = d.removed
        if (d.reindexed) r.reindexed = d.reindexed
        if (d.truncated !== undefined) r.truncated = d.truncated
        return r
      }
      return { nodes: out, ...(raw.total !== undefined ? { total: raw.total } : {}), ...(raw.truncated !== undefined ? { truncated: raw.truncated } : {}), ...(raw.delta !== undefined ? { delta: sanitizeDelta(raw.delta) } : {}) }
    } catch (err) {
      // Preserve a canonical tool error (e.g. B8 `timed-out`) — only wrap
      // unexpected runtime failures into the generic `browser-error`.
      if (err instanceof BrowserToolError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new BrowserToolError('browser-error', t('error.browser', this.host.lang, { message: msg }))
    }
  }

  /** Gather a best-effort summary of visible interactive elements. */
  async elementSummary(): Promise<string> {
    if (!(await this.host.ensureStarted())) return ''
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
}
