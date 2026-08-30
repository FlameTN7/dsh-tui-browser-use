/**
 * dsh-tui-browser-use — OpenAI-compatible vision adapter.
 *
 * Inlines prepared images as base64 `image_url` content blocks (detail locked to
 * `high`). Used for any non-DeepSeek route (gpt-4o / gpt-5 / claude / gemini /
 * a generic OpenAI-compatible gateway). Prompt fencing, retry/backoff and
 * cost/token accounting are shared (`vision/shared.ts`).
 */

import type { PreparedImage } from '../types.js'
import type { RuntimeEnv } from '../runtime-env.js'
import type { VisionEnvLike } from './shared.js'
import { buildSystemPrompt, performChat, buildUserContent } from './shared.js'
import type { VisionAdapter, VisionAdapterResult } from './vision-adapter.js'

export class OpenAiCompatAdapter implements VisionAdapter {
  constructor(
    private readonly env: VisionEnvLike,
    private readonly runtimeEnv: RuntimeEnv,
  ) {}

  async analyze(images: PreparedImage[], instruction?: string, signal?: AbortSignal): Promise<VisionAdapterResult> {
    const content: Array<Record<string, unknown>> = []
    for (const image of images) {
      const mime = image.mime
      const dataUrl = `data:${mime};base64,${image.data.toString('base64')}`
      content.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } })
    }
    const userContent = buildUserContent(content, instruction ?? '')
    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: userContent },
    ]
    const { text, usage } = await performChat(this.env, this.runtimeEnv, messages, images.length, signal)
    return { insight: text, usage }
  }
}
