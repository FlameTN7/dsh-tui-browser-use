/**
 * usage-accumulate-check — pure-logic regression for P1-05 (usage accumulation).
 *
 * Verifies `accumulateUsage` sums token/visual/cost across `browser_task` steps
 * and is idempotent with an empty starting accumulator.
 *
 * Run: `node --import tsx/esm scripts/usage-accumulate-check.mjs`
 */
import assert from 'node:assert/strict'

const { accumulateUsage } = await import('../src/tools.js')

const u = (over) => ({
  model: 'm', visionMode: 'auto', imagesSent: 0, promptTokens: 0, completionTokens: 0,
  promptCacheHitTokens: 0, promptCacheMissTokens: 0, costUsd: 0, costCny: 0, ...over,
})

// 1. Starting from no accumulator → the first usage is copied through.
{
  const first = u({ imagesSent: 2, promptTokens: 10, costUsd: 0.01 })
  const acc = accumulateUsage(undefined, first)
  assert.equal(acc.imagesSent, 2)
  assert.equal(acc.promptTokens, 10)
  assert.equal(acc.costUsd, 0.01)
  console.log('[1] empty accumulator copies first usage — OK')
}

// 2. Sequential accumulation sums each field (the browser_task loop).
{
  let acc
  acc = accumulateUsage(acc, u({ imagesSent: 1, promptTokens: 10, completionTokens: 5, promptCacheHitTokens: 1, promptCacheMissTokens: 2, costUsd: 0.01, costCny: 0.072 }))
  acc = accumulateUsage(acc, u({ imagesSent: 2, promptTokens: 20, completionTokens: 8, promptCacheHitTokens: 3, promptCacheMissTokens: 5, costUsd: 0.02, costCny: 0.144 }))
  assert.equal(acc.imagesSent, 3)
  assert.equal(acc.promptTokens, 30)
  assert.equal(acc.completionTokens, 13)
  assert.equal(acc.promptCacheHitTokens, 4)
  assert.equal(acc.promptCacheMissTokens, 7)
  assert.ok(Math.abs(acc.costUsd - 0.03) < 1e-9)
  assert.ok(Math.abs(acc.costCny - 0.216) < 1e-9)
  console.log('[2] sequential accumulation sums fields — OK')
}

// 3. `undefined` u → returns a zero-filled default (not a crash).
{
  const zero = accumulateUsage(u({ imagesSent: 1 }), undefined)
  assert.equal(zero.imagesSent, 1)
  assert.equal(zero.promptTokens, 0)
  console.log('[3] accumulateUsage with undefined u returns full default — OK')
}

console.log('\n[usage-accumulate-check] ALL PASS')
process.exit(0)
