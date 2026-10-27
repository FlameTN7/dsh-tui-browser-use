/**
 * dsh-tui-browser-use — page primitive operations.
 *
 * Splits `BrowserSession` so the class is a thin orchestrator (serial mutex,
 * launch/lifecycle, console/network ring buffers, status) while the page-driving
 * work lives here. Every method delegates to the {@link BrowserDriver} exposed
 * via the {@link PageOpsHost}, so no Playwright state is duplicated and the
 * plugin keeps its structural typing (AGENTS.md §2). The driver is the SOLE
 * Playwright boundary: page-ops never touches a raw `page`/`context` handle —
 * it calls semantic driver primitives (navigate/interact/observe) and owns the
 * orchestration logic (settle, snapshot-delta, tiling math, saveScreenshots,
 * sanitize, error envelope).
 */
import type { BrowserUseConfig, NavigateParams, NavigateResult, ClickParams, ClickResult, TypeParams, TypeResult, ScrollParams, ScrollResult, PressParams, PressResult, WaitParams, WaitResult, HoverParams, HoverResult, EvaluateParams, EvaluateResult, ScreenshotParams, PdfParams, PdfResult, DownloadParams, DownloadResult, CookiesParams, CookiesResult, SnapshotParams, SnapshotResult, CaptureSegmentsResult } from './types.js';
import type { RuntimeEnv } from './runtime-env.js';
import type { BrowserDriver } from './driver/browser-driver.js';
/** The slice of `BrowserSession` state the page ops layer reads. */
export interface PageOpsHost {
    /** The reason `start` returned false (for a graceful `browser-error`). */
    readonly startError: string | null;
    readonly env: RuntimeEnv;
    readonly lang: 'zh' | 'en';
    readonly config: BrowserUseConfig;
    readonly driver: BrowserDriver;
    readonly navTimeoutMs: number;
    readonly actionTimeoutMs: number;
    readonly settleTimeoutMs: number;
    /** Ensure a browser + page exist; returns false (not throws) when unavailable. */
    ensureStarted(): Promise<boolean>;
}
/** The page-driving operations that operate through the injected driver. */
export declare class PageOps {
    private readonly host;
    constructor(host: PageOpsHost);
    /**
     * Canonicalize the deepest EXISTING ancestor of `p` so a not-yet-created file
     * (or a chain of symlinked parents) is still checked against the real path of
     * the allowed roots. This blocks the symlink-escape variant of the H1/P0-2
     * write containment (e.g. a link inside the workspace pointing at `/etc`).
     */
    private realAncestor;
    /**
     * Contain file writes to the workspace (CWD / `DSH_TUI_BROWSER_WORKSPACE`) and
     * the OS temp dir unless explicitly allowed (H1/P0-2). Returns the RESOLVED
     * absolute path so callers always write/report an absolute path. The check is
     * done on the REAL path (via the deepest existing ancestor) so a symlink that
     * resolves outside the allowed roots is rejected.
     */
    private assertWritablePath;
    /**
     * Capture a screenshot, dropping JPEG quality until the payload fits the byte
     * budget (capture-time compression, proposal §5.3). PNG is captured once and
     * the pipeline marks it `oversize`. The driver exposes a single `screenshot`
     * primitive; the budget loop is orchestration policy, so it lives here.
     */
    private captureWithBudget;
    /**
     * A minimal SSRF policy (P0-3), applied to BOTH `browser_navigate` and
     * `browser_download`: block `file:` and cloud-metadata/link-local targets by
     * default; loopback/RFC1918 remain allowed for local-dev compatibility.
     * `DSH_TUI_BROWSER_ALLOW_UNSAFE_URL=1` opts out. The policy is shared with
     * the pure `unsafeUrlKind` classifier so the exact same URL is judged the
     * same way across the two tools (and is unit-testable without a browser).
     */
    private assertSafeUrl;
    /**
     * Mutation-aware settle (B8): waits for the document to be ready AND quiet
     * (no DOM mutations for a short window), bounded by a hard cap so a
     * continuously-mutating page never wedges an action. The cap is a fraction of
     * the configured settle timeout so a busy page (live clock, animation loop)
     * adds bounded latency instead of stalling to the full budget.
     */
    private settlePage;
    /**
     * Establish the snapshot baseline BEFORE an action (best-effort). A subsequent
     * `readSnapshotDelta` then reports what changed as a result of the action.
     */
    private setSnapshotBaseline;
    /** Read the page-change delta since the baseline (best-effort). */
    private readSnapshotDelta;
    navigate(params: NavigateParams, signal?: AbortSignal): Promise<NavigateResult>;
    click(params: ClickParams, signal?: AbortSignal): Promise<ClickResult>;
    type(params: TypeParams, signal?: AbortSignal): Promise<TypeResult>;
    /** Shared post-navigation settle used by back/forward/reload. */
    private navSettle;
    back(signal?: AbortSignal): Promise<NavigateResult>;
    forward(signal?: AbortSignal): Promise<NavigateResult>;
    reload(signal?: AbortSignal): Promise<NavigateResult>;
    scroll(params: ScrollParams, signal?: AbortSignal): Promise<ScrollResult>;
    press(params: PressParams, signal?: AbortSignal): Promise<PressResult>;
    /** Wait for a selector to become visible, or sleep for `ms`. */
    wait(params: WaitParams, signal?: AbortSignal): Promise<WaitResult>;
    hover(params: HoverParams, signal?: AbortSignal): Promise<HoverResult>;
    cookies(params: CookiesParams, signal?: AbortSignal): Promise<CookiesResult>;
    evaluate(params: EvaluateParams, signal?: AbortSignal): Promise<EvaluateResult>;
    /** Capture the current viewport as a PNG buffer at the configured quality. */
    captureScreenshot(_params: ScreenshotParams): Promise<Buffer>;
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
    captureSegments(opts?: {
        maxImageBytes?: number;
    }): Promise<CaptureSegmentsResult>;
    /**
     * Print the current page to a PDF. When `path` is omitted the PDF is written
     * to a temp file; the result always reports the absolute path and byte size so
     * the agent can hand the artifact off (e.g. for further processing).
     */
    pdf(params: PdfParams, signal?: AbortSignal): Promise<PdfResult>;
    /**
     * Download a file from a URL and write it to disk. Uses the page's request
     * context so cookies/auth from the current session carry over (e.g. a
     * signed download link the page just exposed). `path` is written as-is (when
     * omitted a temp file is used); the result reports the absolute path and byte
     * size so the agent can hand the artifact off.
     */
    download(params: DownloadParams, signal?: AbortSignal): Promise<DownloadResult>;
    /**
     * Write captured screenshot buffers to disk. A single buffer goes to
     * `savePath` verbatim; multiple tiled buffers are written as
     * `<stem>-<i>.<ext>` beside it (never clobbering each other). Returns the
     * absolute paths written (first + all). The page is NOT re-captured — the
     * caller passes the buffers it already captured.
     */
    saveScreenshots(buffers: Buffer[], savePath: string, format: string): Promise<{
        savedPath: string;
        savedPaths: string[];
    }>;
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
    snapshot(params: SnapshotParams, signal?: AbortSignal): Promise<SnapshotResult>;
    /**
     * @deprecated DOM observation is unified under `browser_snapshot` (AGENTS.md
     * §6: never re-instate the elementSummary summary path). Kept only for
     * back-compat callers; returns '' as a no-op.
     */
    elementSummary(): Promise<string>;
}
//# sourceMappingURL=page-ops.d.ts.map