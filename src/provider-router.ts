/**
 * dsh-tui-browser-use — provider route resolution.
 *
 * The vision path must route to the provider the harness is using, not a
 * hard-coded deepseek. This module owns that routing: it carries the built-in
 * route for the official DeepSeek (endpoint, credential environment name,
 * default vision model, Files-API transfer), and resolves env-var overrides on
 * top so an OpenAI-compatible gateway can be pointed at without editing code.
 *
 * The route table lives here rather than being read from a harness settings
 * namespace because the llm-pi-ai namespace is not registered on the settings
 * service (verified at runtime: `settings.get('llm-pi-ai')` is null and
 * `settings.describe()` lists no namespaces). Reading another plugin's
 * namespace would also couple this plugin to an unrelated bundle. The table is
 * the plugin's own contract; users override it through the same env vars the
 * rest of the plugin honours.
 *
 * This module is pure: it never calls the network and never reads a secret
 * value. The caller (index.ts) resolves the API key through the harness
 * credentials seam (`ctx.credentials.resolve`).
 */

import type { ImageTransfer } from './types.js'

/** One resolved provider route. */
export interface ProviderRouteInfo {
  /** Provider id, also the env-var override selector. */
  provider: string
  /** Base URL for chat/completions (and the DeepSeek Files API). */
  baseURL: string
  /** Environment-variable name carrying the credential for this provider. */
  apiKeyEnv: string
  /** Default vision-capable model id for this provider. */
  defaultModel: string
  /** Wire protocol, when one is worth naming for diagnostics. */
  api?: string
}

/** Built-in route table: official DeepSeek only. Other endpoints are reached
 * through the env overrides below as generic OpenAI-compatible routes. */
const ROUTES: Record<string, ProviderRouteInfo> = {
  deepseek: {
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v4-flash-vision-exp',
    api: 'deepseek',
  },
}

/** The canonical provider ids this plugin ships built-in. */
export const KNOWN_PROVIDERS = Object.keys(ROUTES)

/** Known provider → transfer capability (mirrors capabilities.ts BUILTIN). */
const TRANSFER: Record<string, ImageTransfer> = {
  deepseek: 'file',
}

/** Effective override env var names (values should never be logged). */
export const ROUTE_ENV = {
  provider: 'DSH_TUI_BROWSER_PROVIDER',
  model: 'DSH_TUI_BROWSER_MODEL',
  baseUrl: 'DSH_TUI_BROWSER_BASE_URL',
  executable: 'DSH_TUI_BROWSER_EXECUTABLE',
  proxy: 'DSH_TUI_BROWSER_PROXY',
} as const

/** Read `process.env` for one of the route overrides; empty/absent yields undefined. */
function envOf(name: string): string | undefined {
  const v = process.env[name]
  return v && v.length > 0 ? v : undefined
}

/** Confirm a string is a non-empty provider id in the route table. */
function isKnownProvider(p: string): p is keyof typeof ROUTES {
  return Object.prototype.hasOwnProperty.call(ROUTES, p)
}

/**
 * Resolve the active provider id. Priority: `deepseek-file-api` vision mode
 * forces the official DeepSeek (the only path using the Files API), then the
 * `DSH_TUI_BROWSER_PROVIDER` env override, then the caller-chosen default.
 */
export function resolveProvider(forceFileApi: boolean): string {
  if (forceFileApi) return 'deepseek'
  return envOf(ROUTE_ENV.provider) ?? 'deepseek'
}

/**
 * Resolve the full route info for a provider, applying env overrides for the
 * base URL and model (so a user can point at a gateway without editing code).
 * Unknown providers get a permissive OpenAI-compatible route (base64 inline)
 * with a generic `OPENAI_API_KEY` credential env; they must also set
 * `DSH_TUI_BROWSER_MODEL` — an unknown route never falls back to a DeepSeek
 * model or key, because that would send the wrong credentials/model to a
 * foreign endpoint.
 */
export function resolveRoute(provider: string): ProviderRouteInfo {
  const known = isKnownProvider(provider) ? ROUTES[provider] : undefined
  const baseURL = envOf(ROUTE_ENV.baseUrl) ?? known?.baseURL ?? 'https://api.openai.com/v1'
  const model = envOf(ROUTE_ENV.model) ?? known?.defaultModel ?? ''
  const apiKeyEnv = known?.apiKeyEnv ?? 'OPENAI_API_KEY'
  const api = known?.api ?? 'openai-completions'
  return { provider, baseURL, apiKeyEnv, defaultModel: model, api }
}

/** Resolve the transfer mode for a provider (env override wins over base route). */
export function resolveTransfer(provider: string, forceFileApi: boolean): ImageTransfer {
  if (forceFileApi) return 'file'
  return TRANSFER[provider] ?? 'base64'
}
