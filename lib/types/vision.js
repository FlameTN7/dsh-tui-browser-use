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
import { loadRuntimeEnv } from './runtime-env.js';
import { createVisionAdapter } from './vision/vision-adapter.js';
/**
 * Analyze one or more prepared images against the current provider.
 * Returns the textual insight (may be empty) plus usage accounting.
 */
export async function analyzeImages(env, images, instruction, signal, runtimeEnv) {
    // The caller has already resolved the transfer mode (user override > built-in
    // table > model-name fallback). `none` means the provider can't see images,
    // which short-circuits before any transport work (P1-08).
    if (env.imageTransfer === 'none') {
        // Attach `code` so the tool-level `fail()` maps it to the protocol error
        // `[vision-unavailable]` instead of a generic `[browser-error]`.
        throw Object.assign(new Error('vision-unavailable'), { code: 'vision-unavailable' });
    }
    try {
        const adapter = createVisionAdapter(env, runtimeEnv ?? loadRuntimeEnv());
        const { insight, usage } = await adapter.analyze(images, instruction, signal);
        return { insight, usage };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'vision-unavailable')
            throw err;
        throw new Error(`vision call failed: ${msg}`);
    }
}
//# sourceMappingURL=vision.js.map