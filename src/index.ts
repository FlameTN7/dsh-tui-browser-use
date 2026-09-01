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
import { registerTools } from './tools/registry.js'
import { registerSettingsSection } from './settings-section.js'
import { resolveProvider, resolveRoute } from './provider-router.js'
import { detectCapability } from './capabilities.js'
import { loadRuntimeEnv } from './runtime-env.js'
import { probeSecretAsync } from './secret-probe.js'
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
    maxTiles: Schema.number().min(1).default(24),
  }),
  providers: Schema.array(Schema.object({
    provider: Schema.string().required(),
    supportsVision: Schema.boolean().default(false),
    imageTransfer: Schema.union(['file', 'base64', 'url', 'none'] as const).default('none'),
    maxImageBytes: Schema.number().required(false),
    detailPreference: Schema.union(['high', 'auto'] as const).required(false),
  })).default([]),
  // Optional HTTP proxy for external sites. Empty falls back to the
  // `DSH_TUI_BROWSER_PROXY` env var at browser startup.
  proxy: Schema.string().required(false),
  // Session/profile management (Phase 3). Optional and absent by default, so
  // existing deployments keep the historical fresh-session behaviour. When set,
  // `mode` picks a managed profile; `profile` names the directory under the
  // profile root (validated as one safe path segment).
  session: Schema.object({
    mode: Schema.union(['persistent', 'isolated'] as const).default('isolated'),
    profile: Schema.string().default('default'),
  }).required(false),
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
    maxTiles: Schema.number().min(1).default(24),
  }),
  providers: Schema.array(Schema.object({
    provider: Schema.string().required(),
    supportsVision: Schema.boolean().default(false),
    imageTransfer: Schema.union(['file', 'base64', 'url', 'none'] as const).default('none'),
    maxImageBytes: Schema.number().required(false),
    detailPreference: Schema.union(['high', 'auto'] as const).required(false),
  })).default([]),
  proxy: Schema.string().required(false),
  session: Schema.object({
    mode: Schema.union(['persistent', 'isolated'] as const).default('isolated'),
    profile: Schema.string().default('default'),
  }).required(false),
})

