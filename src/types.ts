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
  /** Input tokens that hit the provider's disk/prompt cache (0 when absent). */
  promptCacheHitTokens: number
  /** Input tokens that missed the cache (0 when absent). */
  promptCacheMissTokens: number
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

/** Accepted screenshot output formats (Playwright only emits jpeg/png; webp was removed — it silently produced jpeg). */
export type ScreenshotFormat = 'jpeg' | 'png'

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
  /** JPEG quality, 1-100. */
  quality: number
  /** @deprecated `width×height` string. Real viewport is now `viewport`; kept as a backward-compat alias. */
  maxDimension: string
}

/** Tiling configuration block. */
export interface TilingConfig {
  mode: TilingMode
  /** `width×height` string, e.g. `1200x1200`. */
  threshold: string
  /** Tile overlap in pixels. */
  overlap: number
  /** Max tiles captured before truncation. Lower than needed drops the page bottom. */
  maxTiles?: number
}

/** Plugin config, validated by the Schemastery `Config` schema in index.ts. */
export interface BrowserUseConfig {
  visionMode: VisionMode
  /** Effective viewport in CSS pixels (was `screenshot.maxDimension`; the deprecated alias still works). */
  viewport?: { width: number; height: number }
  screenshot: ScreenshotConfig
  tiling: TilingConfig
  providers: ProviderOverride[]
  /** Optional HTTP proxy for external sites (`http://host:port`). Empty uses env `DSH_TUI_BROWSER_PROXY`. */
  proxy?: string
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
  /** Optional absolute path to write the captured screenshot (or first tile) to the workspace. */
  savePath?: string
}

/** `browser.screenshot` result. */
export interface ScreenshotResult {
  /** The vision model's textual understanding of the screenshot. */
  visualInsight: string
  /** A compact list of visible interactive elements (links/buttons/inputs). */
  elementSummary: string
  /** DeepSeek file_api `file_id` when the official file path was used. */
  fileId: string
  /** True when a vision model actually read the screenshot (P1-07/08). */
  visionUsed?: boolean
  /** Why vision was skipped, when `visionUsed` is false (e.g. `vision-off`, `vision-unavailable`). */
  visionUnavailableReason?: string
  /** Tiling: total tiles that would cover the whole page (1 when not tiled). */
  tilesTotal?: number
  /** Tiling: tiles actually captured (≤ `tilesTotal`). */
  tilesCaptured?: number
  /** Tiling: true when some tiles were dropped because `maxTiles` was reached. */
  tilesTruncated?: boolean
  /** Tiling: vertical pixel extent actually captured. */
  capturedHeight?: number
  /** Full scrollable page height in px. */
  pageHeight?: number
  /** Absolute path the screenshot was written to when `savePath` was provided (first/only tile). */
  savedPath?: string
  /** All tile paths written when `savePath` was provided and the page tiled into multiple files. */
  savedPaths?: string[]
}

/** Result of a scroll-capture tiling pass over the page. */
export interface CaptureSegmentsResult {
  /** Captured segment buffers, in reading order. */
  buffers: Buffer[]
  /** True when the page needed more tiles than `maxTiles` and some were dropped. */
  truncated: boolean
  /** Total tiles that would cover the whole page (before the maxTiles cap). */
  segmentsTotal: number
  /** Number of tiles actually captured. */
  captured: number
  /** Horizontal pixel extent covered by the captured tiles. */
  capturedWidth: number
  /** Vertical pixel extent covered by the captured tiles. */
  capturedHeight: number
  /** Full scrollable page width in px. */
  pageWidth: number
  /** Full scrollable page height in px. */
  pageHeight: number
}

/** `browser.click` parameters. */
export interface ClickParams {
  /** CSS selector. Mutually exclusive with `text`. */
  selector?: string
  /** Visible text to locate the element. Mutually exclusive with `selector`. */
  text?: string
  /** Return a short page-change delta (`added/changed/removed/reindexed`) from before the click (default false). */
  delta?: boolean
}

/** `browser.click` result. */
export interface ClickResult {
  success: boolean
  newUrl: string
  /** Short page-change delta when `delta` was requested (page-derived, untrusted). */
  delta?: SnapshotDelta
}

/** `browser.type` parameters. */
export interface TypeParams {
  selector: string
  text: string
  /** Press the provided key after filling (e.g. `Enter`, `Tab`); default off. */
  enter?: string
  /** Clear the field before filling; default off. */
  clear?: boolean
  /** Return a short page-change delta (`added/changed/removed/reindexed`) from before the type (default false). */
  delta?: boolean
}

/** `browser.type` result. */
export interface TypeResult {
  success: boolean
  /** Short page-change delta when `delta` was requested (page-derived, untrusted). */
  delta?: SnapshotDelta
}

/** Shared shape for the navigation trio (back/forward/reload). */
export interface NavigationResult {
  title: string
  url: string
  status: number | null
}

/** `browser.scroll` parameters. */
export interface ScrollParams {
  /** Horizontal scroll delta in CSS pixels (default 0). */
  x?: number
  /** Vertical scroll delta in CSS pixels (default 0). */
  y?: number
  /** Return a short page-change delta (`added/changed/removed/reindexed`) from before the scroll (default false). */
  delta?: boolean
}

/** `browser.scroll` result. */
export interface ScrollResult {
  x: number
  y: number
  /** Short page-change delta when `delta` was requested (page-derived, untrusted). */
  delta?: SnapshotDelta
}

/** `browser.press` parameters. */
export interface PressParams {
  /** Keyboard key, e.g. `Enter`, `Tab`, `Escape`, `Control+S`. */
  key: string
}

