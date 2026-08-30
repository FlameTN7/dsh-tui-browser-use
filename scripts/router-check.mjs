#!/usr/bin/env node
import assert from 'node:assert/strict'
import { resolveProvider, resolveRoute, resolveTransfer, KNOWN_PROVIDERS } from '../lib/types/provider-router.js'
import { detectCapability, isVisionCapableModel } from '../lib/types/capabilities.js'

assert.equal(resolveProvider(false), 'deepseek', 'default provider deepseek')
assert.equal(resolveProvider(true), 'deepseek', 'forced file-api provider deepseek')

const ds = resolveRoute('deepseek')
assert.equal(ds.baseURL, 'https://api.deepseek.com')
assert.equal(ds.apiKeyEnv, 'DEEPSEEK_API_KEY')
assert.equal(ds.defaultModel, 'deepseek-v4-flash-vision-exp')
assert.equal(ds.api, 'deepseek')

// Unknown providers are generic OpenAI-compatible routes and must never fall
// back to a DeepSeek key or model — the caller overrides model/baseURL/key.
const unknown = resolveRoute('newprovider')
assert.equal(unknown.baseURL, 'https://api.openai.com/v1')
assert.equal(unknown.apiKeyEnv, 'OPENAI_API_KEY')
assert.equal(unknown.defaultModel, '')
assert.equal(unknown.api, 'openai-completions')

assert.equal(resolveTransfer('deepseek', false), 'file')
assert.equal(resolveTransfer('deepseek', true), 'file')
assert.equal(resolveTransfer('unknown', false), 'base64')
assert.equal(resolveTransfer('unknown', true), 'file')

// Any non-built-in provider id resolves to the generic unknown route, never DeepSeek.
const legacy = resolveRoute('legacy-provider')
assert.equal(legacy.baseURL, 'https://api.openai.com/v1')
assert.equal(legacy.apiKeyEnv, 'OPENAI_API_KEY')
assert.equal(legacy.defaultModel, '')

// Pure name-based helper (kept for tests/docs; NOT the runtime path). It only
// looks for a `vision|vl|visual` hint, so gpt-4o/5 / claude-4 / gemini-3 are
// "no hint" here — that's expected; detectCapability below is the real judge.
assert.equal(isVisionCapableModel('deepseek', 'deepseek-v4-flash-vision-exp'), true, 'vision exp model')
assert.equal(isVisionCapableModel('deepseek', 'deepseek-v4-flash'), false, 'text-only deepseek-v4-flash')
assert.equal(isVisionCapableModel('openai', 'gpt-4-vision-preview'), true, 'model-name fallback (vision)')
assert.equal(isVisionCapableModel('unknown', 'DeepSeek-V4-Flash-0731'), false, 'text-only flash')

// detectCapability is the single runtime entry: it applies user override →
// built-in model-family table → name fallback → default no vision.
// Text-only DeepSeek model must short-circuit (AGENTS.md §6).
assert.equal(detectCapability('deepseek', 'deepseek-v4-flash', []).supportsVision, false, 'deepseek-v4-flash text-only short-circuit')
assert.equal(detectCapability('deepseek', 'deepseek-v4-flash-vision-exp', []).supportsVision, true, 'deepseek vision exp')

// Modern multimodal families that don't carry a "vision" name must be detected.
assert.equal(detectCapability('openai', 'gpt-4o', []).supportsVision, true, 'openai gpt-4o multimodal')
assert.equal(detectCapability('openai', 'gpt-5', []).supportsVision, true, 'openai gpt-5 multimodal')
assert.equal(detectCapability('anthropic', 'claude-4-5-sonet', []).supportsVision, true, 'anthropic claude-4 multimodal')
assert.equal(detectCapability('google', 'gemini-3.1-pro', []).supportsVision, true, 'google gemini-3 multimodal')

// Empty model on an unknown route defaults to no vision (must set DSH_TUI_BROWSER_MODEL).
assert.equal(detectCapability('unknown-route', '', []).supportsVision, false, 'empty model → no vision')
assert.equal(detectCapability('openai', '', []).supportsVision, false, 'empty model on known provider → no vision')

// User override wins over the built-in table (both directions).
assert.equal(detectCapability('openai', 'gpt-4o', [{ provider: 'openai', supportsVision: false, imageTransfer: 'none' }]).supportsVision, false, 'override false wins')
assert.equal(detectCapability('deepseek', 'deepseek-v4-flash', [{ provider: 'deepseek', supportsVision: true, imageTransfer: 'file' }]).supportsVision, true, 'override true forces vision')

console.log('[router-check] OK: providers=' + JSON.stringify(KNOWN_PROVIDERS))