// ── Harness access helpers (structural, never self-manage secrets) ──────

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
      // OR the source layout (`src/`) — the candidate walk covers both, so a
      // tsx-driven local run registers the skill too, not only the built lib.
      const here = dirname(fileURLToPath(import.meta.url))
      const skillFile = [
        join(here, '..', 'skills'),
        join(here, '..', '..', 'skills'),
        join(here, '..', '..', '..', 'skills'),
      ]
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
    proxy: layer.proxy ?? base.proxy,
    session: layer.session ?? base.session,
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
    proxy: config.proxy,
    ...(config.session ? { session: { ...config.session } } : {}),
  }

  // Centralised runtime environment (the single place env vars are read). All
  // DSH_TUI_* overrides live here; modules consume this value object instead of
  // reading `process.env` themselves (AGENTS.md §2 / 竞品 B3). The only env
  // reads that stay in this harness boundary are the async credentials seam
  // (`probeSecretAsync`) and the host UI language (`defaultLang`).
  const runtimeEnv = loadRuntimeEnv()

  // Resolve the vision request environment from the provider route table +
  // harness credentials. Provider/model can be overridden by env vars
  // (DSH_TUI_BROWSER_PROVIDER / _MODEL / _BASE_URL); the API key comes from
  // `ctx.credentials.resolve({ env: apiKeyEnv })` (async), falling back to env
  // vars. Missing key degrades vision to DOM (null).
  const resolveVisionEnv = async (): Promise<VisionEnv | null> => {
    const visionMode = effective.visionMode
    if (visionMode === 'off') return null

    const forceFileApi = visionMode === 'deepseek-file-api'
    const provider = resolveProvider(forceFileApi, runtimeEnv.providerOverride)
    const route = resolveRoute(provider, { baseUrl: runtimeEnv.baseUrlOverride, model: runtimeEnv.modelOverride })
    const currentModel = route.defaultModel

    // A non-deepseek, non-openai provider reaches a routable endpoint ONLY via
    // an explicit base URL override. Without one it silently lands on OpenAI's
    // default chat/completions URL (see resolveRoute), which would misroute a
    // foreign model (claude/gemini/custom) to OpenAI with the OpenAI key — the
    // exact "send the wrong credentials/model to a foreign endpoint" the
    // contract forbids (AGENTS.md §6). Degrade to DOM rather than misroute.
    if (provider !== 'deepseek' && provider !== 'openai' && !runtimeEnv.baseUrlOverride) {
      return null
    }

    // Single source of truth for vision support + transfer. Priority (proposal
    // §5.1): user override → provider declaration → built-in table (model-level
    // fine-tuning) → model-name fallback → default no vision. This correctly
    // accepts modern multimodal models that don't carry "vision" in their name
    // (gpt-5, claude-4-5-sonet, gemini-3.1-pro) while a text-only DeepSeek model
    // (deepseek-v4-flash) short-circuits to DOM, and a `supportsVision:false`
    // override still degrades to DOM (P1-01).
    const capability = detectCapability(provider, currentModel, effective.providers)
    if (!capability.supportsVision) return null

    // Non-deepseek routes must NOT fall back to the official DeepSeek key — a
    // different provider's credential would be sent to a foreign endpoint. Only
    // the deepseek route may use DEEPSEEK_API_KEY (P1-02).
    const apiKeyEnvs = provider === 'deepseek'
      ? [route.apiKeyEnv, 'DEEPSEEK_API_KEY', 'deepseek.apiKey', 'apiKey']
      : [route.apiKeyEnv, 'apiKey']
    const apiKey = await probeSecretAsync(ctx, apiKeyEnvs)
    if (!apiKey) return null

    // `DEEPSEEK_BASE_URL` is a DeepSeek-specific override: it must never steer
    // a non-deepseek provider's traffic to a DeepSeek endpoint (P1-02 / §6).
    const baseUrl = provider === 'deepseek'
      ? (runtimeEnv.deepseekBaseUrl || route.baseURL)
      : route.baseURL

    // Transfer mode: explicit `deepseek-file-api` wins, then the resolved
    // capability (which already honours the user provider override / table).
    const imageTransfer: ImageTransfer = forceFileApi ? 'file' : capability.imageTransfer

    return {
      baseUrl,
      apiKey,
      model: currentModel,
      imageTransfer,
      provider,
      currentModel,
      ...(capability.maxImageBytes !== undefined ? { maxImageBytes: capability.maxImageBytes } : {}),
    }
  }

  // Browser session, shared across all tool calls in this plugin fiber. Shares
  // the `effective` config reference so a live settings edit is reflected here.
  const session = new BrowserSession(effective, lang, runtimeEnv)

  // Register the toolset on the harness tool runtime. `visionMode` is a getter
  // so a live `/settings` change is honoured on the very next tool call.
  const disposer = registerTools(ctx, { session, resolveVisionEnv, visionMode: () => effective.visionMode, lang, runtimeEnv })

  // Register the dsh-tui settings section (soft-probed; may be absent).
  const debug = (msg: string): void => {
    if (runtimeEnv.debug) process.stderr.write(`[dsh-tui-browser-use] ${msg}\n`)
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
          proxy: config.proxy,
          ...(config.session ? { session: { ...config.session } } : {}),
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
          session.config.proxy = next.proxy
          session.config.session = next.session
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
  if (runtimeEnv.debug) {
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

  // Tear down the browser and settings when the plugin fiber stops. `close`
  // is queued onto the session's serial mutex so it drains AFTER any tool call
  // already dispatched by the harness — never interleaved with Playwright ops.
  // The cleanup MUST be async (Cordis awaits the returned promise); a sync
  // cleanup with `void session.run(...)` lets the process exit before the
  // storage-state snapshot is written, silently losing session cookies.
  ctx.effect(() => {
    return async () => {
      disposer?.()
      settingsDisposer?.()
      await session.run(() => session.close())
    }
  })

  debug(`plugin apply complete (visionMode=${config.visionMode})`)
}

export default { name, inject, Config, apply }

// ── Public programming surface (B1) ──────────────────────────────────────
// Third parties / the harness can drive the plugin programmatically or extend
// it by injecting a driver/adapter. The modules each re-export their own types
// and helpers; this entry re-exports the highest-level seams so an importer
// needs just one `import ... from 'dsh-tui-browser-use'`.

// Runtime seams.
export { BrowserSession, BrowserToolError } from './browser.js'
export { buildToolDefinitions } from './tools.js'
export { registerTools } from './tools/registry.js'
export { createPlaywrightDriver } from './driver/playwright-driver.js'
export { createVisionAdapter } from './vision/vision-adapter.js'
export { effectiveViewport, detectCapability } from './capabilities.js'

// Re-exports so tool consumers can type against the contract.
export type { BrowserUseConfig, ProviderOverride, ImageTransfer, VisionMode, ScreenshotFormat, TilingMode }
export type { ResultEnvelope, Usage, ErrorCode } from './types.js'
