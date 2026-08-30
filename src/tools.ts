/**
 * dsh-tui-browser-use — tool definition builder.
 *
 * Builds the 8 `browser.*` tool definitions and registers them on the harness
 * `ctx.tools` service (structural typed). Every tool returns the unified
 * result envelope (proposal §4). Browser failures are returned as structured
 * `{ ok: false, error }` envelopes rather than thrown, so the model always
 * sees the wire contract.
 *
 * Round 1 implements navigate/screenshot/click/type/evaluate/status.
 * `browser.extract` and `browser.task` are present but return
 * `not-implemented` until their later rounds.
 */

import type { BrowserSession } from './browser.js'
import type { VisionEnv } from './vision.js'
import type {
  NavigateParams, ClickParams, TypeParams, EvaluateParams, ScreenshotParams,
  NavigateResult, ClickResult, TypeResult, EvaluateResult, ScreenshotResult, StatusResult,
  ExtractParams, ExtractResult, TaskParams, TaskResult,
  SnapshotParams, SnapshotResult, NavigationResult,
  ScrollParams, ScrollResult, PressParams, PressResult, WaitParams, WaitResult,
  HoverParams, HoverResult, CookiesParams, CookiesResult,
  ConsoleMessagesParams, ConsoleMessagesResult, NetworkRequestsParams, NetworkRequestsResult,
  PdfParams, PdfResult,
  DownloadParams, DownloadResult,
  ResultEnvelope, Usage, ErrorCode, PreparedImage,
} from './types.js'
import { t, type Lang } from './i18n.js'
import { prepareScreenshot } from './image-pipeline.js'
import { validateJsonSchema, parseJsonReply, type SchemaNode } from './schema-validate.js'

/** The runtime dependencies a tool needs when it executes. */
export interface ToolDeps {
  session: BrowserSession
  /** Resolve the vision request environment from the current provider (async). */
  resolveVisionEnv(): Promise<VisionEnv | null>
  /** Effective vision mode for this call (a getter, so a live `/settings` edit takes effect immediately). */
  visionMode(): 'auto' | 'on' | 'off' | 'deepseek-file-api'
  lang: 'zh' | 'en'
}

/** A structurally-shaped tool definition the harness `ctx.tools.register` accepts. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): Array<Record<string, unknown>>
  }
  execute(args: unknown, exec: unknown): Promise<unknown>
  /** Optional cooperative timeout budget in ms (enforced by `dsh-tool-call-timeout-policy`). */
  timeoutMs?: number
  /** Optional concurrency classifier: only `true` opts into parallel dispatch. */
  isConcurrencySafe?(args: unknown): boolean
}

/** Wrap a successful value into the unified envelope. */
function ok<T>(value: T, usage?: Usage): ResultEnvelope<T> {
  return usage !== undefined ? { ok: true, value, usage } : { ok: true, value }
}

/** Sum two usage blocks (P1-05): `browser_task` accumulates cost across steps. */
export function accumulateUsage(acc: Usage | undefined, u: Usage): Usage {
  if (!u) return acc ?? { model: '', visionMode: 'auto', imagesSent: 0, promptTokens: 0, completionTokens: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0, costUsd: 0, costCny: 0 }
  if (!acc) return { ...u }
  return {
    ...u,
    imagesSent: acc.imagesSent + u.imagesSent,
    promptTokens: acc.promptTokens + u.promptTokens,
    completionTokens: acc.completionTokens + u.completionTokens,
    promptCacheHitTokens: acc.promptCacheHitTokens + u.promptCacheHitTokens,
    promptCacheMissTokens: acc.promptCacheMissTokens + u.promptCacheMissTokens,
    costUsd: acc.costUsd + u.costUsd,
    costCny: acc.costCny + u.costCny,
  }
}

// ANSI escape sequences (most commonly color) leak into browser/error text on
// some engines. Strip them from any message the model can see, and cap length so
// a huge call-log snippet cannot blow the context (P2 #12).
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g
const MAX_MSG = 2000

function sanitizeMessage(msg: string): string {
  return msg.replace(ANSI_RE, '').slice(0, MAX_MSG)
}

/**
 * Extract the cooperative abort signal a dsh tool timeout passes as `exec.signal`
 * (P0-02), with a hard ceiling fallback for hosts whose timeout policy does not
 * thread a signal (R-02). When `exec.signal` is absent, derive an
 * `AbortSignal.timeout(fallbackMs)` from the tool's own `timeoutMs` so a hanging
 * vision fetch (a TCP connect that never resolves) can never wedge the tool —
 * a long-running `analyzeImages` must always be interruptible.
 */
