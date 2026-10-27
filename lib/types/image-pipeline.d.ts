/**
 * dsh-tui-browser-use — screenshot preprocessing pipeline.
 *
 * Proposal §5.3: compress → downscale → tiling. Compression happens at the
 * CAPTURE time (`BrowserSession.captureSegments` runs the JPEG quality
 * staircase against the byte budget); tiling is done at the page level by
 * scroll-capture before a single image ever reaches this module. What remains
 * here is the validation/normalization layer: it sniffs mime/dimensions,
 * checks the byte budget, and reports `bytes`/`oversize` metadata while passing
 * the payload through unchanged. No pixel-level scaling is performed (no codec
 * is wired — AGENTS.md §1.5).
 *
 * The function never throws on an unrecognized image — it degrades to a
 * pass-through with unknown dimensions rather than failing a tool call.
 */
import type { PreparedImage } from './types.js';
import type { ScreenshotConfig, TilingConfig } from './types.js';
/** Default byte budget for a prepared screenshot (≈300KB). */
export declare const DEFAULT_MAX_IMAGE_BYTES: number;
/** Output options for {@link prepareScreenshot}. */
export interface PrepareScreenshotOptions {
    format: ScreenshotConfig['format'];
    quality: ScreenshotConfig['quality'];
    maxWidth: number;
    maxHeight: number;
    tiling: TilingConfig['mode'];
    /** Effective tiling threshold, when `tiling` is `auto`/`on`. */
    thresholdWidth?: number;
    thresholdHeight?: number;
    /** Tile overlap in pixels, when `tiling` is `auto`/`on`. */
    overlap?: number;
    /**
     * Byte budget. When the payload exceeds it the image is marked `oversize`
     * (capture-time JPEG staircase already tried to shrink it; PNG is never
     * re-encoded). Defaults to {@link DEFAULT_MAX_IMAGE_BYTES}.
     */
    maxImageBytes?: number;
}
/** Cheap width/height header sniff for PNG (IHDR) and JPEG (SOFn). */
export declare function parseImageDimensions(buf: Buffer): {
    width: number;
    height: number;
};
/** Infer the mime type from a byte signature. */
export declare function sniffMime(buf: Buffer): string;
/**
 * Prepare a screenshot buffer for the vision model.
 *
 * Validation/normalization phase: sniff mime/dimensions, check the byte budget,
 * and report `bytes`/`oversize` metadata. The payload is passed through
 * unchanged (capture-time compression already ran in
 * `BrowserSession.captureSegments`; pixel-level scaling is intentionally not
 * done — no codec is wired, AGENTS.md §1.5).
 *
 * @returns one prepared image (tiling will extend this to multiple).
 */
export declare function prepareScreenshot(input: Buffer, options: PrepareScreenshotOptions): PreparedImage[];
//# sourceMappingURL=image-pipeline.d.ts.map