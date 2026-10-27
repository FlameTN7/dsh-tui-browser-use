/**
 * dsh-tui-browser-use — browser helper utilities.
 *
 * Pure, Playwright-agnostic helpers shared by the browser session orchestration
 * (browser.ts) and the page-operations class (page-ops.ts). These carry no
 * session state and never reach into the harness; they are the single source of
 * truth for the abort-shot-circuit race, the capture-time JPEG quality staircase,
 * and the sensitive-data redaction (URL/cookie). Frame-aware locator resolution
 * and capture live inside the `BrowserDriver` (the sole Playwright boundary), so
 * this module stays free of a hard runtime dependency on the playwright type
 * package (AGENTS.md §2).
 */
import type { ErrorCode } from './types.js';
/**
 * Throw a `timed-out` BrowserToolError when the cooperative abort signal has
 * already fired. Called at the START of every dispatchable browser operation
 * (navigate/click/type/scroll/download/...) so a tool whose wall-clock budget
 * expired does not issue a Playwright call that could still mutate the page —
 * the operation is short-circuited BEFORE it is dispatched (竞品 B8).
 */
export declare function throwIfAborted(signal: AbortSignal | undefined): void;
/**
 * Race a Playwright navigation/eval promise against the abort signal. Playwright
 * does not accept an abort signal, so a `page.goto` to a hung host can outlive
 * the tool's wall-clock budget and get the tool hard-killed by the host instead
 * of returning its own envelope. The budget (`AbortSignal.timeout` composed in
 * `abortSignalOf`) fires first → we surface `timed-out` and, via the optional
 * `cancel` callback, cancels the underlying op (the driver closes the page it
 * ran on) so it cannot keep mutating a page the session has already released.
 *
 * 审核 P1-2 (fully fixed): without a `cancel` hook the underlying Playwright
 * promise would be left running after the session queue advanced, so a stale
 * navigation/eval could interleave with the next tool on the same page. The
 * driver passes a `cancel` that quarantines the op (discard the page it ran on);
 * the session then lazily provisions a fresh page for the next call, preserving
 * serialization. `cancel` is only invoked when the abort actually wins the race
 * (i.e. `p` has NOT already settled), so a healthy page is never torn down just
 * because the abort fired a moment after the op finished.
 */
export declare function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined, message?: string, cancel?: () => void): Promise<T>;
/**
 * Split a save path into its directory, a "stem" (basename minus one final
 * extension), and that extension (with the leading dot, e.g. `.jpg`; empty
 * string when the path is extensionless). Unlike a bare `lastIndexOf('.')`,
 * an extensionless path keeps its full basename as the stem (e.g.
 * `/tmp/multi-noext` → `{dir:'/tmp/', stem:'multi-noext', ext:''}`, NOT
 * `multi-noex`). A leading-dot file (`.hidden`) is treated as extensionless so
 * its name is preserved.
 */
export declare function splitSaveStem(savePath: string): {
    dir: string;
    stem: string;
    ext: string;
};
/** JPEG quality staircase steps (descending), never going above `base`, floor at 40. */
export declare function jpegQualitySteps(base: number): number[];
/**
 * Scrub sensitive query params from a URL; best-effort, never throws. The
 * `sensitiveKeys` default comes from the runtime env, but a caller that holds a
 * `RuntimeEnv` passes its own list so a live `/settings`-visible override is
 * honoured. Keeping the default here lets tests and external callers use the
 * function without threading an env object through.
 */
export declare function sanitizeUrl(raw: string, sensitiveKeys?: string[]): string;
/** Mask a cookie value unless the caller explicitly asked to read it (P1-04). */
export declare function cookieValue(value: string, readValues: boolean): string;
/** A tool error that carries a canonical {@link ErrorCode}. */
export declare class BrowserToolError extends Error {
    readonly code: ErrorCode;
    constructor(code: ErrorCode, message: string);
}
//# sourceMappingURL=browser-utils.d.ts.map