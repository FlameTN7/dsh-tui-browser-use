/**
 * dsh-tui-browser-use — Cordis plugin entry.
 *
 * Runs as a sub-plugin inside the dsh-tui composition. It wires a
 * Playwright-driven browser toolset for the agent (`ctx.tools.register`),
 * a vision path (`deepseek-v4-flash-vision-exp` + DeepSeek file_api on the
 * official channel, base64 on others), and a dsh-tui settings section.
 *
 * The plugin reads no secret values itself: API keys and provider routing
 * come from the harness (`ctx.get('credentials')` / `ctx.get('settings')`)
 * or host environment variables. Diagnostics report only whether a key is
 * set — never its value (AGENTS.md §7).
 */

import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { BrowserSession } from './browser.js'
import { registerTools } from './tools.js'
import { registerSettingsSection } from './settings-section.js'
import { resolveProvider, resolveRoute, resolveTransfer } from './provider-router.js'
import { isVisionCapableModel } from './capabilities.js'
import type { BrowserUseConfig, ProviderOverride, ImageTransfer, VisionMode, ScreenshotFormat, TilingMode } from './types.js'
import type { VisionEnv } from './vision.js'

export const name = 'dsh-tui-browser-use'

// Inject the harness `tools` service so Cordis defers this plugin's activation
// until the registry is mounted — `ctx.get('tools')` is then available at
// apply time. `tuiSettingsSections` is optional (soft-probed), so it is NOT
// injected (a missing seam must not prevent tool registration).
export const inject: string[] = ['tools']

// ── Config ───────────────────────────────────────────────────────────────

export interface Config extends BrowserUseConfig {
  /** Browser language for strings: 'zh' (default) or 'en'. */
  lang: 'zh' | 'en'
}

export const Config: Schema<Config> = Schema.object({
  lang: Schema.union(['zh', 'en'] as const).default('zh'),
  visionMode: Schema.union(['auto', 'on', 'off', 'deepseek-file-api'] as const).default('auto'),
  screenshot: Schema.object({
    format: Schema.union(['jpeg', 'webp', 'png'] as const).default('jpeg'),
    quality: Schema.number().min(1).max(100).default(80),
    maxDimension: Schema.string().default('1024x768'),
  }),
  tiling: Schema.object({
    mode: Schema.union(['auto', 'on', 'off'] as const).default('auto'),
    threshold: Schema.string().default('1200x1200'),
    overlap: Schema.number().min(0).default(60),
  }),
  providers: Schema.array(Schema.object({
    provider: Schema.string().required(),
    supportsVision: Schema.boolean().default(false),
    imageTransfer: Schema.union(['file', 'base64', 'url', 'none'] as const).default('none'),
    maxImageBytes: Schema.number().required(false),
    detailPreference: Schema.union(['high', 'low', 'auto'] as const).required(false),
  })).default([]),
})

/**
 * The `browser-use` settings-namespace schema (the user-editable fields the TUI
 * section renders). It mirrors the plugin Config minus `lang`, so the settings
 * screen can persist/stage edits to the same fields the plugin reads.
 */
const settingsNamespaceSchema = Schema.object({
  visionMode: Schema.union(['auto', 'on', 'off', 'deepseek-file-api'] as const).default('auto'),
  screenshot: Schema.object({
    format: Schema.union(['jpeg', 'webp', 'png'] as const).default('jpeg'),
    quality: Schema.number().min(1).max(100).default(80),
    maxDimension: Schema.string().default('1024x768'),
  }),
  tiling: Schema.object({
    mode: Schema.union(['auto', 'on', 'off'] as const).default('auto'),
    threshold: Schema.string().default('1200x1200'),
    overlap: Schema.number().min(0).default(60),
  }),
  providers: Schema.array(Schema.object({
    provider: Schema.string().required(),
    supportsVision: Schema.boolean().default(false),
    imageTransfer: Schema.union(['file', 'base64', 'url', 'none'] as const).default('none'),
    maxImageBytes: Schema.number().required(false),
    detailPreference: Schema.union(['high', 'low', 'auto'] as const).required(false),
  })).default([]),
})

// ── Harness access helpers (structural, never self-manage secrets) ──────

type CredentialsLike = {
  get?(name: string): unknown
  read?(ref: unknown): Promise<unknown>
  resolve?(ref: unknown): Promise<unknown>
  [key: string]: unknown
}

function envOr<T>(key: string, fallback: T): T | string {
  const env = process.env[key]
  return env && env.length > 0 ? env : fallback
}

/**
 * Probe one secret from the harness credentials seam (async, the real path:
 * `ctx.credentials.resolve({ env })`), then env vars, then a legacy sync
 * `.get`/`.read`. Never logs the value. Credentials service presence is
 * optional (soft-probed), so a harness without the seam falls back to env.
 */
async function probeSecretAsync(ctx: Context, names: readonly string[]): Promise<string | null> {
  const creds = ctx.get('credentials', false) as CredentialsLike | undefined
  if (creds) {
    // Correct async path: resolve({ env: 'NAME' }) → { key }.
    if (typeof creds.resolve === 'function') {
      for (const n of names) {
        try {
          const r = await (creds as { resolve(ref: unknown): Promise<{ key?: string; value?: string } | undefined> }).resolve({ env: n })
          const v = r?.key ?? r?.value
          if (typeof v === 'string' && v.length > 0) return v
        } catch { /* not configured — try next */ }
      }
    }
    // Legacy sync `.get` / direct keyed field, for odd harnesses.
    for (const n of names) {
      const v = typeof creds.get === 'function' ? creds.get(n) : creds[n]
      if (typeof v === 'string' && v.length > 0) return v
    }
  }
  for (const n of names) {
    const env = process.env[n] ?? process.env[n.replace(/\./g, '_')]
    if (env && env.length > 0) return env
  }
  return null
}

