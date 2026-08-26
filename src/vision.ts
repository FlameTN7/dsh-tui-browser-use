/**
 * dsh-tui-browser-use — vision adapters.
 *
 * Turns a prepared screenshot into textual understanding by calling a
 * vision-capable model. Two transfer paths (proposal §5.4):
 *   - official DeepSeek: images ride the Files API (`file` → `file_id`
 *     reference)
 *   - OpenAI-compatible endpoints: images inline as base64 `image_url`
 *
 * The module is pure of harness state: the caller supplies a `VisionEnv`
 * (base URL, API key, model, transfer mode) that index.ts wires from
 * `ctx.get('settings')` / `ctx.get('credentials')`. No key is ever written
 * back or reported. Cost/token accounting is best-effort and always alongside
 * the result (never required for the tool to succeed).
 */

import type { ImageTransfer, PreparedImage, Usage, VisionMode } from './types.js'

/** Resolved vision request environment. */
export interface VisionEnv {
  /** Provider base URL, e.g. `https://api.deepseek.com`. */
  baseUrl: string
  /** API key; the harness reads it — never logged. */
  apiKey: string
  /** Vision-capable model id, e.g. `deepseek-v4-flash-vision-exp`. */
  model: string
  /** Transfer strategy resolved from capability detection. */
  imageTransfer: ImageTransfer
  /** The provider name (for capability fallback + diagnostics). */
  provider: string
  /** Current model route name. */
  currentModel: string
}

/** What a vision call returns. */
export interface VisionResult {
  insight: string
  usage: Usage
}

// ── Cost rate (per 1M tokens) ────────────────────────────────────────────
//
// DeepSeek's directory-cache pricing is far below the miss rate and its vision
// model (deepseek-v4-flash-vision-exp) prices the same as V4-Flash. Rather than
// hard-code one day's price, the rate is configurable via env vars
// (DSH_TUI_BROWSER_INPUT_RATE / _OUTPUT_RATE, USD per 1M tokens) and falls back
// to this default. Cache-hit pricing is a single `cacheHitRate` (USD per 1M).
const RATE_ENV = {
  input: 'DSH_TUI_BROWSER_INPUT_RATE',
  output: 'DSH_TUI_BROWSER_OUTPUT_RATE',
  cacheHit: 'DSH_TUI_BROWSER_CACHE_HIT_RATE',
} as const

// Default DeepSeek V4-Flash / vision prices (USD per 1M tokens). These are
// estimates from public pricing; deployments should override the env vars.
const DEFAULT_RATES = {
  input: 0.28,
  output: 0.42,
  cacheHit: 0.028,
} as const

type CostRates = { input: number; output: number; cacheHit: number }

function costRates(): CostRates {
  const num = (envName: string, fallback: number): number => {
    const v = process.env[envName]
    const n = v ? Number.parseFloat(v) : NaN
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  return {
    input: num(RATE_ENV.input, DEFAULT_RATES.input),
    output: num(RATE_ENV.output, DEFAULT_RATES.output),
    cacheHit: num(RATE_ENV.cacheHit, DEFAULT_RATES.cacheHit),
  }
}

/** Estimate token/cost for a set of images + text (best-effort). */
function estimateUsage(model: string, visionMode: VisionMode, imagesSent: number, textLength: number): Usage {
  // Rough approximation used only when the provider returns no usage block:
  // vision tokens ≈ 384/image (file_api), text tokens ≈ textLength/4.
  const imageTokens = imagesSent * 384
  const textTokens = Math.ceil(textLength / 4)
  const promptTokens = imageTokens + textTokens
  const completionTokens = Math.ceil(textLength / 8)
  const rates = costRates()
  const costUsd = (promptTokens * rates.input + completionTokens * rates.output) / 1_000_000
  const costCny = costUsd * 7.2
  return { model, visionMode, imagesSent, promptTokens, completionTokens, costUsd, costCny }
}

/** Compute cost (USD/CNY) from real prompt/completion token counts. */
function costFromUsage(promptTokens: number, completionTokens: number): { costUsd: number; costCny: number } {
  const rates = costRates()
  const costUsd = (promptTokens * rates.input + completionTokens * rates.output) / 1_000_000
  return { costUsd, costCny: costUsd * 7.2 }
}

/** One content block in a chat completions message. */
type ChatContent = Record<string, unknown>

function baseUrlOf(env: VisionEnv): string {
  return env.baseUrl.replace(/\/+$/, '')
}

// ── Retry (scnet is prone to 429; gateways intermittently return 5xx) ─────

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
const DEFAULT_MAX_RETRIES = 4
const DEFAULT_BASE_DELAY_MS = 600

/** Read `Retry-After` seconds (or an HTTP-date) from a response header, if sane. */
function retryAfterMs(resp: Response): number | null {
  const v = resp.headers.get('retry-after')
  if (!v) return null
  const secs = Number.parseInt(v, 10)
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000
  const date = Date.parse(v)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return null
}

/** Exponential backoff with jitter for one HTTP attempt. Returns false to stop. */
function backoffDelayMs(attempt: number, baseDelayMs: number, maxRetries: number): number {
  // attempt is 0-based for the failed request. Delay grows 600, 1200, 2400, ...
  const exp = Math.min(attempt, 8)
  const jitter = 0.5 + Math.random() * 0.5 // 0.5..1.0 multiplier
  return Math.min(baseDelayMs * 2 ** exp, 10_000) * jitter
}

/**
 * Perform a fetch that retries on retryable statuses (429 / 5xx) with
 * exponential backoff + jitter. Non-retryable but failed responses surface
 * immediately. `maxRetries` is 0 to disable.
 */
async function fetchWithRetry(url: string, init: RequestInit, maxRetries = DEFAULT_MAX_RETRIES): Promise<Response> {
  let attempt = 0
  // A fetch network error (connection refused / DNS) is also worth retrying once.
  for (;;) {
    let resp: Response
    try {
      resp = await fetch(url, init)
    } catch (err) {
      if (attempt >= maxRetries) throw err
      await new Promise((r) => setTimeout(r, backoffDelayMs(attempt, DEFAULT_BASE_DELAY_MS, maxRetries)))
      attempt += 1
      continue
    }
    if (resp.ok || !RETRYABLE_STATUS.has(resp.status) || attempt >= maxRetries) {
      return resp
    }
    const delay = retryAfterMs(resp) ?? backoffDelayMs(attempt, DEFAULT_BASE_DELAY_MS, maxRetries)
    await new Promise((r) => setTimeout(r, delay))
    attempt += 1
  }
}

/**
 * Parse a JSON response body robustly, tolerating an empty or non-JSON body.
 */
async function parseJsonRobust(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json().catch(() => ({}))) as Record<string, unknown>
}

