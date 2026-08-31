/**
 * vision-capability-check — pure-logic regression for P1-12 (1.2).
 *
 * `detectCapability()` is now the single runtime entry for vision support. It
 * must accept modern multimodal models that don't carry "vision" in their name
 * (gpt-5, claude-4-5-sonet, gemini-3.1-pro) while STILL short-circuiting a
 * text-only DeepSeek model (deepseek-v4-flash) to DOM (AGENTS.md §6), and let a
 * user `providers[]` override win in both directions. Locks proposal §5.1.
 *
 * Run: `node --import tsx/esm scripts/vision-capability-check.mjs`
 */
import assert from 'node:assert/strict'

const { detectCapability, isVisionCapableModel } = await import('../src/capabilities.js')

// 1. Modern multimodal families without a "vision" name are detected.
{
  assert.equal(detectCapability('openai', 'gpt-4o', []).supportsVision, true, 'openai gpt-4o')
  assert.equal(detectCapability('openai', 'gpt-5', []).supportsVision, true, 'openai gpt-5')
  assert.equal(detectCapability('openai', 'gpt-4.1-mini', []).supportsVision, true, 'openai gpt-4.1')
  assert.equal(detectCapability('anthropic', 'claude-4-5-sonet', []).supportsVision, true, 'anthropic claude-4')
  assert.equal(detectCapability('google', 'gemini-3.1-pro', []).supportsVision, true, 'google gemini-3')
  console.log('[1] vision-capable multimodal families detected — OK')
}

// 2. Text-only DeepSeek model still short-circuits (AGENTS.md §6 hard constraint).
{
  assert.equal(detectCapability('deepseek', 'deepseek-v4-flash', []).supportsVision, false, 'deepseek-v4-flash text-only')
  assert.equal(detectCapability('deepseek', 'deepseek-v4-flash-vision-exp', []).supportsVision, true, 'deepseek vision exp')
  console.log('[2] deepseek text-model short-circuit preserved — OK')
}

// 3. Empty model → no vision (unknown route must set DSH_TUI_BROWSER_MODEL).
{
  assert.equal(detectCapability('unknown-route', '', []).supportsVision, false, 'unknown route empty model')
  assert.equal(detectCapability('openai', '', []).supportsVision, false, 'known provider empty model')
  console.log('[3] empty model degrades to no vision — OK')
}

// 4. User override wins in BOTH directions (override false + override true).
{
  const off = detectCapability('openai', 'gpt-4o', [{ provider: 'openai', supportsVision: false, imageTransfer: 'none' }])
  assert.equal(off.supportsVision, false, 'override false wins over builtin')

  const on = detectCapability('deepseek', 'deepseek-v4-flash', [{ provider: 'deepseek', supportsVision: true, imageTransfer: 'file' }])
  assert.equal(on.supportsVision, true, 'override true forces vision')
  console.log('[4] provider override wins in both directions — OK')
}

// 5. Override transfer is honoured; detail is ALWAYS high (proposal §5.5
//    prohibits `low` for page screenshots — the schema rejects it).
{
  const cap = detectCapability('openai', 'gpt-5', [{ provider: 'openai', supportsVision: true, imageTransfer: 'url', detailPreference: 'auto' }])
  assert.equal(cap.imageTransfer, 'url', 'override imageTransfer honoured')
  assert.equal(cap.detail, 'high', 'detail is pinned high regardless of preference')
  console.log('[5] override imageTransfer honoured + detail pinned high — OK')
}

// 6. isVisionCapableModel remains a pure name-only helper (not the runtime path).
{
  assert.equal(isVisionCapableModel('openai', 'gpt-4-vision-preview'), true, 'name fallback true')
  assert.equal(isVisionCapableModel('openai', 'gpt-4o'), false, 'name-only helper sees no hint on gpt-4o')
  console.log('[6] isVisionCapableModel stays name-only — OK')
}

console.log('\n[vision-capability-check] ALL PASS')
process.exit(0)
