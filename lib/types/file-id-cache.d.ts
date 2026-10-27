/**
 * dsh-tui-browser-use — scoped file_id cache.
 *
 * Reuses one DeepSeek file_id per distinct image payload so repeated requests
 * carrying the same screenshot hit the provider's disk cache (the `file_id` is a
 * stable token in the prompt prefix). The cache is scoped by a key derived from
 * the endpoint / provider / model + a credential fingerprint, so switching
 * transports never reuses a file_id from another platform or account — which
 * would fail the request or, worse, leak content across accounts.
 *
 * The scope key is a single sha256 hash. The original API key never appears in
 * a log or a plain string; only a hash fingerprint is folded in.
 */
/**
 * Build a scope key from the transport identity. `apiKey` is hashed before it
 * ever leaves the function — only the fingerprint is folded into the scope key,
 * so the raw secret is never stored or logged.
 */
export declare function fileIdScopeKey(baseUrl: string, provider: string, model: string, apiKey: string): string;
/**
 * A bounded, scope-aware file_id cache. Per-scope it caps at `MAX_PER_SCOPE`
 * (LRU by insertion order); globally it caps at `MAX_SCOPES` scopes (LRU by
 * last use), so switching between many endpoints/accounts never grows unbounded.
 * Entries also carry the provider-side expiry: a file uploaded with
 * `expires_after` (default 24h) must NOT be reused once it may be gone.
 */
export declare class FileIdCache {
    private scopes;
    private tick;
    /** Look up a live cached file_id for a scope + content hash. */
    get(scopeKey: string, contentHash: string): string | undefined;
    /** Store a file_id for a scope + content hash, evicting as needed. */
    set(scopeKey: string, contentHash: string, fileId: string, ttlMs?: number): void;
    /** Number of distinct scopes currently held. */
    get size(): number;
    /** Number of cached file_ids for a scope (diagnostics / tests). */
    scopeSize(scopeKey: string): number;
    /** Drop all entries (used by tests / when the session is torn down). */
    clear(): void;
}
//# sourceMappingURL=file-id-cache.d.ts.map