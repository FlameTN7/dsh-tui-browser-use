/**
 * dsh-tui-browser-use — screenshot preprocessing pipeline.
 *
 * Proposal §5.3: compress → downsample → tiling. Round 1 implements the
 * catalog + metadata path: Playwright already returns the screenshot at the
 * requested format/quality and viewport size, so this module's immediate job
 * is to carry the prepared buffer forward with correct mime/dimensions and
 * to detect when tiling or downsampling would be required.
 *
 * Actual pixel-level tiling/cropping lands in a later round (see the plan);
 * until then a single prepared image is returned. The function never throws
 * on an unrecognized image — it degrades to a pass-through with unknown
 * dimensions rather than failing a tool call.
 */

import type { PreparedImage } from './types.js'
import type { ScreenshotConfig, TilingConfig } from './types.js'
import { buildTilingPlan } from './tiling.js'

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
}

const BYTE = 256

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
 * Round 1: pass-through with correct mime and best-effort dimensions. The
 * function detects whether the image exceeds the configured cap and records
 * that (so callers/logs can warn), but does not yet crop or re-encode.
 *
 * @returns one prepared image (tiling will extend this to multiple).
 */
export function prepareScreenshot(
  input: Buffer,
  options: PrepareScreenshotOptions,
): PreparedImage[] {
  const mime = sniffMime(input)
  const { width, height } = parseImageDimensions(input)

  // Compute the tiling geometry. Pixel cropping is a codec concern (deferred);
  // the plan records whether the image would be split and how many tiles.
  const plan = buildTilingPlan({
    width,
    height,
    mode: options.tiling,
    thresholdWidth: options.thresholdWidth ?? 1200,
    thresholdHeight: options.thresholdHeight ?? 1200,
    overlap: options.overlap ?? 0,
  })

  const prepared: PreparedImage = {
    mime,
    data: input,
    width,
    height,
  }
  if (plan.needsTiling && plan.tiles.length > 0) {
    // The image exceeds the cap: carry the tile plan so a consuming vision
    // call can crop (when a codec is present) and mark the first block.
    prepared.tile = { index: plan.tiles[0]!.index, total: plan.tiles[0]!.total }
  }
  return [prepared]
}
