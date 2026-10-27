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
/** Built-in route table: official DeepSeek only. Other endpoints are reached
 * through the env overrides below as generic OpenAI-compatible routes. */
const ROUTES = {
    deepseek: {
        provider: 'deepseek',
        baseURL: 'https://api.deepseek.com',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        defaultModel: 'deepseek-v4-flash-vision-exp',
        api: 'deepseek',
    },
};
/** The canonical provider ids this plugin ships built-in. */
export const KNOWN_PROVIDERS = Object.keys(ROUTES);
/** Known provider → transfer capability (mirrors capabilities.ts BUILTIN). */
const TRANSFER = {
    deepseek: 'file',
};
/** Confirm a string is a non-empty provider id in the route table. */
function isKnownProvider(p) {
    return Object.prototype.hasOwnProperty.call(ROUTES, p);
}
/**
 * Resolve the active provider id. Priority: `deepseek-file-api` vision mode
 * forces the official DeepSeek (the only path using the Files API), then the
 * `providerOverride` (resolved from `DSH_TUI_BROWSER_PROVIDER` by the runtime
 * env), then the caller-chosen default.
 */
export function resolveProvider(forceFileApi, providerOverride) {
    if (forceFileApi)
        return 'deepseek';
    return providerOverride ?? 'deepseek';
}
/**
 * Resolve the full route info for a provider, applying overrides for the base
 * URL and model (so a user can point at a gateway without editing code). The
 * overrides come from the runtime env (`DSH_TUI_BROWSER_BASE_URL` / `_MODEL`).
 * Unknown providers get a permissive OpenAI-compatible route (base64 inline)
 * with a generic `OPENAI_API_KEY` credential env; they must also set a model —
 * an unknown route never falls back to a DeepSeek model or key, because that
 * would send the wrong credentials/model to a foreign endpoint.
 */
export function resolveRoute(provider, overrides) {
    const known = isKnownProvider(provider) ? ROUTES[provider] : undefined;
    const baseURL = overrides?.baseUrl ?? known?.baseURL ?? 'https://api.openai.com/v1';
    const model = overrides?.model ?? known?.defaultModel ?? '';
    const apiKeyEnv = known?.apiKeyEnv ?? 'OPENAI_API_KEY';
    const api = known?.api ?? 'openai-completions';
    return { provider, baseURL, apiKeyEnv, defaultModel: model, api };
}
/**
 * Whether a provider route has a routable base URL without an explicit
 * override. Only the built-in `deepseek` route and the `openai` OpenAI-
 * compatible default have an endpoint of their own. Any other provider
 * (anthropic/google/custom) MUST supply an explicit `DSH_TUI_BROWSER_BASE_URL`,
 * otherwise defaulting to OpenAI's endpoint would silently misroute a foreign
 * model there with the OpenAI key (AGENTS.md §6). The runtime guard in
 * `index.ts#resolveVisionEnv` short-circuits on `false` and degrades to DOM.
 */
export function hasRoutableBaseUrl(provider, baseUrlOverride) {
    return provider === 'deepseek' || provider === 'openai' || Boolean(baseUrlOverride);
}
/** Resolve the transfer mode for a provider (env override wins over base route). */
export function resolveTransfer(provider, forceFileApi) {
    if (forceFileApi)
        return 'file';
    return TRANSFER[provider] ?? 'base64';
}
//# sourceMappingURL=provider-router.js.map