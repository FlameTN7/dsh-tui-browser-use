import assert from 'node:assert/strict'
import { BrowserSession } from '../src/browser.js'
import { buildToolDefinitions } from '../src/tools.js'
import { loadRuntimeEnv } from '../src/runtime-env.js'

const cases = [
  { url: 'https://alice:password-secret@example.test/a?token=token-secret&ok=1', hidden: ['password-secret', 'token-secret'], visible: 'ok=1' },
  { url: 'https://example.test/a?%74oken=encoded-secret&ok=1', hidden: ['encoded-secret'], visible: 'ok=1' },
  { url: '//alice:relative-password@example.test/a?token=relative-secret&ok=1', hidden: ['relative-password', 'relative-secret'], visible: 'ok=1' },
  { url: '/download?ticket=custom-secret&monkey=banana', keys: ['ticket'], hidden: ['custom-secret'], visible: 'monkey=banana' },
]

for (const { url, keys, hidden, visible } of cases) {
  const env = loadRuntimeEnv(() => undefined)
  if (keys) env.sensitiveQueryKeys = keys
  // Keep the real operation -> error envelope -> renderer path. Only the
  // external browser operation fails with a representative Playwright log.
  const failRequest = async () => { throw new Error(`net::ERR_CONNECTION_REFUSED at ${url}\nCall log:\n - navigating to "${url}"`) }
  const driver = { running: true, goto: failRequest, requestGet: failRequest }
  const session = new BrowserSession({}, 'en', env, driver)
  const tools = buildToolDefinitions({ session, runtimeEnv: env, lang: 'en' })
  for (const name of ['browser_navigate', 'browser_download']) {
    const tool = tools.find(t => t.name === name)
    const result = await tool.execute({ url })
    assert.equal(result.ok, false)
    const exposed = JSON.stringify([result, tool.output.render({}, result)])
    for (const secret of hidden) assert.ok(!exposed.includes(secret), `${name} leaked ${secret}`)
    assert.ok(exposed.includes('ERR_CONNECTION_REFUSED'), 'diagnostic remains useful')
    assert.ok(exposed.includes(visible), 'non-sensitive parameters remain')
  }
}
console.log('[error-redaction-check] ALL PASS')
