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

// Model vision capability
assert.equal(isVisionCapableModel('deepseek', 'deepseek-v4-flash-vision-exp'), true, 'vision exp model')
assert.equal(isVisionCapableModel('deepseek', 'deepseek-v4-flash'), false, 'text-only deepseek-v4-flash')
assert.equal(isVisionCapableModel('openai', 'gpt-4-vision-preview'), true, 'model-name fallback (vision)')
assert.equal(isVisionCapableModel('openai', 'gpt-4o'), false, 'no vision hint → text-only route')
assert.equal(isVisionCapableModel('unknown', 'DeepSeek-V4-Flash-0731'), false, 'text-only flash')

const cap = detectCapability('deepseek', 'deepseek-v4-flash', [])
assert.equal(cap.supportsVision, true, 'deepseek builtin claims vision (route-level)')

console.log('[router-check] OK: providers=' + JSON.stringify(KNOWN_PROVIDERS))
