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
import type { BrowserUseConfig, ImageTransfer, ProviderCapability, ProviderOverride } from './types.js';
/**
 * Whether a provider route + model id actually accepts image input. Used by
 * the vision resolver to degrade a text-only model (e.g. `deepseek-v4-flash`)
 * to DOM fallback instead of sending it a screenshot it cannot read.
 * Explicit ids win, then the name fallback (`vision|vl|visual`).
 */
export declare function isVisionCapableModel(_provider: string, model: string): boolean;
/** Normalize a `widthxheight` string into a `{ width, height }` pair. */
export declare function parseDimension(dim: string): {
    width: number;
    height: number;
};
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
export declare function effectiveViewport(config: Pick<BrowserUseConfig, 'viewport' | 'screenshot'>): {
    width: number;
    height: number;
};
/**
 * Resolve the image-transfer strategy for a model route. `supportsVision`
 * is derived from the same chain; callers that only need the transfer mode
 * can ignore it (but typically both are read together).
 */
export declare function detectCapability(provider: string, model: string, overrides: readonly ProviderOverride[]): ProviderCapability;
/**
 * Convenience wrapper returning only the image-transfer mode. Most callers
 * want the full capability, so prefer {@link detectCapability}; this exists
 * for the smoke fixture and simple checks.
 */
export declare function detectImageTransfer(provider: string, model: string, overrides: readonly ProviderOverride[]): ImageTransfer;
//# sourceMappingURL=capabilities.d.ts.map