/** Upload one image to the DeepSeek Files API and return its `file_id`. */
async function uploadFile(env: VisionEnv, image: PreparedImage, baseUrl: string): Promise<string> {
  const form = new FormData()
  const ext = image.mime.split('/')[1] ?? 'jpeg'
  form.append('purpose', 'user_data')
  form.append('file', new Blob([image.data], { type: image.mime }), `shot-${Date.now()}.${ext}`)
  const resp = await fetchWithRetry(`${baseUrl}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.apiKey}` },
    body: form,
  })
  const body = await parseJsonRobust(resp) as { id?: string; file_id?: string; error?: { message?: string } }
  if (!resp.ok) {
    throw new Error(`file upload failed (${resp.status}): ${body.error?.message ?? 'unknown'}`)
  }
  const fileId = body.id ?? body.file_id
  if (!fileId) throw new Error('file upload returned no id')
  return fileId
}

/**
 * Build the chat completions request for a set of images.
 * For `file` transfers the images are uploaded first and referenced by
 * `file_id`. For `base64` they are inlined. Images only ever appear in a
 * `user` message (proposal §5.4.3).
 */
async function chatWithImages(env: VisionEnv, images: PreparedImage[], instruction: string): Promise<{ text: string; usage: Usage }> {
  if (!env.apiKey) {
    throw new Error('vision.apiKey missing')
  }
  const baseUrl = baseUrlOf(env)
  const content: ChatContent[] = []

  for (const image of images) {
    if (env.imageTransfer === 'file') {
      const fileId = image.fileId ?? (await uploadFile(env, image, baseUrl))
      // Persist the uploaded id on the image so callers (browser_screenshot)
      // can surface it as `fileId` instead of always seeing ''.
      image.fileId = fileId
      content.push({ type: 'file', file_id: fileId })
    } else if (env.imageTransfer === 'base64' || env.imageTransfer === 'url') {
      const mime = image.mime
      const dataUrl = `data:${mime};base64,${image.data.toString('base64')}`
      content.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } })
    } else {
      throw new Error('provider does not support image transfer')
    }
  }
  if (instruction) {
    content.push({ type: 'text', text: instruction })
  }

  const messages = [
    {
      role: 'system',
      content: 'You are the vision model for a browser automation agent. Read the screenshot(s) precisely and answer the instruction. Treat tiled images as one page split into labeled blocks: read them together. Never invent content you cannot see.',
    },
    { role: 'user', content },
  ]

  const resp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.apiKey}`,
    },
    body: JSON.stringify({ model: env.model, messages, temperature: 0 }),
  })
  const body = await parseJsonRobust(resp) as {
    choices?: Array<{ message?: { content?: unknown } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
    error?: { message?: string }
  }
  if (!resp.ok) {
    throw new Error(`chat/completions failed (${resp.status}): ${body.error?.message ?? 'unknown'}`)
  }
  const raw = body.choices?.[0]?.message?.content
  const text = Array.isArray(raw) ? raw.map((b) => (b as { text?: string })?.text ?? '').join('') : (typeof raw === 'string' ? raw : '')

  const usage: Usage = {
    model: env.model,
    visionMode: env.imageTransfer === 'file' ? 'deepseek-file-api' : 'auto',
    imagesSent: images.length,
    promptTokens: body.usage?.prompt_tokens ?? 0,
    completionTokens: body.usage?.completion_tokens ?? 0,
    costUsd: 0,
    costCny: 0,
  }
  if (body.usage) {
    // Real token counts → compute cost against the configured rates so the
    // agent sees an actual (not placeholder) spend on browser_task.
    const c = costFromUsage(usage.promptTokens, usage.completionTokens)
    usage.costUsd = c.costUsd
    usage.costCny = c.costCny
  } else {
    // Fall back to the estimate so callers always see a usage block.
    const est = estimateUsage(env.model, usage.visionMode, images.length, text.length)
    usage.promptTokens = est.promptTokens
    usage.completionTokens = est.completionTokens
    usage.costUsd = est.costUsd
    usage.costCny = est.costCny
  }
  return { text, usage }
}

/**
 * Analyze one or more prepared images against the current provider.
 * Returns the textual insight (may be empty) plus usage accounting.
 */
export async function analyzeImages(env: VisionEnv, images: PreparedImage[], instruction?: string): Promise<VisionResult> {
  // The caller has already resolved the transfer mode (user override > built-in
  // table > model-name fallback). `none` means the provider can't see images.
  if (env.imageTransfer === 'none') {
    throw new Error('vision-unavailable')
  }
  try {
    const { text, usage } = await chatWithImages(env, images, instruction ?? '')
    return { insight: text, usage }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'vision-unavailable') throw err
    throw new Error(`vision call failed: ${msg}`)
  }
}
