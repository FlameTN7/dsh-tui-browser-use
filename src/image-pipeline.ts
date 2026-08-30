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

import type { PreparedImage } from './types.js'
import type { ScreenshotConfig, TilingConfig } from './types.js'

/** Default byte budget for a prepared screenshot (≈300KB). */
export const DEFAULT_MAX_IMAGE_BYTES = 300 * 1024

/** Output options for {@link prepareScreenshot}. */
export interface PrepareScreenshotOptions {
  format: ScreenshotConfig['format']
  quality: ScreenshotConfig['quality']
  maxWidth: number
  maxHeight: number
  tiling: TilingConfig['mode']
  /** Effective tiling threshold, when `tiling` is `auto`/`on`. */
  thresholdWidth?: number
  thresholdHeight?: number
  /** Tile overlap in pixels, when `tiling` is `auto`/`on`. */
  overlap?: number
  /**
   * Byte budget. When the payload exceeds it the image is marked `oversize`
   * (capture-time JPEG staircase already tried to shrink it; PNG is never
   * re-encoded). Defaults to {@link DEFAULT_MAX_IMAGE_BYTES}.
   */
  maxImageBytes?: number
}

/** Cheap width/height header sniff for PNG (IHDR) and JPEG (SOFn). */
export function parseImageDimensions(buf: Buffer): { width: number; height: number } {
  if (!buf || buf.length < 8) return { width: 0, height: 0 }

  // PNG: 8-byte signature, then IHDR at offset 16: 4 bytes width, 4 bytes height (big-endian).
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length >= 24) {
      return {
        width: buf.readUInt32BE(16),
        height: buf.readUInt32BE(20),
      }
    }
    return { width: 0, height: 0 }
  }

  // JPEG: walk markers to a SOFn segment (C0-CF except C4/C8/CC).
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue }
      const marker = buf[i + 1]
      if (marker === undefined) { i += 1; continue }
      const segLen = buf.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
      i += 2 + segLen
    }
  }

  return { width: 0, height: 0 }
}

/** Infer the mime type from a byte signature. */
export function sniffMime(buf: Buffer): string {
  if (!buf || buf.length < 4) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'image/webp'
  return 'image/jpeg'
}

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
export function prepareScreenshot(
  input: Buffer,
  options: PrepareScreenshotOptions,
): PreparedImage[] {
  const mime = sniffMime(input)
  const { width, height } = parseImageDimensions(input)
  const budget = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES

  const prepared: PreparedImage = {
    mime,
    data: input,
    width,
    height,
    bytes: input.length,
    oversize: budget > 0 && input.length > budget,
  }
  return [prepared]
}
