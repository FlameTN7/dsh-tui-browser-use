/**
 * dsh-tui-browser-use — large-image tiling geometry.
 *
 * Computes whether a screenshot exceeds the configured threshold and, when it
 * does, produces a deterministic set of tile crops (width×height, with
 * configurable-pixel overlap). The module is pure geometry — it never decodes
 * or re-encodes pixels. The vision pipeline consumes the returned regions to
 * split a large capture into readable blocks; an encoder (e.g. the browser's
 * canvas, or a codec dependency) performs the actual cropping.
 *
 * Tile regions are normalized to the source image bounds and deduplicated so a
 * small overflow never produces a degenerate single-tile sequence.
 */

export interface TileRegion {
  index: number
  total: number
  x: number
  y: number
  width: number
  height: number
}

export interface TilingPlan {
  /** Whether the source exceeds the threshold and needs splitting. */
  needsTiling: boolean
  tileWidth: number
  tileHeight: number
  overlap: number
  /** The crop regions, in reading order; empty when `needsTiling` is false. */
  tiles: TileRegion[]
}

export interface TilingInput {
  width: number
  height: number
  /** Tiling mode: 'auto'|'on'|'off'. */
  mode: 'auto' | 'on' | 'off'
  /** Effective tile size (falls back to defaults when the mode is 'on'). */
  thresholdWidth: number
  thresholdHeight: number
  /** Overlap in pixels between adjacent tiles. */
  overlap: number
}

const DEFAULT_TILE_W = 1200
const DEFAULT_TILE_H = 1200
const DEFAULT_OVERLAP = 60

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * Build a tiling plan for a source image. `mode:'off'` returns
 * `needsTiling:false`. `mode:'auto'` tiles only when the image exceeds the
 * threshold; `mode:'on'` always tiles when the image is larger than one tile.
 */
export function buildTilingPlan(input: TilingInput): TilingPlan {
  const thresholdW = input.thresholdWidth > 0 ? input.thresholdWidth : DEFAULT_TILE_W
  const thresholdH = input.thresholdHeight > 0 ? input.thresholdHeight : DEFAULT_TILE_H
  const overlap = clamp(input.overlap || DEFAULT_OVERLAP, 0, Math.min(thresholdW, thresholdH) - 1)

  if (input.mode === 'off' || input.width <= 0 || input.height <= 0) {
    return { needsTiling: false, tileWidth: thresholdW, tileHeight: thresholdH, overlap, tiles: [] }
  }

  const needs = input.width > thresholdW || input.height > thresholdH
  if (input.mode === 'auto' && !needs) {
    return { needsTiling: false, tileWidth: thresholdW, tileHeight: thresholdH, overlap, tiles: [] }
  }

  const cols = Math.max(1, Math.ceil((input.width - overlap) / (thresholdW - overlap)))
  const rows = Math.max(1, Math.ceil((input.height - overlap) / (thresholdH - overlap)))

  const tiles: TileRegion[] = []
  let index = 0
  for (let row = 0; row < rows; row += 1) {
    const y = row === 0 ? 0 : clamp(row * (thresholdH - overlap), 0, Math.max(0, input.height - thresholdH))
    for (let col = 0; col < cols; col += 1) {
      const x = col === 0 ? 0 : clamp(col * (thresholdW - overlap), 0, Math.max(0, input.width - thresholdW))
      const w = Math.min(thresholdW, input.width - x)
      const h = Math.min(thresholdH, input.height - y)
      if (w > 0 && h > 0) {
        index += 1
        tiles.push({ index, total: 1, x, y, width: w, height: h })
      }
    }
  }
  const total = tiles.length
  for (const t of tiles) t.total = total

  return { needsTiling: total > 1, tileWidth: thresholdW, tileHeight: thresholdH, overlap, tiles }
}

/** Convenience: does this image exceed the threshold under the given mode? */
export function shouldTile(input: TilingInput): boolean {
  return buildTilingPlan(input).needsTiling
}
