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
import type { ImageTransfer } from './types.js';
/** One resolved provider route. */
export interface ProviderRouteInfo {
    /** Provider id, also the env-var override selector. */
    provider: string;
    /** Base URL for chat/completions (and the DeepSeek Files API). */
    baseURL: string;
    /** Environment-variable name carrying the credential for this provider. */
    apiKeyEnv: string;
    /** Default vision-capable model id for this provider. */
    defaultModel: string;
    /** Wire protocol, when one is worth naming for diagnostics. */
    api?: string;
}
/** The canonical provider ids this plugin ships built-in. */
export declare const KNOWN_PROVIDERS: string[];
/**
 * Resolve the active provider id. Priority: `deepseek-file-api` vision mode
 * forces the official DeepSeek (the only path using the Files API), then the
 * `providerOverride` (resolved from `DSH_TUI_BROWSER_PROVIDER` by the runtime
 * env), then the caller-chosen default.
 */
export declare function resolveProvider(forceFileApi: boolean, providerOverride?: string): string;
/**
 * Resolve the full route info for a provider, applying overrides for the base
 * URL and model (so a user can point at a gateway without editing code). The
 * overrides come from the runtime env (`DSH_TUI_BROWSER_BASE_URL` / `_MODEL`).
 * Unknown providers get a permissive OpenAI-compatible route (base64 inline)
 * with a generic `OPENAI_API_KEY` credential env; they must also set a model —
 * an unknown route never falls back to a DeepSeek model or key, because that
 * would send the wrong credentials/model to a foreign endpoint.
 */
export declare function resolveRoute(provider: string, overrides?: {
    baseUrl?: string;
    model?: string;
}): ProviderRouteInfo;
/**
 * Whether a provider route has a routable base URL without an explicit
 * override. Only the built-in `deepseek` route and the `openai` OpenAI-
 * compatible default have an endpoint of their own. Any other provider
 * (anthropic/google/custom) MUST supply an explicit `DSH_TUI_BROWSER_BASE_URL`,
 * otherwise defaulting to OpenAI's endpoint would silently misroute a foreign
 * model there with the OpenAI key (AGENTS.md §6). The runtime guard in
 * `index.ts#resolveVisionEnv` short-circuits on `false` and degrades to DOM.
 */
export declare function hasRoutableBaseUrl(provider: string, baseUrlOverride: string | undefined): boolean;
/** Resolve the transfer mode for a provider (env override wins over base route). */
export declare function resolveTransfer(provider: string, forceFileApi: boolean): ImageTransfer;
//# sourceMappingURL=provider-router.d.ts.map