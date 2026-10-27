/**
 * dsh-tui-browser-use — DeepSeek Files-API vision adapter.
 *
 * Uploads prepared images to the DeepSeek Files API and references them by
 * `file_id` so repeated identical screenshots hit the provider's disk cache
 * (a stable `file_id` in the prompt prefix). Reuses one `file_id` per distinct
 * image payload via a per-endpoint/provider/model cache. Prompt fencing,
 * retry/backoff and cost/token accounting are shared (`vision/shared.ts`).
 */
import type { PreparedImage } from '../types.js';
import type { RuntimeEnv } from '../runtime-env.js';
import type { VisionEnvLike } from './shared.js';
import type { VisionAdapter, VisionAdapterResult } from './vision-adapter.js';
export declare class DeepSeekFileAdapter implements VisionAdapter {
    private readonly env;
    private readonly runtimeEnv;
    constructor(env: VisionEnvLike, runtimeEnv: RuntimeEnv);
    /** Upload one image to the DeepSeek Files API and return its `file_id`. */
    private uploadFile;
    private reusableFileId;
    analyze(images: PreparedImage[], instruction?: string, signal?: AbortSignal): Promise<VisionAdapterResult>;
}
//# sourceMappingURL=deepseek-file-adapter.d.ts.map