export function abortSignalOf(exec: unknown, fallbackMs?: number): AbortSignal | undefined {
  const s = (exec as { signal?: AbortSignal } | undefined)?.signal
  if (s) return s
  if (fallbackMs && Number.isFinite(fallbackMs) && fallbackMs > 0) {
    try { return AbortSignal.timeout(fallbackMs) } catch { return undefined }
  }
  return undefined
}

/** Convert an error into a failure envelope. */
function fail(err: unknown): ResultEnvelope<never> {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const code = (err as { code: ErrorCode }).code
    const message = sanitizeMessage((err as { message: string }).message)
    return { ok: false, error: { code, message } }
  }
  const msg = err instanceof Error ? err.message : String(err)
  return { ok: false, error: { code: 'browser-error', message: sanitizeMessage(msg) } }
}

// Cap the rendered success text so a huge page value (e.g. a 50k-char evaluate
// result) cannot blow the model context. Mark truncation explicitly so the
// model knows content was dropped (P0-04).
const MAX_RENDER_TEXT = 14_000

/** Render a snapshot of the value as compact text content for the model. */
export function renderText(_args: unknown, value: unknown): Array<Record<string, unknown>> {
  let text: string
  if (value && typeof value === 'object' && 'ok' in value) {
    const v = value as { ok: boolean; value?: unknown; error?: { code?: string; message?: string }; usage?: Usage }
    if (v.ok) {
      const parts = [JSON.stringify(v.value ?? null)]
      // Surface a usage summary so the model can see token/cost spend and
      // reason about whether a vision read actually cost tokens (P0-04).
      if (v.usage) {
        const u = v.usage
        parts.push(
          `\n[usage] model=${u.model} images=${u.imagesSent} prompt=${u.promptTokens} `
          + `completion=${u.completionTokens} cacheHit=${u.promptCacheHitTokens} `
          + `costUsd=${u.costUsd.toFixed(5)} costCny=${u.costCny.toFixed(4)}`,
        )
      }
      text = parts.join('')
    } else {
      // Keep the canonical error code visible to the model (not just the human
      // message) so an agent can branch on it programmatically (P0-04).
      text = `[${v.error?.code ?? 'browser-error'}] ${v.error?.message ?? 'tool failed'}`
    }
  } else {
    text = JSON.stringify(value ?? null)
  }
  if (text.length > MAX_RENDER_TEXT) {
    text = `${text.slice(0, MAX_RENDER_TEXT)}…(truncated, original ${text.length} chars)`
  }
  return [{ type: 'text', text }]
}

/**
 * Render page-derived tool output with an explicit untrusted marker, so the
 * model treats anything that came out of a live web page as data, not as
 * instructions to follow (prompt-injection guard, P1-03). Applied only to the
 * tools whose value is page text / the model's reading of a page.
 */
export function renderUntrusted(args: unknown, value: unknown): Array<Record<string, unknown>> {
  const out = renderText(args, value)
  // R-08: only a SUCCESSFUL page-derived result carries the untrusted marker. A
  // failure envelope is an infrastructure error (`[code] message`), not page
  // content, so it must NOT be labelled untrusted — the model would otherwise
  // see `[untrusted page content] [browser-error] ...` and misattribute a bug.
  const v = value as { ok?: boolean } | undefined
  if (v?.ok === true && out[0] && typeof out[0].text === 'string') {
    out[0].text = `[untrusted page content] ${out[0].text}`
  }
  return out
}

/** A permissive output schema describing the unified envelope. */
function envelopeSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: true,
  }
}

/**
 * Build a full object-rooted JSON Schema from a per-property map.
 * The harness views `parameters` as the tool's wire schema and projects it
 * verbatim to the model, so it MUST be object-rooted (`type:'object'`), not a
 * bare property map. `required` marks the listed property names as mandatory.
 */
function objSchema(properties: Record<string, Record<string, unknown>>, required?: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    ...(required && required.length > 0 ? { required } : {}),
    additionalProperties: true,
  }
}

/** Result of preparing a captured page for vision, plus tiling diagnostics. */
interface PreparedCapture {
  images: PreparedImage[]
  /** Instruction suffix warning the model about dropped tiles ('' when none). */
  tilingNote: string
  truncated: boolean
  segmentsTotal: number
  captured: number
  capturedHeight: number
  pageHeight: number
  /** Raw captured buffers (pre-prepare), for a `savePath` hand-off. */
  buffers: Buffer[]
}

