/**
 * dsh-tui-browser-use — DeepSeek Files-API vision adapter.
 *
 * Uploads prepared images to the DeepSeek Files API and references them by
 * `file_id` so repeated identical screenshots hit the provider's disk cache
 * (a stable `file_id` in the prompt prefix). Reuses one `file_id` per distinct
 * image payload via a per-endpoint/provider/model cache. Prompt fencing,
 * retry/backoff and cost/token accounting are shared (`vision/shared.ts`).
 */

import { createHash } from 'node:crypto'
import type { PreparedImage } from '../types.js'
import type { RuntimeEnv } from '../runtime-env.js'
import { FileIdCache, fileIdScopeKey } from '../file-id-cache.js'
import type { VisionEnvLike } from './shared.js'
import {
  buildSystemPrompt, performChat, buildUserContent,
  fetchWithRetry, parseJsonRobust, fileExpiresSeconds, DEFAULT_MAX_RETRIES, baseUrlOf,
} from './shared.js'
import type { VisionAdapter, VisionAdapterResult } from './vision-adapter.js'

/** Reuse one file_id per distinct image payload (scoped by endpoint/provider/model). */
const fileIdCache = new FileIdCache()

export class DeepSeekFileAdapter implements VisionAdapter {
  constructor(
    private readonly env: VisionEnvLike,
    private readonly runtimeEnv: RuntimeEnv,
  ) {}

  /** Upload one image to the DeepSeek Files API and return its `file_id`. */
  private async uploadFile(image: PreparedImage, baseUrl: string, signal?: AbortSignal): Promise<string> {
    const form = new FormData()
    const ext = image.mime.split('/')[1] ?? 'jpeg'
    form.append('purpose', 'user_data')
    form.append('file', new Blob([image.data], { type: image.mime }), `shot-${Date.now()}.${ext}`)
    const expires = fileExpiresSeconds(this.runtimeEnv)
    if (expires !== null) {
      form.append('expires_after[anchor]', 'created_at')
      form.append('expires_after[seconds]', String(expires))
    }
    const resp = await fetchWithRetry(`${baseUrl}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.env.apiKey}` },
      body: form,
    }, DEFAULT_MAX_RETRIES, signal)
    const body = await parseJsonRobust(resp) as { id?: string; file_id?: string; error?: { message?: string } }
    if (!resp.ok) {
      throw new Error(`file upload failed (${resp.status}): ${body.error?.message ?? 'unknown'}`)
    }
    const fileId = body.id ?? body.file_id
    if (!fileId) throw new Error('file upload returned no id')
    return fileId
  }

  private async reusableFileId(image: PreparedImage, baseUrl: string, signal?: AbortSignal): Promise<string> {
    if (image.fileId) return image.fileId
    const hash = createHash('sha256').update(image.data).digest('hex')
    const scopeKey = fileIdScopeKey(baseUrl, this.env.provider, this.env.model, this.env.apiKey)
    const hit = fileIdCache.get(scopeKey, hash)
    if (hit) {
      image.fileId = hit
      return hit
    }
    const fileId = await this.uploadFile(image, baseUrl, signal)
    image.fileId = fileId
    fileIdCache.set(scopeKey, hash, fileId)
    return fileId
  }

  async analyze(images: PreparedImage[], instruction?: string, signal?: AbortSignal): Promise<VisionAdapterResult> {
    const baseUrl = baseUrlOf(this.env)
    const content: Array<Record<string, unknown>> = []
    for (const image of images) {
      const fileId = await this.reusableFileId(image, baseUrl, signal)
      // Persist the uploaded id on the image so callers (browser_screenshot) can
      // surface it as `fileId` instead of always seeing ''.
      content.push({ type: 'file', file_id: fileId })
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
