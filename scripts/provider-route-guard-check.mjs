#!/usr/bin/env node
/**
 * dsh-tui-browser-use — provider routing guard regression.
 *
 * The runtime guard in `index.ts#resolveVisionEnv` blocks a non-deepseek /
 * non-openai provider that has NO explicit `DSH_TUI_BROWSER_BASE_URL`, because
 * `resolveRoute` would otherwise fall back to OpenAI's default endpoint and
 * silently POST a foreign model (claude/gemini/custom) there with the OpenAI
 * key — the misroute the AGENTS.md §6 contract forbids. This test pins the
 * guard decision (`hasRoutableBaseUrl`) AND the surrounding facts: the model is
 * still detected as vision-capable (so the block is the only thing stopping the
 * misroute), while `resolveRoute`'s OpenAI-compatible default contract stays
 * unchanged (so `router-check.mjs`'s assertions keep holding).
 *
 * Run: `node --import tsx/esm scripts/provider-route-guard-check.mjs`
 */
import assert from 'node:assert/strict'
import { resolveRoute, hasRoutableBaseUrl } from '../src/provider-router.js'
import { detectCapability } from '../src/capabilities.js'

// 1. hasRoutableBaseUrl: the guard decision. deepseek/openai have endpoints of
//    their own; any other provider REQUIRES an explicit base URL override.
assert.equal(hasRoutableBaseUrl('deepseek', undefined), true, 'deepseek has a built-in route')
assert.equal(hasRoutableBaseUrl('openai', undefined), true, 'openai has the OpenAI-compatible default')
assert.equal(hasRoutableBaseUrl('anthropic', undefined), false, 'anthropic without base URL is NOT routable')
assert.equal(hasRoutableBaseUrl('google', ''), false, 'google without base URL is NOT routable')
assert.equal(hasRoutableBaseUrl('anthropic', 'https://gw.example'), true, 'anthropic WITH base URL is routable')
assert.equal(hasRoutableBaseUrl('custom', 'http://127.0.0.1:8080/v1'), true, 'custom with base URL is routable')

// 2. The provider is still detected as vision-capable (so the ONLY thing that
//    stops the misroute is the guard — not a capability miss).
const provider = 'anthropic'
const route = resolveRoute(provider, { model: 'claude-3-5-sonnet' })
assert.equal(route.baseURL, 'https://api.openai.com/v1', 'resolveRoute contract unchanged (OpenAI-compatible default)')
assert.equal(route.apiKeyEnv, 'OPENAI_API_KEY', 'known unknown-provider key env')
assert.equal(detectCapability(provider, route.defaultModel, []).supportsVision, true, 'claude detected as vision-capable')

// 3. Without the guard the route would be sendable; WITH it the runtime blocks.
assert.equal(hasRoutableBaseUrl(provider, undefined), false, 'guard blocks the anthropic→OpenAI misroute')

// 4. The deepseek text-only short-circuit still works (unrelated to the guard).
assert.equal(detectCapability('deepseek', 'deepseek-v4-flash', []).supportsVision, false, 'deepseek text-only short-circuit')

console.log('[provider-route-guard-check] ALL PASS')