function defaultLang(ctx: Context): 'zh' | 'en' {
  const env = process.env.DSH_TUI_LANG
  if (env === 'en') return 'en'
  // dsh-tui settings keep the UI language under the `dsh-tui` namespace; the
  // service is namespace-keyed rather than a flat `.get`, so read the env and
  // the plugin config first, then soft-probe a `setting` fallback.
  const ns = ctx.get('settings', false) as { namespace?(name: string): { get?(): unknown } } | undefined
  const val = ns?.namespace?.('dsh-tui')?.get?.() as { lang?: unknown } | undefined
  if (val?.lang === 'en') return 'en'
  return 'zh'
}

// ── apply ────────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config): void {
  const lang = config.lang ?? defaultLang(ctx)

  // Resolve the vision request environment from the provider route table +
  // harness credentials. Provider/model can be overridden by env vars
  // (DSH_TUI_BROWSER_PROVIDER / _MODEL / _BASE_URL); the API key comes from
  // `ctx.credentials.resolve({ env: apiKeyEnv })` (async), falling back to env
  // vars. Missing key degrades vision to DOM (null).
  const resolveVisionEnv = async (): Promise<VisionEnv | null> => {
    const visionMode = config.visionMode
    if (visionMode === 'off') return null

    const forceFileApi = visionMode === 'deepseek-file-api'
    const provider = resolveProvider(forceFileApi)
    const route = resolveRoute(provider)
    const currentModel = route.defaultModel

    // A text-only model (e.g. `deepseek-v4-flash`) cannot read a screenshot;
    // degrade to DOM fallback (null) rather than sending it a vision request.
    if (!isVisionCapableModel(provider, currentModel)) return null

    const apiKey = await probeSecretAsync(ctx, [route.apiKeyEnv, 'DEEPSEEK_API_KEY', 'deepseek.apiKey', 'apiKey'])
    if (!apiKey) return null

    const baseUrl = envOr('DEEPSEEK_BASE_URL', '') || route.baseURL

    // Transfer mode: explicit `deepseek-file-api` wins, then env override, then
    // the user's provider override, then the route table (deepseek=file,
    // xiaomi=base64, unknown=base64).
    let imageTransfer: ImageTransfer
    if (forceFileApi) {
      imageTransfer = 'file'
    } else {
      const over = config.providers.find((p) => p.provider.toLowerCase() === provider.toLowerCase())
      imageTransfer = over?.imageTransfer ?? resolveTransfer(provider, false)
    }

    return {
      baseUrl,
      apiKey,
      model: currentModel,
      imageTransfer,
      provider,
      currentModel,
    }
  }

  // Browser session, shared across all tool calls in this plugin fiber.
  const session = new BrowserSession(config, lang)

  // Register the toolset on the harness tool runtime.
  const disposer = registerTools(ctx, { session, resolveVisionEnv, visionMode: config.visionMode, lang })

  // Register the dsh-tui settings section (soft-probed; may be absent).
  const debug = (msg: string): void => {
    if (process.env.DSH_TUI_BROWSER_DEBUG) process.stderr.write(`[dsh-tui-browser-use] ${msg}\n`)
  }
  const settingsDisposer = registerSettingsSection(ctx, debug)

  // Register the `browser-use` settings namespace on the harness settings service
  // so the TUI /settings screen serves it — without this the section renders as
  // '[命名空间未注册]' (mirrors dsh-tui's own namespace registration). A harness
  // without a settings service just skips; it must never block tool registration.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      const settings = (settingsCtx.get('settings') as
        { register?(ns: string, schema: unknown): unknown } | undefined)
      if (settings?.register) {
        settings.register('browser-use', settingsNamespaceSchema)
        debug('settings namespace registered: ns=browser-use')
      } else {
        debug('settings.service present but register() missing; namespace skipped')
      }
    })
  } else {
    debug('ctx.inject unavailable; settings namespace not registered')
  }

  // Diagnostics: confirm the tools actually registered and the seam shape.
  if (process.env.DSH_TUI_BROWSER_DEBUG) {
    const probe = (label: string): void => {
      const viaGet = ctx.get('tools', false) as { schemas?(): Array<{ name: string }> } | undefined
      const names = (viaGet?.schemas?.() ?? []).map((s) => s.name)
      debug(`tools[${label}] get=${viaGet ? 'present' : 'undefined'} registered=${names.length} list=${names.join(',')}`)
      const seam = ctx.get('tuiSettingsSections', false) as { register?: unknown } | undefined
      debug(`seam[${label}] tuiSettingsSections=${seam ? 'present' : 'undefined'} register=${typeof seam?.register}`)
      const creds = ctx.get('credentials', false) as { resolve?: unknown; get?: unknown } | undefined
      debug(`credentials[${label}] service=${creds ? 'present' : 'undefined'} resolve=${typeof creds?.resolve} get=${typeof creds?.get}`)
    }
    probe('boot')
    // Re-probe after the tree settles (services inserted later become visible).
    queueMicrotask(() => probe('microtask'))
  }

  // Tear down the browser and settings when the plugin fiber stops.
  ctx.effect(() => {
    return () => {
      disposer?.()
      settingsDisposer?.()
      void session.close()
    }
  })

  debug(`plugin apply complete (visionMode=${config.visionMode})`)
}

export default { name, inject, Config, apply }

// Re-exports so tool consumers can type against the contract.
export type { BrowserUseConfig, ProviderOverride, ImageTransfer, VisionMode, ScreenshotFormat, TilingMode }
