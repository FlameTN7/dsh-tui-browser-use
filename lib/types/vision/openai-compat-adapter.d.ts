/**
 * dsh-tui-browser-use — OpenAI-compatible vision adapter.
 *
 * Inlines prepared images as base64 `image_url` content blocks (detail locked to
 * `high`). Used for any non-DeepSeek route (gpt-4o / gpt-5 / claude / gemini /
 * a generic OpenAI-compatible gateway). Prompt fencing, retry/backoff and
 * cost/token accounting are shared (`vision/shared.ts`).
 */
import type { PreparedImage } from '../types.js';
import type { RuntimeEnv } from '../runtime-env.js';
import type { VisionEnvLike } from './shared.js';
import type { VisionAdapter, VisionAdapterResult } from './vision-adapter.js';
export declare class OpenAiCompatAdapter implements VisionAdapter {
    private readonly env;
    private readonly runtimeEnv;
    constructor(env: VisionEnvLike, runtimeEnv: RuntimeEnv);
    analyze(images: PreparedImage[], instruction?: string, signal?: AbortSignal): Promise<VisionAdapterResult>;
}
//# sourceMappingURL=openai-compat-adapter.d.ts.map