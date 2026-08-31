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

import type { BrowserUseConfig, ImageTransfer, ProviderCapability, ProviderOverride } from './types.js'

/**
 * Built-in capability table for known providers. Each entry carries the
 * transfer/detail defaults for the provider plus a model-family predicate that
 * decides whether a specific model id accepts image input. This is what lets a
 * vision-capable-but-not-"vision"-named model (e.g. `gpt-5`, `claude-4-5-sonet`,
 * `gemini-3.1-pro`) be detected correctly, while a text-only model on the same
 * route (e.g. `deepseek-v4-flash`) still short-circuits to DOM.
 */
const BUILTIN: Record<string, { imageTransfer: ImageTransfer; detail: 'high'; visionFor: (model: string) => boolean }> = {
  // Official DeepSeek: images ride the Files API. Only the vision/glyph-capable
  // DeepSeek models accept images; a text-only model MUST short-circuit to DOM
  // (AGENTS.md §6).
  deepseek: {
    imageTransfer: 'file',
    detail: 'high',
    visionFor: (m) => /vision|vl|visual/i.test(m) || VISION_MODEL_IDS.has(m.trim()),
  },
  // OpenAI-compatible endpoints commonly accept base64 image_url. Modern
  // multimodal families (gpt-4o*, gpt-4.1*, gpt-5*, o4*) don't carry "vision".
  openai: {
    imageTransfer: 'base64',
    detail: 'high',
    visionFor: (m) => /^(gpt-4o|gpt-4\.1|gpt-5|o[134])/i.test(m.trim()),
  },
  anthropic: {
    imageTransfer: 'base64',
    detail: 'high',
    visionFor: (m) => /^claude-[34]/i.test(m.trim()),
  },
  google: {
    imageTransfer: 'base64',
    detail: 'high',
    visionFor: (m) => /^gemini/i.test(m.trim()),
  },
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

/**
 * Resolve the effective viewport for a config. Prefers the explicit `viewport`
 * config; falls back to the deprecated `screenshot.maxDimension` alias (kept for
 * older configs / test scripts); otherwise the 1024×768 default.
 *
 * This is the single source of truth for the real browser viewport, so
 * scrolling/tiling stepping in `BrowserSession.captureSegments()` and the tool
 * prepare options always match the viewport the live page actually uses (fixes
 * the "viewport changed in /settings but tiling still steps by maxDimension"
 * inconsistency).
 */
export function effectiveViewport(
  config: Pick<BrowserUseConfig, 'viewport' | 'screenshot'>,
): { width: number; height: number } {
  const v = config.viewport
  if (v && Number.isFinite(v.width) && Number.isFinite(v.height) && v.width > 0 && v.height > 0) {
    return { width: v.width, height: v.height }
  }
  const dim = parseDimension(config.screenshot.maxDimension)
  if (dim.width > 0 && dim.height > 0) return dim
  return { width: 1024, height: 768 }
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
      // `low` is prohibited for page screenshots (proposal §5.5); the schema no
      // longer accepts it and every adapter pins `detail:'high'`.
      detail: 'high',
    }
  }

  // 2. Provider declaration would live here (a provider service API). We
  //    don't reach into harness services from this pure module, so this step
  //    currently defers to the built-in table and model-name fallback.

  // 3. Built-in table: per-provider transfer/detail + model-family vision gate.
  const builtin = BUILTIN[name]
  if (builtin) {
    return {
      provider: name,
      supportsVision: builtin.visionFor(modelName),
      imageTransfer: builtin.imageTransfer,
      detail: builtin.detail,
    }
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
