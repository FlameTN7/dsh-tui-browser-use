/**
 * dsh-tui-browser-use — vision entrance.
 *
 * Turns a prepared screenshot into textual understanding by calling a
 * vision-capable model. The provider-specific transfer (DeepSeek Files-API vs
 * OpenAI-compatible base64/url) is isolated behind a `VisionAdapter`; this
 * module is a thin facade that resolves the adapter from the image-transfer
 * mode and delegates. Prompt-injection fencing, retry/backoff and cost/token
 * accounting live in `vision/shared.ts` and the adapters.
 *
 * The module is pure of harness state: the caller supplies a `VisionEnv`
 * (base URL, API key, model, transfer mode) that index.ts wires from
 * `ctx.get('settings')` / `ctx.get('credentials')`. No key is ever written
 * back or reported. Cost/token accounting is best-effort and always alongside
 * the result (never required for the tool to succeed).
 */
import type { ImageTransfer, PreparedImage, Usage } from './types.js';
import type { RuntimeEnv } from './runtime-env.js';
/** Resolved vision request environment. */
export interface VisionEnv {
    /** Provider base URL, e.g. `https://api.deepseek.com`. */
    baseUrl: string;
    /** API key; the harness reads it — never logged. */
    apiKey: string;
    /** Vision-capable model id, e.g. `deepseek-v4-flash-vision-exp`. */
    model: string;
    /** Transfer strategy resolved from capability detection. */
    imageTransfer: ImageTransfer;
    /** The provider name (for capability fallback + diagnostics). */
    provider: string;
    /** Override for the capture byte budget (from providers[].maxImageBytes). */
    maxImageBytes?: number;
}
/** What a vision call returns. */
export interface VisionResult {
    insight: string;
    usage: Usage;
}
/**
 * Analyze one or more prepared images against the current provider.
 * Returns the textual insight (may be empty) plus usage accounting.
 */
export declare function analyzeImages(env: VisionEnv, images: PreparedImage[], instruction?: string, signal?: AbortSignal, runtimeEnv?: RuntimeEnv): Promise<VisionResult>;
//# sourceMappingURL=vision.d.ts.map