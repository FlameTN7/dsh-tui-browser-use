/**
 * file-cache-scope-check — pure-logic regression for P1-14 (1.4).
 *
 * The global file_id cache must be isolated by endpoint/provider/model + a
 * credential fingerprint (scope), so switching transports never reuses a
 * file_id from another platform/account (which would 400 on the request or leak
 * content across accounts). Verifies:
 *   1. different scope → same content hash does NOT hit;
 *   2. same scope → hit;
 *   3. fileIdScopeKey differs across baseURL / provider / model / apiKey;
 *   4. per-scope cap (64) and global LRU eviction (8 scopes) stay bounded.
 *
 * Run: `node --import tsx/esm scripts/file-cache-scope-check.mjs`
 */
import assert from 'node:assert/strict'

const { FileIdCache, fileIdScopeKey } = await import('../src/file-id-cache.js')

const HASH_A = 'content-hash-aaaa'
const HASH_B = 'content-hash-bbbb'

// 1. Different scope → same content hash does NOT hit (no cross-account leak).
{
  const cache = new FileIdCache()
  const scopeA = fileIdScopeKey('https://api.deepseek.com', 'deepseek', 'm1', 'key1')
  const scopeB = fileIdScopeKey('https://api.openai.com/v1', 'openai', 'm2', 'key2')
  cache.set(scopeA, HASH_A, 'file_id_A')
  assert.equal(cache.get(scopeB, HASH_A), undefined, 'different scope must NOT hit')
  assert.equal(cache.get(scopeA, HASH_A), 'file_id_A', 'same scope must hit')
  console.log('[1] scope isolation: no cross-account reuse — OK')
}

// 2. fileIdScopeKey differs across every transport dimension (incl. apiKey).
{
  const base = fileIdScopeKey('https://api.deepseek.com', 'deepseek', 'deepseek-v4-flash-vision-exp', 'secret')
  assert.notEqual(base, fileIdScopeKey('https://api.openai.com/v1', 'deepseek', 'deepseek-v4-flash-vision-exp', 'secret'), 'baseURL differs')
  assert.notEqual(base, fileIdScopeKey('https://api.deepseek.com', 'openai', 'deepseek-v4-flash-vision-exp', 'secret'), 'provider differs')
  assert.notEqual(base, fileIdScopeKey('https://api.deepseek.com', 'deepseek', 'other-model', 'secret'), 'model differs')
  assert.notEqual(base, fileIdScopeKey('https://api.deepseek.com', 'deepseek', 'deepseek-v4-flash-vision-exp', 'other-secret'), 'apiKey differs')
  console.log('[2] fileIdScopeKey discriminates baseURL/provider/model/key — OK')
}

// 3. Same scope key is deterministic (same transport → same key).
{
  const a = fileIdScopeKey('https://api.deepseek.com', 'deepseek', 'm1', 'key1')
  const b = fileIdScopeKey('https://api.deepseek.com', 'deepseek', 'm1', 'key1')
  assert.equal(a, b, 'deterministic scope key')
  console.log('[3] fileIdScopeKey deterministic — OK')
}

// 4. Per-scope cap (64) drops the insertion-oldest entry.
{
  const cache = new FileIdCache()
  const scope = fileIdScopeKey('https://api.deepseek.com', 'deepseek', 'm1', 'key1')
  for (let i = 0; i < 70; i++) cache.set(scope, `hash-${i}`, `fid-${i}`)
  assert.equal(cache.scopeSize(scope), 64, 'per-scope cap of 64')
  assert.equal(cache.get(scope, 'hash-0'), undefined, 'oldest evicted')
  assert.equal(cache.get(scope, 'hash-63'), 'fid-63', 'newer kept')
  console.log('[4] per-scope cap (64) with eviction — OK')
}

// 5. Global scope cap (8) uses LRU by last use.
{
  const cache = new FileIdCache()
  const scopes = []
  for (let i = 0; i < 12; i++) {
    const s = fileIdScopeKey(`https://host${i}.com`, 'p', 'm', 'k')
    scopes.push(s)
    cache.set(s, HASH_A, `fid-${i}`)
  }
  assert.equal(cache.size, 8, 'global scope cap of 8')
  // The 4 oldest scopes (host0..host3) were evicted; recent ones survive.
  assert.equal(cache.get(scopes[0], HASH_A), undefined, 'host0 evicted')
  assert.equal(cache.get(scopes[11], HASH_A), 'fid-11', 'host11 kept')
  console.log('[5] global scope cap (8) with LRU eviction — OK')
}

// 6. clear() resets.
{
  const cache = new FileIdCache()
  const scope = fileIdScopeKey('https://api.deepseek.com', 'deepseek', 'm1', 'k')
  cache.set(scope, HASH_A, 'fid')
  assert.equal(cache.size, 1)
  cache.clear()
  assert.equal(cache.size, 0)
  console.log('[6] clear() resets — OK')
}

console.log('\n[file-cache-scope-check] ALL PASS')
process.exit(0)
