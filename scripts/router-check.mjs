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

const xm = resolveRoute('xiaomi')
assert.equal(xm.baseURL, 'https://api.xiaomimimo.com/v1')
assert.equal(xm.apiKeyEnv, 'XIAOMI_API_KEY')
assert.equal(xm.defaultModel, 'mimo-v2.5')

const unknown = resolveRoute('newprovider')
assert.equal(unknown.baseURL, 'https://api.openai.com/v1')
assert.equal(unknown.apiKeyEnv, 'DEEPSEEK_API_KEY')
assert.equal(unknown.defaultModel, 'deepseek-v4-flash-vision-exp')

assert.equal(resolveTransfer('deepseek', false), 'file')
assert.equal(resolveTransfer('xiaomi', false), 'base64')
assert.equal(resolveTransfer('deepseek', true), 'file')
assert.equal(resolveTransfer('xiaomi', true), 'file')
assert.equal(resolveTransfer('unknown', false), 'base64')

// scnet was removed (provider now invalid). It resolves to unknown → openai-completions.
const sc = resolveRoute('scnet')
assert.equal(sc.baseURL, 'https://api.openai.com/v1')
assert.equal(sc.apiKeyEnv, 'DEEPSEEK_API_KEY')

// Model vision capability
assert.equal(isVisionCapableModel('deepseek', 'deepseek-v4-flash-vision-exp'), true, 'vision exp model')
assert.equal(isVisionCapableModel('deepseek', 'deepseek-v4-flash'), false, 'text-only deepseek-v4-flash')
assert.equal(isVisionCapableModel('xiaomi', 'mimo-v2.5'), true, 'mimo multimodal by explicit id')
assert.equal(isVisionCapableModel('scnet', 'DeepSeek-V4-Flash-0731'), false, 'text-only flash')

const cap = detectCapability('deepseek', 'deepseek-v4-flash', [])
assert.equal(cap.supportsVision, true, 'deepseek builtin claims vision (route-level)')

console.log('[router-check] OK: providers=' + JSON.stringify(KNOWN_PROVIDERS))