/**
 * Capture the page as one or more segment screenshots and prepare each for
 * vision. Tall/wide pages are already split by `BrowserSession.captureSegments`
 * (scroll-capture tiling), so each prepared image is a native-resolution
 * viewport capture; no further pixel tiling is applied. When the page splits
 * into multiple segments, each prepared image is labeled with its tile index.
 *
 * When some needed segments were dropped because the `maxTiles` cap was reached,
 * a localized `tilingNote` is produced so the caller can append it to the vision
 * instruction — the model would otherwise silently see only the captured tiles.
 */
async function capturePreparedImages(session: BrowserSession, lang: Lang): Promise<PreparedCapture> {
  const cap = await session.captureSegments()
  const dim = session.config.screenshot.maxDimension
  const [w = 1280, h = 720] = (dim || '1024x768').toLowerCase().split('x').map((s) => Number.parseInt(s, 10))
  const total = cap.buffers.length
  const images = cap.buffers.map((buf, i) => {
    const [img] = prepareScreenshot(buf, {
      format: session.config.screenshot.format,
      quality: session.config.screenshot.quality,
      maxWidth: Number.isFinite(w) ? w : 1280,
      maxHeight: Number.isFinite(h) ? h : 720,
      tiling: 'off',
    })
    if (total > 1 && img) img.tile = { index: i + 1, total }
    return img
  }).filter((img): img is PreparedImage => Boolean(img))

  let tilingNote = ''
  if (cap.truncated) {
    tilingNote = t('tiling.truncated.note', lang, {
      captured: cap.captured,
      total: cap.segmentsTotal,
      dropped: Math.max(0, cap.segmentsTotal - cap.captured),
      heightPx: Math.round(cap.capturedHeight),
    })
  }
  return {
    images,
    tilingNote,
    truncated: cap.truncated,
    segmentsTotal: cap.segmentsTotal,
    captured: cap.captured,
    capturedHeight: cap.capturedHeight,
    pageHeight: cap.pageHeight,
    buffers: cap.buffers,
  }
}

/** Resolve the vision env; null means vision is off or the key is missing. */
async function visionEnvOrNull(deps: ToolDeps): Promise<VisionEnv | null> {
  return deps.visionMode() !== 'off' ? deps.resolveVisionEnv() : null
}

/**
 * Run one vision extract with validate-on-failure retry (≤2 retries, P0-4).
 *
 * Each retry appends the concrete violation/parse error so the model can
 * self-correct instead of the tool hard-failing a transitory miss. `call`
 * isolates the harness-specific image capture + vision read so this loop is
 * pure and unit-testable without a browser or live model.
 */
export async function extractWithRetry(
  call: (instruction: string) => Promise<{ insight: string; usage: Usage }>,
  schema: SchemaNode,
  baseInstruction: string,
): Promise<{ data: unknown; usage: Usage; attempts: number }> {
  const maxAttempts = 3
  let lastErr = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let instruction = baseInstruction
    if (attempt > 1) {
      instruction += attempt === 2
        ? ` Your previous reply was not a JSON object satisfying the schema. Fix it and retry. Last problem: ${lastErr}`
        : ` Your previous replies still failed. Re-read the screenshot and return ONLY a valid JSON object satisfying the schema. Last problem: ${lastErr}`
    }
    const res = await call(instruction)
    const data = parseJsonReply(res.insight)
    if (data === undefined) {
      lastErr = `vision model did not return parseable JSON; raw: ${res.insight.slice(0, 120)}`
      continue
    }
    const violations = validateJsonSchema(schema, data)
    if (violations.length > 0) {
      lastErr = violations.join('; ')
      continue
    }
    return { data, usage: res.usage, attempts: attempt }
  }
  throw new Error(lastErr)
}


/**
 * Build all tool definitions. `deps` may be a stub at build time; the
 * closures read it only when a tool executes.
 */
