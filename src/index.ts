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

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  // Real viewport (CSS px). `screenshot.maxDimension` remains as a deprecated
  // back-compat alias for the same thing (P0-03).
  viewport: Schema.object({
    width: Schema.number().min(1).default(1024),
    height: Schema.number().min(1).default(768),
  }).required(false),
  screenshot: Schema.object({
    format: Schema.union(['jpeg', 'png'] as const).default('jpeg'),
    quality: Schema.number().min(1).max(100).default(80),
    maxDimension: Schema.string().required(false),
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
  viewport: Schema.object({
    width: Schema.number().min(1).default(1024),
    height: Schema.number().min(1).default(768),
  }).required(false),
  screenshot: Schema.object({
    format: Schema.union(['jpeg', 'png'] as const).default('jpeg'),
    quality: Schema.number().min(1).max(100).default(80),
    maxDimension: Schema.string().required(false),
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

/**
 * Register the plugin's bundled `browser-bridge` skill on the harness skill
 * registry (soft-probed). The SKILL.md ships in the package (`skills/` in
 * `files`) but is only visible via `/skills` when contributed to the registry;
 * without registration the agent falls back to bare English tool descriptions
 * (P0-05). A missing registry / unreadable file / invalid frontmatter is never
 * fatal — it logs (in debug) and lets the rest of the plugin boot.
 */
function registerPackagedSkill(ctx: Context, debug: (msg: string) => void): void {
  // The skill registry may mount AFTER this plugin's `apply` (R-10): a single
  // probe at apply time would permanently skip registration when the hosting
  // tree inserts the skills service in a later fiber. Probe now, then re-probe
  // once on the microtask queue (same tick, after sibling services settle).
  // `ctx.inject` is not required for the skills seam (it's soft-probed), so a
  // host without a registry is just silently skipped on both attempts.
  let registered = false
  const tryRegister = (): void => {
    if (registered) return
    const registry = ctx.get('skills', false) as { register?: (s: { name: string; description: string; content: string; path?: string; source?: string }) => void } | undefined
    if (!registry?.register) {
      debug('skills registry unavailable; browser-bridge skill not registered')
      return
    }
    try {
      // Resolve the package `skills/` root from the built layout (`lib/types/`)
      // or the source layout (`src/`); the two-candidate walk mirrors the host's
      // packaged-skills.ts so a directory reshuffle does not silently skip it.
      const here = dirname(fileURLToPath(import.meta.url))
      const skillFile = [join(here, '..', '..', 'skills'), join(here, '..', '..', '..', 'skills')]
        .map((root) => join(root, 'browser-bridge', 'SKILL.md'))
        .find((candidate) => existsSync(candidate))
      if (!skillFile) {
        debug('browser-bridge SKILL.md not found in package; skill not registered')
        return
      }
      const raw = readFileSync(skillFile, 'utf8')
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
      const frontmatter = m?.[1] ?? ''
      const content = (m?.[2] ?? raw).trim()
      const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() || 'browser-bridge'
      const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() || ''
      if (!name || !description) {
        debug('browser-bridge SKILL frontmatter missing name/description; skill not registered')
        return
      }
      registry.register({ name, description, content, path: skillFile, source: 'dsh-tui-browser-use' })
      registered = true
      debug(`browser-bridge skill registered: name=${name}`)
    } catch (err) {
      debug(`browser-bridge skill register failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  tryRegister()
  queueMicrotask(tryRegister)
}

// ── apply ────────────────────────────────────────────────────────────────

/** Deep-merge a settings user-layer value over the base config (P0-01). */
function mergeConfig(base: BrowserUseConfig, layer: Partial<BrowserUseConfig>): BrowserUseConfig {
  return {
    ...base,
    ...layer,
    viewport: layer.viewport ?? base.viewport,
    screenshot: { ...base.screenshot, ...(layer.screenshot ?? {}) },
    tiling: { ...base.tiling, ...(layer.tiling ?? {}) },
    providers: layer.providers ?? base.providers,
  }
}

export function apply(ctx: Context, config: Config): void {
  const lang = config.lang ?? defaultLang(ctx)

  // Effective config: starts from the Cordis `config`, then the settings user
  // layer (settings.yaml / /settings edits) overrides it live. `effective` is
  // mutated in place (and `session.config` shares the same reference) so a
  // `/settings` change takes effect without recomposing the plugin (P0-01).
  const effective: BrowserUseConfig = {
    visionMode: config.visionMode,
    viewport: config.viewport,
    screenshot: { ...config.screenshot },
    tiling: { ...config.tiling },
    providers: [...config.providers],
  }

  // Resolve the vision request environment from the provider route table +
  // harness credentials. Provider/model can be overridden by env vars
  // (DSH_TUI_BROWSER_PROVIDER / _MODEL / _BASE_URL); the API key comes from
  // `ctx.credentials.resolve({ env: apiKeyEnv })` (async), falling back to env
  // vars. Missing key degrades vision to DOM (null).
  const resolveVisionEnv = async (): Promise<VisionEnv | null> => {
    const visionMode = effective.visionMode
    if (visionMode === 'off') return null

    const forceFileApi = visionMode === 'deepseek-file-api'
    const provider = resolveProvider(forceFileApi)
    const route = resolveRoute(provider)
    const currentModel = route.defaultModel

    // A text-only model (e.g. `deepseek-v4-flash`) cannot read a screenshot;
    // degrade to DOM fallback (null) rather than sending it a vision request.
    if (!isVisionCapableModel(provider, currentModel)) return null

    // A user-provider override may explicitly disable vision for a model that
    // would otherwise look capable (P1-01): `supportsVision: false` must degrade
    // to DOM even for a vision-capable route.
    const over = effective.providers.find((p) => p.provider.toLowerCase() === provider.toLowerCase())
    if (over?.supportsVision === false) return null

    // Non-deepseek routes must NOT fall back to the official DeepSeek key — a
    // different provider's credential would be sent to a foreign endpoint. Only
    // the deepseek route may use DEEPSEEK_API_KEY (P1-02).
    const apiKeyEnvs = provider === 'deepseek'
      ? [route.apiKeyEnv, 'DEEPSEEK_API_KEY', 'deepseek.apiKey', 'apiKey']
      : [route.apiKeyEnv, 'apiKey']
    const apiKey = await probeSecretAsync(ctx, apiKeyEnvs)
    if (!apiKey) return null

    const baseUrl = envOr('DEEPSEEK_BASE_URL', '') || route.baseURL

    // Transfer mode: explicit `deepseek-file-api` wins, then env override, then
    // the user's provider override, then the route table (deepseek=file,
    // xiaomi=base64, unknown=base64).
    let imageTransfer: ImageTransfer
    if (forceFileApi) {
      imageTransfer = 'file'
    } else {
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

  // Browser session, shared across all tool calls in this plugin fiber. Shares
  // the `effective` config reference so a live settings edit is reflected here.
  const session = new BrowserSession(effective, lang)

  // Register the toolset on the harness tool runtime. `visionMode` is a getter
  // so a live `/settings` change is honoured on the very next tool call.
  const disposer = registerTools(ctx, { session, resolveVisionEnv, visionMode: () => effective.visionMode, lang })

  // Register the dsh-tui settings section (soft-probed; may be absent).
  const debug = (msg: string): void => {
    if (process.env.DSH_TUI_BROWSER_DEBUG) process.stderr.write(`[dsh-tui-browser-use] ${msg}\n`)
  }
  const settingsDisposer = registerSettingsSection(ctx, debug)

  // Register the bundled `browser-bridge` skill (soft-probed; never fatal).
  registerPackagedSkill(ctx, debug)

  // Register the `browser-use` settings namespace on the harness settings service
  // so the TUI /settings screen serves it — without this the section renders as
  // '[命名空间未注册]' (mirrors dsh-tui's own namespace registration). A harness
  // without a settings service just skips; it must never block tool registration.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      const settings = (
        (settingsCtx.get('settings') ?? (settingsCtx as { settings?: unknown }).settings) as
        { register?(ns: string, schema: unknown, options?: { base?: Partial<BrowserUseConfig>; applies?: string }): { get?(): Partial<BrowserUseConfig>; watch?(cb: (v: Partial<BrowserUseConfig>) => void): void } } | undefined
      )
      if (settings?.register) {
        // R-01: pass the Cordis config as the settings `base` layer so schema
        // defaults do NOT shadow a non-default patch config when the user layer
        // is empty. Without `base`, the host resolves `schema(mergeLayers(undefined,
        // section))` and fills every default (visionMode 'auto', 1024x768, ...),
        // silently overriding `cordis.patch.yml` values (e.g. visionMode:'off') —
        // a security/billing regression the reviewer reproduced (R-01 Blocker).
        // `applies:'live'` keeps `/settings` edits hot (the watch below applies
        // them immediately), mirroring dsh-tui's own registration.
        const configBase: Partial<BrowserUseConfig> = {
          visionMode: config.visionMode,
          viewport: config.viewport ? { ...config.viewport } : undefined,
          screenshot: { ...config.screenshot },
          tiling: { ...config.tiling },
          providers: config.providers.map((p) => ({ ...p })),
        }
        const scope = settings.register('browser-use', settingsNamespaceSchema, { base: configBase, applies: 'live' }) as
          { get?(): Partial<BrowserUseConfig>; watch?(cb: (v: Partial<BrowserUseConfig>) => void): void } | undefined
        debug('settings namespace registered: ns=browser-use')
        if (!scope) {
          debug('settings.register returned no scope; falling back to Cordis config only')
          return
        }
        // Apply the settings user layer over the Cordis config (P0-01), then
        // keep the live session in sync with later /settings edits. `session`
        // shares the `effective` reference, so updating its config is enough.
        const applyEffective = (layer: Partial<BrowserUseConfig> | undefined): void => {
          if (!layer) return
          const next = mergeConfig(effective, layer)
          session.config.visionMode = next.visionMode
          if (next.viewport) {
            session.config.viewport = next.viewport
            // R-07: a mid-session `/settings` viewport edit must resize the live
            // page (not just apply on the next session). No-op when the browser
            // isn't started yet — the next `ensureStarted()` reads the new value.
            void session.applyViewport(next.viewport)
          }
          session.config.screenshot = next.screenshot
          session.config.tiling = next.tiling
          session.config.providers = next.providers
          debug(`effective config applied (visionMode=${next.visionMode})`)
        }
        // Initial layer (settings.yaml) and every later /settings commit.
        applyEffective(scope.get?.())
        scope.watch?.((next) => applyEffective(next))
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
