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
import { type BrowserDriver, type DriverStartOptions, type DriverNavResult, type DriverScreenshotOptions, type DriverCookie, type DriverAddCookie, type DriverHttpResponse } from './browser-driver.js';
export declare class PlaywrightDriver implements BrowserDriver {
    private _pw;
    private _engine;
    private _page;
    private _ctx;
    private _startError;
    /** In-flight start promise so a concurrent `start()` call reuses the same launch. */
    private _startPromise;
    get startError(): string | null;
    get running(): boolean;
    private requirePage;
    private requireContext;
    /**
     * Create a fresh page in the existing context and wire its viewport + dialog/
     * console/network handlers. Used both after a full launch and when a
     * cooperative abort discarded the old page (P1-2). On failure the page is
     * reset to null and `_startError` set; the caller decides whether a failed
     * re-provision into an existing context should also tear the whole browser
     * down (it does, so a corrupt context does not wedge the session forever).
     */
    private provisionPage;
    /**
     * Discard the current page and, in the background, close it so any in-flight
     * Playwright op on it is cancelled. This is the P1-2 quarantine: after a
     * cooperative abort the stale op must not keep mutating a page the session
     * has released, so we mark the page null immediately (the next `start()`
     * provisions a fresh page in the same context) and close the old one to
     * cancel the op. `_page` is nulled synchronously so `running` is false before
     * the next tool is dequeued.
     */
    private discardPage;
    private loadPlaywright;
    /**
     * Windows App Paths registry probe (plan 2.1): `reg query` the per-user and
     * machine-wide App Paths keys for chrome/chromium and take the resolved
     * executable when it is a real PE binary. Only runs on win32; a missing
     * key or a non-native path is silently skipped.
     */
    private windowsAppPaths;
    private resolveExecutablePath;
    start(opts: DriverStartOptions): Promise<boolean>;
    close(): Promise<void>;
    version(): string;
    /**
     * Mutation-aware settle (B8): a fast path (double-rAF) resolves immediately
     * on a quiet page; only a page that keeps mutating extends toward a quiet
     * window and then the hard `timeoutMs` cap. This replaces a bare double-rAF
     * for pages that render asynchronously after an action, so a snapshot is not
     * taken mid-update, while never blocking longer than `timeoutMs`.
     */
    settleStable(timeoutMs: number): Promise<void>;
    goto(url: string, opts?: {
        timeout?: number;
        signal?: AbortSignal;
    }): Promise<DriverNavResult>;
    goBack(opts?: {
        timeout?: number;
        signal?: AbortSignal;
    }): Promise<DriverNavResult>;
    goForward(opts?: {
        timeout?: number;
        signal?: AbortSignal;
    }): Promise<DriverNavResult>;
    reload(opts?: {
        timeout?: number;
        signal?: AbortSignal;
    }): Promise<DriverNavResult>;
    title(): Promise<string>;
    currentUrl(): string;
    waitForLoadState(state?: string): Promise<void>;
    click(selector?: string, text?: string, opts?: {
        timeout?: number;
    }): Promise<void>;
    fill(selector: string, text: string, opts?: {
        timeout?: number;
        clear?: boolean;
    }): Promise<void>;
    hover(selector?: string, text?: string, opts?: {
        timeout?: number;
    }): Promise<void>;
    press(key: string): Promise<void>;
    waitForVisible(selector?: string, text?: string, opts?: {
        timeout?: number;
    }): Promise<void>;
    evaluate<T>(expression: string, signal?: AbortSignal): Promise<T>;
    screenshot(opts?: DriverScreenshotOptions): Promise<Buffer>;
    pdf(opts?: {
        format?: string;
        printBackground?: boolean;
    }): Promise<Buffer>;
    setViewportSize(size: {
        width: number;
        height: number;
    }): Promise<void>;
    storageState(): Promise<Record<string, unknown>>;
    cookies(urls?: string[]): Promise<DriverCookie[]>;
    addCookies(cookies: DriverAddCookie[]): Promise<void>;
    clearCookies(): Promise<void>;
    requestGet(url: string, opts?: {
        timeout?: number;
        signal?: AbortSignal;
    }): Promise<DriverHttpResponse>;
}
/** Construct the default Playwright-backed browser driver. */
export declare function createPlaywrightDriver(): BrowserDriver;
//# sourceMappingURL=playwright-driver.d.ts.map