export function buildToolDefinitions(deps: ToolDeps): ToolDefinition[] {
  const session = deps.session
  const lang = deps.lang

  return [
    {
      name: 'browser_navigate',
      description: 'Navigate the browser to a URL. Returns the page title, resolved URL, and HTTP status.',
      parameters: objSchema({
        url: { type: 'string', description: 'Target URL, e.g. https://example.com' },
      }, ['url']),
      output: { schema: envelopeSchema(), render: renderText },
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      async execute(args: unknown): Promise<ResultEnvelope<NavigateResult>> {
        const p = (args ?? {}) as NavigateParams
        if (!p.url) return fail(t('error.argument', lang, { message: 'url required' }))
        try {
          return ok(await session.navigate(p))
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_screenshot',
      description: 'Capture the current page and, when vision is available, read it with a vision model. Returns visual insight and (for the official DeepSeek file path) the file_id. When savePath is set, writes the captured screenshot to the workspace — a single buffer to savePath verbatim, or tiled segments as stem-N.ext beside it (savedPath is the first written file).',
      parameters: objSchema({
        instruction: { type: 'string', description: 'Optional instruction for the vision model, e.g. "read all link text".' },
        savePath: { type: 'string', description: 'Optional absolute path to write the screenshot. A single capture goes verbatim to savePath; a tiled page writes stem-1.ext…stem-N.ext beside it and returns them in savedPaths.' },
      }),
      output: { schema: envelopeSchema(), render: renderUntrusted },
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      async execute(args: unknown, exec?: unknown): Promise<ResultEnvelope<ScreenshotResult>> {
        const p = (args ?? {}) as ScreenshotParams
        try {
          // Resolve vision BEFORE capturing: when vision is off/unavailable we
          // short-circuit WITHOUT screenshotting/tiling a page the model cannot
          // read (P1-08). DOM observation is unified under browser_snapshot, so
          // this path returns no elementSummary either.
          const env = await deps.resolveVisionEnv()
          const visionActive = deps.visionMode() !== 'off' && env !== null
          const wantsSave = Boolean(p.savePath)
          if (!visionActive && !wantsSave) {
            // R-05 (option A): with vision off/unavailable, do NOT run the
            // redundant DOM elementSummary (which duplicated browser_snapshot).
            // DOM observation is unified under browser_snapshot; screenshot
            // signals a degraded no-vision read via visionUsed/Reason.
            return ok({
              visualInsight: '',
              elementSummary: '',
              fileId: '',
              visionUsed: false,
              visionUnavailableReason: deps.visionMode() === 'off' ? 'vision-off' : 'vision-unavailable',
              tilesTotal: 0,
              tilesCaptured: 0,
              tilesTruncated: false,
              capturedHeight: 0,
              pageHeight: 0,
            })
          }

          const cap = await capturePreparedImages(session, lang)
          let insight = ''
          let fileId = ''
          if (visionActive && cap.images.length > 0) {
            const { analyzeImages } = await import('./vision.js')
            const instruction = [p.instruction, cap.tilingNote].filter(Boolean).join(' ')
            const res = await analyzeImages(env, cap.images, instruction || undefined, abortSignalOf(exec, 60_000))
            insight = res.insight || t('screenshot.insight.empty', lang)
            fileId = cap.images[0]?.fileId ?? ''
          }
          // Save the screenshot to a user-supplied workspace path. This runs
          // even when vision is unavailable (a bare screenshot hand-off), using
          // the buffers we already captured — no re-capture.
          let savedPath: string | undefined
          let savedPaths: string[] | undefined
          if (p.savePath) {
            const saved = await session.saveScreenshots(cap.buffers, p.savePath, session.config.screenshot.format)
            savedPath = saved.savedPath
            savedPaths = saved.savedPaths
          }
          return ok({
            visualInsight: insight,
            elementSummary: '',
            fileId,
            visionUsed: visionActive,
            // Surface why vision was skipped on the savePath branch too (H-04),
            // so the field is present whenever `visionUsed` is false, not only
            // on the no-savePath short-circuit.
            visionUnavailableReason: visionActive ? undefined : (deps.visionMode() === 'off' ? 'vision-off' : 'vision-unavailable'),
            tilesTotal: cap.segmentsTotal,
            tilesCaptured: cap.captured,
            tilesTruncated: cap.truncated,
            capturedHeight: cap.capturedHeight,
            pageHeight: cap.pageHeight,
            savedPath,
            savedPaths,
          })
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_click',
      description: 'Click an element by CSS selector or by visible text. At least one of selector/text must be provided.',
      parameters: objSchema({
        selector: { type: 'string', description: 'CSS selector to click.' },
        text: { type: 'string', description: 'Visible text to locate and click.' },
      }),
      output: { schema: envelopeSchema(), render: renderText },
      timeoutMs: 15_000,
      isConcurrencySafe: () => false,
      async execute(args: unknown): Promise<ResultEnvelope<ClickResult>> {
        const p = (args ?? {}) as ClickParams
        try {
          return ok(await session.click(p))
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_type',
      description: 'Fill an input field with text. Both selector and text are required. Optionally clear the field first and/or press a trailing key (e.g. Enter).',
      parameters: objSchema({
        selector: { type: 'string', description: 'CSS selector for the input.' },
        text: { type: 'string', description: 'Text to type into the field.' },
        enter: { type: 'string', description: 'Optional key to press after filling, e.g. Enter or Tab.' },
        clear: { type: 'boolean', description: 'Clear the field before filling (default false).' },
      }, ['selector', 'text']),
      output: { schema: envelopeSchema(), render: renderText },
      timeoutMs: 15_000,
      isConcurrencySafe: () => false,
      async execute(args: unknown): Promise<ResultEnvelope<TypeResult>> {
        const p = (args ?? {}) as TypeParams
        try {
          return ok(await session.type(p))
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_evaluate',
      description: 'Run a JavaScript expression in the current page and return its result.',
      parameters: objSchema({
        expression: { type: 'string', description: 'JavaScript expression or statement to evaluate.' },
      }, ['expression']),
      output: { schema: envelopeSchema(), render: renderUntrusted },
      timeoutMs: 15_000,
      isConcurrencySafe: () => false,
      async execute(args: unknown): Promise<ResultEnvelope<EvaluateResult>> {
        const p = (args ?? {}) as EvaluateParams
        try {
          return ok({ result: (await session.evaluate(p)).result })
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_extract',
      description: 'Extract structured data from the current page by a caller-provided JSON Schema. Uses the vision model to read the screenshot and return JSON that satisfies the schema.',
      parameters: objSchema({
        schema: { type: 'object', description: 'JSON Schema the extracted data must satisfy. A JSON object with type/properties/required.' },
        instruction: { type: 'string', description: 'Optional visual instruction that focuses what to extract.' },
      }, ['schema']),
      output: { schema: envelopeSchema(), render: renderUntrusted },
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      async execute(args: unknown, exec?: unknown): Promise<ResultEnvelope<ExtractResult>> {
        const p = (args ?? {}) as ExtractParams
        try {
          if (!p.schema || typeof p.schema !== 'object') return fail(t('error.argument', lang, { message: 'schema (JSON Schema) is required' }))
          const env = await visionEnvOrNull(deps)
          if (!env) return fail(t('error.vision-unavailable', lang))
          const cap = await capturePreparedImages(session, lang)
          const { analyzeImages } = await import('./vision.js')

          // The schema contract is asserted on every attempt so the model never
          // drifts into prose even when a caller supplies a bare instruction.
          const baseInstruction = p.instruction
            ? `${p.instruction} Return ONLY a JSON object that satisfies the provided JSON Schema. Do not wrap it in markdown or add commentary.`
            : 'Extract structured data from the screenshot. Return ONLY a JSON object that satisfies the provided JSON Schema. Do not wrap it in markdown or add commentary.'
          const instruction = cap.tilingNote ? `${baseInstruction} ${cap.tilingNote}` : baseInstruction

          try {
            const { data, usage } = await extractWithRetry(
              (callInstruction) => analyzeImages(env, cap.images, callInstruction, abortSignalOf(exec, 60_000)),
              p.schema as SchemaNode,
              instruction,
            )
            return ok({ data }, usage)
          } catch (retryErr) {
            return fail(t('error.schema-validation', lang, { message: retryErr instanceof Error ? retryErr.message : String(retryErr) }))
          }
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_task',
      description: 'Run a multi-step natural-language browser task. Iteratively reads the current page with the vision model and performs the next action (navigate/click/type) toward the instruction. Returns the final answer, steps taken, duration, and cost.',
      parameters: objSchema({
        instruction: { type: 'string', description: 'Natural-language task description.' },
        maxSteps: { type: 'integer', description: 'Maximum number of vision-driven actions to take (default 8).' },
      }, ['instruction']),
      output: { schema: envelopeSchema(), render: renderUntrusted },
      timeoutMs: 120_000,
      isConcurrencySafe: () => false,
      async execute(args: unknown, exec?: unknown): Promise<ResultEnvelope<TaskResult>> {
        const p = (args ?? {}) as TaskParams
        try {
          if (!p.instruction) return fail(t('error.argument', lang, { message: 'instruction is required' }))
          const env = await visionEnvOrNull(deps)
          if (!env) return fail(t('error.vision-unavailable', lang))
          const maxSteps = Math.min(Math.max(Number(p.maxSteps) || 8, 1), 16)
          const start = Date.now()
          let steps = 0
          let answer = ''
          let cost: Usage | undefined
          let done = false
          let consecutiveFailures = 0
          const maxFailures = 4
          const budget = Math.max(1, Math.round(maxSteps * 0.75))
          const { analyzeImages } = await import('./vision.js')
          while (steps < maxSteps && !done && consecutiveFailures < maxFailures) {
            steps += 1
            const cap = await capturePreparedImages(session, lang)
            // Inject a budget warning when approaching the step ceiling so the
            // agent winds down and reports a partial result instead of burning
            // the remaining budget (mirrors browser-use's `_inject_budget_warning`).
            const budgetNote = steps >= budget
              ? ` You have used about ${steps}/${maxSteps} steps. Finish now with {"action":"done","answer":"..."} — prefer a partial result over exhausting the budget.`
              : ''
            const res = await analyzeImages(env, cap.images,
              `You are a browser automation agent. Task: ${p.instruction}. Look at the current screenshot and choose the NEXT single action that advances the task. Reply ONLY with a JSON object, one of: {"action":"click","selector":"..."}, {"action":"type","selector":"...","text":"..."}, {"action":"navigate","url":"..."}, {"action":"scroll","x":0,"y":300}, {"action":"press","key":"Enter"}, {"action":"wait","ms":500}, {"action":"hover","selector":"..."}, or {"action":"done","answer":"..."}. Prefer visible text selectors. Do not wrap in markdown.${budgetNote}${cap.tilingNote ? ` ${cap.tilingNote}` : ''}`, abortSignalOf(exec, 120_000))
            cost = accumulateUsage(cost, res.usage)
            const action = parseJsonReply(res.insight) as { action?: string; selector?: string; text?: string; url?: string; key?: string; x?: number; y?: number; ms?: number; answer?: string } | undefined
            if (!action?.action) { answer = 'Could not interpret the page.'; done = true; break }
            if (action.action === 'done') { answer = action.answer ?? 'Task complete.'; done = true; break }
            // Execute one action; a failure counts toward the consecutive-failure
            // cap rather than aborting the whole task (which lets the agent
            // recover from a transitory click/type miss).
            try {
              switch (action.action) {
                case 'navigate':
                  if (action.url) { await session.navigate({ url: action.url }); break }
                  answer = 'navigate action missing url.'; done = true; break
                case 'click':
                  await session.click({ selector: action.selector, text: action.text }); break
                case 'type':
                  if (action.selector && action.text !== undefined) { await session.type({ selector: action.selector, text: action.text }); break }
                  answer = 'type action missing selector or text.'; done = true; break
                case 'scroll':
                  await session.scroll({ x: action.x, y: action.y }); break
                case 'press':
                  if (action.key) { await session.press({ key: action.key }); break }
                  answer = 'press action missing key.'; done = true; break
                case 'wait':
                  await session.wait({ ms: action.ms }); break
                case 'hover':
                  await session.hover({ selector: action.selector, text: action.text }); break
                default:
                  answer = 'Unknown action was proposed.'; done = true; break
              }
              consecutiveFailures = 0
            } catch (actionErr) {
              consecutiveFailures += 1
              if (consecutiveFailures >= maxFailures) {
                answer = `Gave up after ${consecutiveFailures} consecutive failed actions. Last error: ${actionErr instanceof Error ? actionErr.message : String(actionErr)}`
                done = true
              }
            }
          }
          if (!done && !answer) answer = consecutiveFailures >= maxFailures
            ? `Gave up after ${consecutiveFailures} consecutive failed actions.`
            : `Reached ${maxSteps} steps without finishing.`
          const durationS = Number(((Date.now() - start) / 1000).toFixed(1))
          return ok({ answer, steps, durationS, cost: { usd: cost?.costUsd ?? 0, cny: cost?.costCny ?? 0 } }, cost)
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_status',
      description: 'Report browser availability, engine version, and the effective config snapshot.',
      parameters: objSchema({}),
      output: { schema: envelopeSchema(), render: renderText },
      timeoutMs: 5_000,
      isConcurrencySafe: () => true,
      async execute(): Promise<ResultEnvelope<StatusResult>> {
        try {
          return ok(await session.status())
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_snapshot',
      description: 'Return a structured accessibility snapshot of the current page — an indexed list of interactive/semantic elements (role, accessible name, tag, disabled, bounding box). This is the default way to observe a page and reason about what to click/type without needing a screenshot.',
      parameters: objSchema({
        maxNodes: { type: 'integer', description: 'Maximum nodes to return (default 200, capped at 500).' },
      }),
      output: { schema: envelopeSchema(), render: renderUntrusted },
      timeoutMs: 15_000,
      isConcurrencySafe: () => false,
      async execute(args: unknown): Promise<ResultEnvelope<SnapshotResult>> {
        const p = (args ?? {}) as SnapshotParams
        try {
          return ok(await session.snapshot(p))
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_back',
      description: 'Navigate the browser back in history. Returns the resulting title/url/status.',
      parameters: objSchema({}),
      output: { schema: envelopeSchema(), render: renderText },
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      async execute(): Promise<ResultEnvelope<NavigationResult>> {
        try {
          return ok(await session.back())
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_forward',
      description: 'Navigate the browser forward in history. Returns the resulting title/url/status.',
      parameters: objSchema({}),
      output: { schema: envelopeSchema(), render: renderText },
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      async execute(): Promise<ResultEnvelope<NavigationResult>> {
        try {
          return ok(await session.forward())
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_reload',
      description: 'Reload the current page. Returns the resulting title/url/status.',
      parameters: objSchema({}),
      output: { schema: envelopeSchema(), render: renderText },
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      async execute(): Promise<ResultEnvelope<NavigationResult>> {
        try {
          return ok(await session.reload())
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_scroll',
      description: 'Scroll the current page by a pixel delta and return the resulting scroll position.',
      parameters: objSchema({
        x: { type: 'integer', description: 'Horizontal scroll delta in CSS pixels (default 0).' },
        y: { type: 'integer', description: 'Vertical scroll delta in CSS pixels (default 0).' },
      }),
      output: { schema: envelopeSchema(), render: renderText },
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      async execute(args: unknown): Promise<ResultEnvelope<ScrollResult>> {
        const p = (args ?? {}) as ScrollParams
        try {
          return ok(await session.scroll(p))
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_press',
      description: 'Press a keyboard key (e.g. Enter, Escape, Tab, Control+S). Useful for submitting forms or dismissing dialogs.',
      parameters: objSchema({
        key: { type: 'string', description: 'Keyboard key, e.g. Enter, Tab, Escape, Control+S.' },
      }, ['key']),
      output: { schema: envelopeSchema(), render: renderText },
      timeoutMs: 10_000,
      isConcurrencySafe: () => false,
      async execute(args: unknown): Promise<ResultEnvelope<PressResult>> {
        const p = (args ?? {}) as PressParams
        try {
          return ok(await session.press(p))
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_wait',
      description: 'Wait for a selector to become visible, or sleep for a fixed number of milliseconds (capped 30000). Use this for SPA/lazy content before an interaction.',
      parameters: objSchema({
        selector: { type: 'string', description: 'CSS selector to wait for (visible).' },
        ms: { type: 'integer', description: 'Sleep for ms milliseconds (default 0, capped 30000).' },
        timeoutMs: { type: 'integer', description: 'Timeout for the selector wait (default 6000).' },
      }),
      output: { schema: envelopeSchema(), render: renderText },
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      async execute(args: unknown): Promise<ResultEnvelope<WaitResult>> {
        const p = (args ?? {}) as WaitParams
        try {
          return ok(await session.wait(p))
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_hover',
      description: 'Hover over an element by CSS selector or visible text (reveals dropdowns / tooltips).',
      parameters: objSchema({
        selector: { type: 'string', description: 'CSS selector to hover.' },
        text: { type: 'string', description: 'Visible text to locate and hover.' },
      }),
      output: { schema: envelopeSchema(), render: renderText },
      timeoutMs: 15_000,
      isConcurrencySafe: () => false,
      async execute(args: unknown): Promise<ResultEnvelope<HoverResult>> {
        const p = (args ?? {}) as HoverParams
        try {
          return ok(await session.hover(p))
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_cookies',
      description: 'Read (and optionally clear / add) the browser cookies. Returns the cookie list.',
      parameters: objSchema({
        clear: { type: 'boolean', description: 'Clear all cookies first (default false).' },
        cookies: { type: 'array', description: 'Cookies to add before returning, each { name, value, url?/domain?/path? }.' },
        readValues: { type: 'boolean', description: 'Return cookie VALUES (default false — values are masked as *** so auth state never leaks).' },
      }),
      output: { schema: envelopeSchema(), render: renderText },
      timeoutMs: 10_000,
      isConcurrencySafe: () => false,
      async execute(args: unknown): Promise<ResultEnvelope<CookiesResult>> {
        const p = (args ?? {}) as CookiesParams
        try {
          return ok(await session.cookies(p))
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_console_messages',
      description: 'Return the console messages captured since the last call (or since the page loaded), with `clear` (default true). Useful for debugging JS errors on a page.',
      parameters: objSchema({
        clear: { type: 'boolean', description: 'Clear the buffer after returning (default true).' },
      }),
      output: { schema: envelopeSchema(), render: renderUntrusted },
      timeoutMs: 5_000,
      isConcurrencySafe: () => true,
      async execute(args: unknown): Promise<ResultEnvelope<ConsoleMessagesResult>> {
        const p = (args ?? {}) as ConsoleMessagesParams
        try {
          return ok(await session.consoleMessages(p))
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_network_requests',
      description: 'Return the network requests/responses captured since the last call (or since the page loaded), with `clear` (default true). Each entry is "<status> <url>". Useful for diagnosing failed XHR/fetch.',
      parameters: objSchema({
        clear: { type: 'boolean', description: 'Clear the buffer after returning (default true).' },
      }),
      output: { schema: envelopeSchema(), render: renderUntrusted },
      timeoutMs: 5_000,
      isConcurrencySafe: () => true,
      async execute(args: unknown): Promise<ResultEnvelope<NetworkRequestsResult>> {
        const p = (args ?? {}) as NetworkRequestsParams
        try {
          return ok(await session.networkRequests(p))
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_pdf',
      description: 'Print the current page to a PDF and return its absolute path and byte size. When `path` is omitted it writes to a temp file.',
      parameters: objSchema({
        path: { type: 'string', description: 'Output PDF path (optional; defaults to a temp file).' },
        format: { type: 'string', description: 'Page format, e.g. A4 (default) or Letter.' },
        printBackground: { type: 'boolean', description: 'Print background graphics (default true).' },
      }),
      output: { schema: envelopeSchema(), render: renderText },
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      async execute(args: unknown): Promise<ResultEnvelope<PdfResult>> {
        const p = (args ?? {}) as PdfParams
        try {
          return ok(await session.pdf(p))
        } catch (err) { return fail(err) }
      },
    },

    {
      name: 'browser_download',
      description: "Download a file from a URL and write it to disk. Uses the session's request context so cookies/auth carry over. Returns the absolute path, byte size, and Content-Type.",
      parameters: objSchema({
        url: { type: 'string', description: 'The URL to download (e.g. a file link the page exposed).' },
        savePath: { type: 'string', description: 'Output path to write the downloaded bytes (optional; defaults to a temp file).' },
      }, ['url']),
      output: { schema: envelopeSchema(), render: renderText },
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      async execute(args: unknown): Promise<ResultEnvelope<DownloadResult>> {
        const p = (args ?? {}) as DownloadParams
        if (!p.url) return fail(t('error.argument', lang, { message: 'url required' }))
        try {
          return ok(await session.download(p))
        } catch (err) { return fail(err) }
      },
    },
  ] satisfies ToolDefinition[]
}

/**
 * Register all tools on a structurally-shaped harness `ctx.tools` service.
 * Returns the combined disposer (unregisters every tool).
 */
export function registerTools(ctx: { get(name: string, optional?: boolean): unknown }, deps: ToolDeps): (() => void) | null {
  const tools = ctx.get('tools', false) as { register?(d: ToolDefinition): () => void } | undefined
  if (!tools?.register) return null
  const defs = buildToolDefinitions(deps)
  const disposers = defs.map((d) => {
    // Serialize every tool call onto the single shared browser page (P1 #9):
    // the session locks itself across calls, so concurrent tool dispatch never
    // interleaves Playwright operations. Read-only tools (status) still queue —
    // the harness's `isConcurrencySafe` classifier may launch them in parallel,
    // but they now drain serially instead of racing a navigate/click/type.
    const execute = (args: unknown, exec: unknown): Promise<unknown> =>
      deps.session.run(() => d.execute(args, exec))
    return tools.register!({ ...d, execute })
  })
  return () => disposers.forEach((d) => d())
}

// Re-export the error type for downstream modules.
export type { BrowserToolError } from './browser.js'
