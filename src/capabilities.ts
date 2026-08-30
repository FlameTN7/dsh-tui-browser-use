/**
 * dsh-tui-browser-use — provider vision-capability detection.
 *
 * Decides, per model route, whether the vision path is usable and how a
 * screenshot is transferred. Resolution priority (proposal §5.1):
 *
 *   1. user config (`providers[]` override)
 *   2. provider declaration (the provider service's own capability)
 *   3. built-in capability table
 *   4. model-name fallback (`vision` in the name)
 *
 * This module is pure: it never touches the network or reads harness state.
 * The caller (index.ts / vision.ts) supplies the resolved provider name,
 * model name, and the user-declared overrides.
 */

import type { ImageTransfer, ProviderCapability, ProviderOverride } from './types.js'

/** Built-in capability table for known providers. */
const BUILTIN: Record<string, { supportsVision: boolean; imageTransfer: ImageTransfer; detail: 'high' | 'low' }> = {
  // Official DeepSeek with a vision model: images ride the Files API.
  deepseek: { supportsVision: true, imageTransfer: 'file', detail: 'high' },
  // OpenAI-compatible endpoints commonly accept base64 image_url.
  openai: { supportsVision: true, imageTransfer: 'base64', detail: 'high' },
  anthropic: { supportsVision: true, imageTransfer: 'base64', detail: 'high' },
  google: { supportsVision: true, imageTransfer: 'base64', detail: 'high' },
}

/**
 * Multi-modal model ids that do NOT carry a `vision|vl|visual` name hint but
 * are in fact vision-capable. Kept explicit so the name-based fallback below
 * doesn't misclassify them as text-only.
 */
const VISION_MODEL_IDS = new Set(['deepseek-vl'])

/**
 * Whether a provider route + model id actually accepts image input. Used by
 * the vision resolver to degrade a text-only model (e.g. `deepseek-v4-flash`)
 * to DOM fallback instead of sending it a screenshot it cannot read.
 * Explicit ids win, then the name fallback (`vision|vl|visual`).
 */
export function isVisionCapableModel(_provider: string, model: string): boolean {
  const modelName = (model || '').trim()
  if (VISION_MODEL_IDS.has(modelName)) return true
  return /vision|vl|visual/i.test(modelName)
}

/** Normalize a `widthxheight` string into a `{ width, height }` pair. */
export function parseDimension(dim: string): { width: number; height: number } {
  const [w = 0, h = 0] = dim.toLowerCase().split('x').map((s) => Number.parseInt(s.trim(), 10))
  return { width: Number.isFinite(w) ? w : 0, height: Number.isFinite(h) ? h : 0 }
}

/** Find a user-declared override matching the provider name. */
function findOverride(provider: string, overrides: readonly ProviderOverride[]): ProviderOverride | undefined {
  const norm = provider.trim().toLowerCase()
  return overrides.find((o) => o.provider.trim().toLowerCase() === norm)
}

/**
 * Resolve the image-transfer strategy for a model route. `supportsVision`
 * is derived from the same chain; callers that only need the transfer mode
 * can ignore it (but typically both are read together).
 */
export function detectCapability(
  provider: string,
  model: string,
  overrides: readonly ProviderOverride[],
): ProviderCapability {
  const name = provider.trim() || 'unknown'
  const modelName = model.trim() || ''

  // 1. User override wins.
  const override = findOverride(name, overrides)
  if (override) {
    return {
      provider: name,
      supportsVision: override.supportsVision,
      imageTransfer: override.imageTransfer,
      ...(override.maxImageBytes !== undefined ? { maxImageBytes: override.maxImageBytes } : {}),
      detail: override.detailPreference === 'low' ? 'low' : 'high',
    }
  }

  // 2. Provider declaration would live here (a provider service API). We
  //    don't reach into harness services from this pure module, so this step
  //    currently defers to the built-in table and model-name fallback.

  // 3. Built-in table.
  const builtin = BUILTIN[name]
  if (builtin) {
    return { provider: name, ...builtin }
  }

  // 4. Model-name fallback: a model whose name advertises vision.
  if (/vision|vl|visual/i.test(modelName)) {
    return { provider: name, supportsVision: true, imageTransfer: 'base64', detail: 'high' }
  }

  // Default: no vision.
  return { provider: name, supportsVision: false, imageTransfer: 'none', detail: 'high' }
}

/**
 * Convenience wrapper returning only the image-transfer mode. Most callers
 * want the full capability, so prefer {@link detectCapability}; this exists
 * for the smoke fixture and simple checks.
 */
export function detectImageTransfer(
  provider: string,
  model: string,
  overrides: readonly ProviderOverride[],
): ImageTransfer {
  return detectCapability(provider, model, overrides).imageTransfer
}
