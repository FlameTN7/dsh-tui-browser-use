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

import { createHash } from 'node:crypto'

/**
 * Build a scope key from the transport identity. `apiKey` is hashed before it
 * ever leaves the function — only the fingerprint is folded into the scope key,
 * so the raw secret is never stored or logged.
 */
export function fileIdScopeKey(baseUrl: string, provider: string, model: string, apiKey: string): string {
  const keyFp = apiKey ? createHash('sha256').update(apiKey).digest('hex').slice(0, 16) : ''
  return createHash('sha256').update(`${baseUrl}|${provider}|${model}|${keyFp}`).digest('hex')
}

interface ScopeEntry {
  map: Map<string, string> // contentHash → file_id
  lastUsed: number
}

/** Max cached file_ids per scope (kept at the original per-image cap). */
const MAX_PER_SCOPE = 64
/** Max distinct scopes before LRU eviction (bounds memory across accounts). */
const MAX_SCOPES = 8

/**
 * A bounded, scope-aware file_id cache. Per-scope it caps at `MAX_PER_SCOPE`
 * (LRU by insertion order); globally it caps at `MAX_SCOPES` scopes (LRU by
 * last use), so switching between many endpoints/accounts never grows unbounded.
 */
export class FileIdCache {
  private scopes = new Map<string, ScopeEntry>()
  private tick = 0

  /** Look up a cached file_id for a scope + content hash. */
  get(scopeKey: string, contentHash: string): string | undefined {
    const sc = this.scopes.get(scopeKey)
    if (!sc) return undefined
    sc.lastUsed = ++this.tick
    return sc.map.get(contentHash)
  }

  /** Store a file_id for a scope + content hash, evicting as needed. */
  set(scopeKey: string, contentHash: string, fileId: string): void {
    let sc = this.scopes.get(scopeKey)
    if (!sc) {
      sc = { map: new Map(), lastUsed: ++this.tick }
      this.scopes.set(scopeKey, sc)
    }
    sc.map.set(contentHash, fileId)
    sc.lastUsed = ++this.tick

    // Per-scope cap: drop the insertion-oldest entry.
    if (sc.map.size > MAX_PER_SCOPE) {
      const oldest = sc.map.keys().next().value
      if (oldest !== undefined) sc.map.delete(oldest)
    }

    // Global scope cap (LRU by last use).
    if (this.scopes.size > MAX_SCOPES) {
      let lruKey: string | undefined
      let lruTick = Infinity
      for (const [k, e] of this.scopes) {
        if (e.lastUsed < lruTick) {
          lruTick = e.lastUsed
          lruKey = k
        }
      }
      if (lruKey !== undefined) this.scopes.delete(lruKey)
    }
  }

  /** Number of distinct scopes currently held. */
  get size(): number {
    return this.scopes.size
  }

  /** Number of cached file_ids for a scope (diagnostics / tests). */
  scopeSize(scopeKey: string): number {
    return this.scopes.get(scopeKey)?.map.size ?? 0
  }

  /** Drop all entries (used by tests / when the session is torn down). */
  clear(): void {
    this.scopes.clear()
  }
}
