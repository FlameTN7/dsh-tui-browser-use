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
import { type RuntimeEnv } from './runtime-env.js';
import type { BrowserDriver } from './driver/browser-driver.js';
import { type PageOpsHost } from './page-ops.js';
import type { BrowserUseConfig, NavigateParams, NavigateResult, ClickParams, ClickResult, TypeParams, TypeResult, ScrollParams, ScrollResult, PressParams, PressResult, WaitParams, WaitResult, HoverParams, HoverResult, EvaluateParams, EvaluateResult, ScreenshotParams, PdfParams, PdfResult, DownloadParams, DownloadResult, CookiesParams, CookiesResult, SnapshotParams, SnapshotResult, CaptureSegmentsResult, ConsoleMessagesParams, ConsoleMessagesResult, NetworkRequestsParams, NetworkRequestsResult, StatusResult, I18nTemplate } from './types.js';
export { sanitizeUrl, cookieValue, splitSaveStem, BrowserToolError } from './browser-utils.js';
/** The long-lived browser session shared across tool calls. */
export declare class BrowserSession implements PageOpsHost {
    private _startError;
    /** UI language for user-facing errors. */
    readonly lang: 'zh' | 'en';
    /** The injected browser backend (swappable via constructor). Defaults to Playwright. */
    readonly driver: BrowserDriver;
    config: BrowserUseConfig;
    private chain;
    private static readonly RUN_CTX;
    readonly navTimeoutMs: number;
    readonly actionTimeoutMs: number;
    readonly settleTimeoutMs: number;
    private sessionPaths;
    /** Whether we currently hold a persistent lock file (to release on close). */
    private sessionLocked;
    /** Whether a persistent lock conflict degraded this run to an isolated session. */
    private degraded;
    /** Profile ownership outlives a page discarded by a cooperative abort. */
    private sessionInitialized;
    private consoleLog;
    private networkLog;
    private static readonly CAPTURE_CAP;
    /** The injected runtime environment (timeouts, dialog, session paths, ...). */
    readonly env: RuntimeEnv;
    /** The page-driving operations, delegating to the live browser handles. */
    private readonly ops;
    constructor(config: BrowserUseConfig, lang: 'zh' | 'en', env?: RuntimeEnv, driver?: BrowserDriver);
    get startError(): string | null;
    /** Resolve the effective viewport size (P0-03). Prefers the explicit
     * `viewport` config; falls back to the deprecated `screenshot.maxDimension`
     * alias used by older configs / test scripts, then the 1024×768 default. */
    private viewportSize;
    run<T>(task: () => Promise<T>): Promise<T>;
    /**
     * Hot-apply a new viewport size to the live page (R-07). When the browser is
     * already started, a `/settings` change to `viewport` must resize the current
     * page rather than only taking effect on the next session (which would
     * silently ignore a mid-session edit). Serialized through `run()` so it never
     * interleaves a pending Playwright tool call. A not-yet-started session is a
     * no-op (the next `ensureStarted()` reads the new config).
     */
    applyViewport(size?: {
        width: number;
        height: number;
    }): Promise<void>;
    /**
     * Ensure a browser and page exist, probing sources in order:
     * system Chrome (`channel:'chrome'`) → explicit binary (`executablePath`) →
     * Playwright-bundled Chromium. `DSH_TUI_BROWSER_ENGINE` selects `firefox`/
     * `webkit` for cross-engine coverage; the chromium path stays the default.
     * The launch + probe logic lives in the injected {@link BrowserDriver}; this
     * session forwards the effective config/env and delegates its orchestration
     * (run/timeout/snapshot/tiling) through driver primitives.
     */
    ensureStarted(): Promise<boolean>;
    /** Release the browser and mark the session unstarted. */
    close(): Promise<void>;
    navigate(params: NavigateParams, signal?: AbortSignal): Promise<NavigateResult>;
    click(params: ClickParams, signal?: AbortSignal): Promise<ClickResult>;
    type(params: TypeParams, signal?: AbortSignal): Promise<TypeResult>;
    back(signal?: AbortSignal): Promise<NavigateResult>;
    forward(signal?: AbortSignal): Promise<NavigateResult>;
    reload(signal?: AbortSignal): Promise<NavigateResult>;
    scroll(params: ScrollParams, signal?: AbortSignal): Promise<ScrollResult>;
    press(params: PressParams, signal?: AbortSignal): Promise<PressResult>;
    wait(params: WaitParams, signal?: AbortSignal): Promise<WaitResult>;
    hover(params: HoverParams, signal?: AbortSignal): Promise<HoverResult>;
    evaluate(params: EvaluateParams, signal?: AbortSignal): Promise<EvaluateResult>;
    captureScreenshot(params: ScreenshotParams): Promise<Buffer>;
    captureSegments(opts?: {
        maxImageBytes?: number;
    }): Promise<CaptureSegmentsResult>;
    pdf(params: PdfParams, signal?: AbortSignal): Promise<PdfResult>;
    download(params: DownloadParams, signal?: AbortSignal): Promise<DownloadResult>;
    saveScreenshots(buffers: Buffer[], savePath: string, format: string): Promise<{
        savedPath: string;
        savedPaths: string[];
    }>;
    snapshot(params: SnapshotParams, signal?: AbortSignal): Promise<SnapshotResult>;
    cookies(params: CookiesParams, signal?: AbortSignal): Promise<CookiesResult>;
    /** @deprecated DOM observation is unified under `browser_snapshot`; kept for back-compat. */
    elementSummary(): Promise<string>;
    consoleMessages(params: ConsoleMessagesParams, signal?: AbortSignal): Promise<ConsoleMessagesResult>;
    networkRequests(params: NetworkRequestsParams, signal?: AbortSignal): Promise<NetworkRequestsResult>;
    /** Report browser availability plus the effective config snapshot. */
    status(): Promise<StatusResult>;
}
export type { I18nTemplate };
//# sourceMappingURL=browser.d.ts.map