/** `browser.press` result. */
export interface PressResult {
  success: boolean
}

/** `browser.wait` parameters. */
export interface WaitParams {
  /** CSS selector to wait for (visible). Mutually exclusive with `ms`. */
  selector?: string
  /** Sleep for `ms` milliseconds (capped 30000). Mutually exclusive with `selector`. */
  ms?: number
  /** Timeout in ms for the selector wait (default 6000). */
  timeoutMs?: number
}

/** `browser.wait` result. */
export interface WaitResult {
  waited: boolean
  /** Duration actually slept (ms), when `ms` was used. */
  ms?: number
  /** Whether the selector became visible (when `selector` was used). */
  visible?: boolean
}

/** `browser.hover` parameters. */
export interface HoverParams {
  /** CSS selector. Mutually exclusive with `text`. */
  selector?: string
  /** Visible text to locate and hover. Mutually exclusive with `selector`. */
  text?: string
}

/** `browser.hover` result. */
export interface HoverResult {
  success: boolean
}

/** `browser.cookies` parameters. */
export interface CookiesParams {
  /** Clear all cookies before returning (default false). */
  clear?: boolean
  /** Cookies to add before returning (set `name`/`value`, optional `url`/`domain`/`path`). */
  cookies?: Array<{ name: string; value: string; url?: string; domain?: string; path?: string }>
  /** Read cookie VALUES (default false — values are masked as `***` so auth state never leaks). */
  readValues?: boolean
}

/** `browser.cookies` result. */
export interface CookiesResult {
  cookies: Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: string }>
}

/** `browser.console_messages` parameters. */
export interface ConsoleMessagesParams {
  /** Clear the accumulated buffer after returning (default true). */
  clear?: boolean
}

/** `browser.console_messages` result. */
export interface ConsoleMessagesResult {
  messages: string[]
}

/** `browser.network_requests` parameters. */
export interface NetworkRequestsParams {
  /** Clear the accumulated buffer after returning (default true). */
  clear?: boolean
}

/** `browser.network_requests` result. */
export interface NetworkRequestsResult {
  requests: string[]
}

/** `browser.download` parameters. */
export interface DownloadParams {
  /** The URL to download (e.g. a file link the page exposed). */
  url: string
  /** Output path to write the downloaded bytes to. When omitted, writes to a temp file and returns its path. */
  savePath?: string
}

/** `browser.download` result. */
export interface DownloadResult {
  /** The (sanitized) URL that was downloaded. */
  url: string
  /** Absolute path to the downloaded file. */
  path: string
  /** Size of the file in bytes. */
  bytes: number
  /** Optional Content-Type from the response. */
  contentType?: string
}

/** `browser.pdf` parameters. */
export interface PdfParams {
  /** Output PDF path. When omitted, writes to a temp file and returns its path. */
  path?: string
  /** Page format, e.g. `A4` (default) or `Letter`. */
  format?: string
  /** Print background graphics (default true). */
  printBackground?: boolean
}

/** `browser.pdf` result. */
export interface PdfResult {
  /** The page URL that was printed. */
  url: string
  /** Absolute path to the saved PDF. */
  path: string
  /** Size of the PDF in bytes. */
  bytes: number
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

/** One interactive/semantic element in the a11y snapshot index. */
export interface SnapshotNode {
  /** Stable page-internal id (persistent across `browser_snapshot` calls within the same document). */
  id: number
  /** Stable 1-based index the agent can reference. */
  index: number
  /** Computed ARIA role (link/button/heading/checkbox/textbox/...). */
  role: string
  /** Accessible name (aria-label, label text, innerText, placeholder, ...). */
  name: string
  /** Lowercased tag name, e.g. `a`, `input`. */
  tag: string
  /** Input `type` (for `input` elements). */
  type?: string
  disabled: boolean
  /** Checked state for checkbox/radio/switch. */
  checked?: boolean
  /** `placeholder` for form controls. */
  placeholder?: string
  /** `href` for links. */
  href?: string
  /** Top-left viewport x. */
  x: number
  /** Top-left viewport y. */
  y: number
  /** Element width. */
  width: number
  /** Element height. */
  height: number
}

/**
 * A short page-change delta between two snapshots, keyed by stable node `id`.
 * Each list is capped and empty when nothing of that kind changed.
 */
export interface SnapshotDelta {
  /** Nodes present in the previous snapshot but absent now. */
  removed?: Array<{ id: number; role: string; name: string }>
  /** Nodes that appeared since the previous snapshot. */
  added?: SnapshotNode[]
  /** Nodes still present whose content/attributes changed (position excluded). */
  changed?: SnapshotNode[]
  /** Nodes still present whose positional index changed: `id`, `from`, `to`. */
  reindexed?: Array<{ id: number; from: number; to: number }>
  /** True when any list was capped (the reported ceiling holds). */
  truncated?: boolean
}

/** `browser.snapshot` parameters. */
export interface SnapshotParams {
  /** Max nodes to return (default 200, capped at 500). */
  maxNodes?: number
  /** Return a page-change delta relative to the previous snapshot (default false). */
  delta?: boolean
}

/** `browser.snapshot` result. */
export interface SnapshotResult {
  nodes: SnapshotNode[]
  /** Total matching visible candidates ahead of the node cap (P1-09). */
  total?: number
  /** True when the page had more candidates than the `maxNodes` cap (P1-09). */
  truncated?: boolean
  /** Page-change delta when `delta` was requested (page-derived, untrusted). */
  delta?: SnapshotDelta
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
  /** Byte size of the prepared payload (post any capture-time compression). */
  bytes?: number
  /** True when the payload exceeds the configured byte budget (no re-encode). */
  oversize?: boolean
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
