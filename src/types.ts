/**
 * dsh-tui-browser-use — shared types and protocol contracts.
 *
 * The plugin exposes a versioned browser-tool family (`browser.dsh-tui/v1alpha1`)
 * to the agent. Every tool returns a unified result envelope (§4 of the
 * proposal). This module owns the type-level shape; runtime behavior lives in
 * the sibling modules (browser, capabilities, image-pipeline, vision, tools).
 */

// ── Result envelope ──────────────────────────────────────────────────────

/** Canonical error codes for the browser-use tool family. */
export type ErrorCode =
  | 'browser-error'
  | 'vision-unavailable'
  | 'provider-unsupported'
  | 'schema-validation-failed'
  | 'timed-out'
  | 'not-implemented'

/** Usage accounting emitted when a tool performs a vision model call. */
export interface Usage {
  /** Model that produced the visual insight. */
  model: string
  /** Effective vision mode for that call. */
  visionMode: VisionMode
  /** Number of images actually sent to the model. */
  imagesSent: number
  promptTokens: number
  completionTokens: number
  costUsd: number
  costCny: number
}

/** Successful branch of the unified result envelope. */
export interface SuccessEnvelope<T = unknown> {
  ok: true
  value: T
  usage?: Usage
}

/** Failure branch of the unified result envelope. */
export interface FailureEnvelope {
  ok: false
  error: {
    code: ErrorCode
    message: string
  }
}

/** Unified envelope returned by every `browser.*` tool. */
export type ResultEnvelope<T = unknown> = SuccessEnvelope<T> | FailureEnvelope

// ── Config ───────────────────────────────────────────────────────────────

/** How the plugin decides to use vision. */
export type VisionMode = 'auto' | 'on' | 'off' | 'deepseek-file-api'

/** How a screenshot is transferred to the model. */
export type ImageTransfer = 'file' | 'base64' | 'url' | 'none'

/** Accepted screenshot output formats. */
export type ScreenshotFormat = 'jpeg' | 'webp' | 'png'

/** Tiling mode. */
export type TilingMode = 'auto' | 'on' | 'off'

/** Per-provider capability override. */
export interface ProviderOverride {
  /** Provider id, matched against `settings.describe()` / the model route. */
  provider: string
  /** Whether this provider can accept image content. */
  supportsVision: boolean
  /** How to transfer an image to this provider. */
  imageTransfer: ImageTransfer
  /** Optional maximum image payload size in bytes. */
  maxImageBytes?: number
  /** Preferred detail level; `auto` defers to the pipeline default (high). */
  detailPreference?: 'high' | 'low' | 'auto'
}

/** Screenshot configuration block. */
export interface ScreenshotConfig {
  format: ScreenshotFormat
  /** JPEG/WebP quality, 1-100. */
  quality: number
  /** `width×height` string, e.g. `1024x768`. */
  maxDimension: string
}

/** Tiling configuration block. */
export interface TilingConfig {
  mode: TilingMode
  /** `width×height` string, e.g. `1200x1200`. */
  threshold: string
  /** Tile overlap in pixels. */
  overlap: number
}

/** Plugin config, validated by the Schemastery `Config` schema in index.ts. */
export interface BrowserUseConfig {
  visionMode: VisionMode
  screenshot: ScreenshotConfig
  tiling: TilingConfig
  providers: ProviderOverride[]
}

// ── Tool contracts ───────────────────────────────────────────────────────

/** `browser.navigate` parameters. */
export interface NavigateParams {
  url: string
}

/** `browser.navigate` result. */
export interface NavigateResult {
  title: string
  url: string
  status: number | null
}

/** `browser.screenshot` parameters. */
export interface ScreenshotParams {
  /** Optional instruction the vision model should focus on. */
  instruction?: string
}

/** `browser.screenshot` result. */
export interface ScreenshotResult {
  /** The vision model's textual understanding of the screenshot. */
  visualInsight: string
  /** A compact list of visible interactive elements (links/buttons/inputs). */
  elementSummary: string
  /** DeepSeek file_api `file_id` when the official file path was used. */
  fileId: string
}

/** `browser.click` parameters. */
export interface ClickParams {
  /** CSS selector. Mutually exclusive with `text`. */
  selector?: string
  /** Visible text to locate the element. Mutually exclusive with `selector`. */
  text?: string
}

/** `browser.click` result. */
export interface ClickResult {
  success: boolean
  newUrl: string
}

/** `browser.type` parameters. */
export interface TypeParams {
  selector: string
  text: string
}

/** `browser.type` result. */
export interface TypeResult {
  success: boolean
}

/** `browser.evaluate` parameters. */
export interface EvaluateParams {
  expression: string
}

/** `browser.evaluate` result. */
export interface EvaluateResult {
  result: unknown
}

/** `browser.extract` parameters. */
export interface ExtractParams {
  /** JSON Schema the extracted data must satisfy. */
  schema: Record<string, unknown>
  /** Optional visual instruction for the vision model. */
  instruction?: string
}

/** `browser.extract` result. */
export interface ExtractResult {
  data: unknown
}

/** `browser.task` parameters. */
export interface TaskParams {
  instruction: string
  /** Maximum number of vision-driven actions (default 8, capped at 16). */
  maxSteps?: number
}

/** `browser.task` result. */
export interface TaskResult {
  answer: string
  steps: number
  durationS: number
  cost: { usd: number; cny: number }
}

/** `browser.status` result. */
export interface StatusResult {
  available: boolean
  version: string
  config: BrowserUseConfig
}

// ── Vision pipeline shared types ─────────────────────────────────────────

/** A prepared image ready to be sent to a vision model. */
export interface PreparedImage {
  /** Mime type, e.g. `image/jpeg`. */
  mime: string
  /** Base64-encoded payload (inline / file-upload source). */
  data: Buffer
  /** DeepSeek file_api upload id, populated after a `file` transfer uploads. */
  fileId?: string
  /** Tile label when this image is part of a tiled split. */
  tile?: { index: number; total: number }
  /** Width/height after preprocessing. */
  width: number
  height: number
}

/** Detected capability for one provider route. */
export interface ProviderCapability {
  provider: string
  supportsVision: boolean
  imageTransfer: ImageTransfer
  maxImageBytes?: number
  detail: 'high' | 'low'
}

// ── i18n ─────────────────────────────────────────────────────────────────

/** A bilingual template (zh + en) with `{{name}}` placeholders. */
export type I18nTemplate = { zh: string; en: string }
