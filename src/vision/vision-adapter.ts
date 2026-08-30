/**
 * dsh-tui-browser-use — vision adapter contract.
 *
 * AGENTS.md §2 / 竞品 B2: isolates the provider-specific transfer (DeepSeek
 * Files-API vs OpenAI-compatible base64/url) behind a single `analyze` method so
 * the tool registries and prompt/usage accounting never branch on the transport.
 * The factory selects the implementation from the resolved `imageTransfer`.
 */

import type { PreparedImage, Usage } from '../types.js'
import type { RuntimeEnv } from '../runtime-env.js'
import type { VisionEnvLike } from './shared.js'
import { DeepSeekFileAdapter } from './deepseek-file-adapter.js'
import { OpenAiCompatAdapter } from './openai-compat-adapter.js'

/** The result shape every adapter returns (matches `VisionResult`). */
export interface VisionAdapterResult {
  insight: string
  usage: Usage
}

/** A vision transport: turns prepared images into textual understanding. */
export interface VisionAdapter {
  /**
   * Analyze one or more prepared images against the bound provider.
   * Returns the textual insight (may be empty) plus usage accounting.
   */
  analyze(images: PreparedImage[], instruction?: string, signal?: AbortSignal): Promise<VisionAdapterResult>
}

/**
 * Build the adapter for a resolved vision environment. `env.imageTransfer`
 * selects the transport:
 *   - `file`  → DeepSeek Files-API (upload + `file_id` reference)
 *   - `base64`/`url` → OpenAI-compatible inline `image_url`
 *   - `none`  → the provider can't see images (throws `vision-unavailable`)
 */
export function createVisionAdapter(env: VisionEnvLike, runtimeEnv: RuntimeEnv): VisionAdapter {
  if (env.imageTransfer === 'none') {
    // A `none` transfer is the capability-detected "no vision" case. Throwing
    // the canonical error lets the caller short-circuit (analyzeImages treats it
    // as vision-unavailable rather than a transport failure).
    throw new Error('vision-unavailable')
  }
  if (env.imageTransfer === 'file') {
    return new DeepSeekFileAdapter(env, runtimeEnv)
  }
  // base64 / url → OpenAI-compatible inline transfer (detail locked to high).
  return new OpenAiCompatAdapter(env, runtimeEnv)
}
