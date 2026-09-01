/**
 * extract-retry-check — pure-logic test for `extractWithRetry` (P0-4).
 *
 * Exercises the validate-on-failure retry loop with a fake `call`, so it runs
 * without a browser, a live model, or the DeepSeek key. Covers:
 *   1. first attempt valid → single call, attempts=1
 *   2. prose reply then valid JSON → attempts=2
 *   3. schema-violating reply then valid JSON → attempts=2 (and retry carries the violation)
 *   4. all attempts fail → throws with the last error
 *
 * Run: `node --import tsx/esm scripts/extract-retry-check.mjs`
 */
import assert from 'node:assert/strict'

const { extractWithRetry } = await import('../src/tools.js')
const { validateJsonSchema } = await import('../src/schema-validate.js')

const schema = {
  type: 'object',
  properties: { heading: { type: 'string' }, links: { type: 'array' } },
  required: ['heading'],
  additionalProperties: false,
}

// Track instructions seen so we can assert the retry carries the violation.
function makeCall(responses, seen) {
  let i = 0
  return async (instruction) => {
    seen.push(instruction)
    const r = responses[Math.min(i, responses.length - 1)]
    i += 1
    return { insight: r, usage: { model: 'test', visionMode: 'auto', imagesSent: 1, promptTokens: 0, completionTokens: 0, costUsd: 0, costCny: 0 } }
  }
}

// 1. first attempt valid
{
  const seen = []
  const r = await extractWithRetry(makeCall(['{"heading":"Hi","links":[]}'], seen), schema, 'BASE')
  assert.equal(r.attempts, 1)
  assert.deepEqual(r.data, { heading: 'Hi', links: [] })
  assert.equal(seen.length, 1)
  console.log('[1] valid-first pass: attempts=1, single call')
}

// 2. prose then valid → retry once, attempt 2 instruction appended
{
  const seen = []
  const r = await extractWithRetry(makeCall(['Sorry, I could not read. The page has a heading "Hi" and no links.', '{"heading":"Hi","links":[]}'], seen), schema, 'BASE')
  assert.equal(r.attempts, 2)
  assert.deepEqual(r.data, { heading: 'Hi', links: [] })
  assert.equal(seen.length, 2)
  assert.match(seen[1], /not a JSON object satisfying the schema/)
  console.log('[2] prose→valid pass: attempts=2, retry carries rewording hint')
}

// 3. schema-violating then valid → retry, attempt 2 carries the violation text
{
  const seen = []
  const r = await extractWithRetry(makeCall(['{"heading":"Hi","extra":1,"links":[]}', '{"heading":"Hi","links":[]}'], seen), schema, 'BASE')
  assert.equal(r.attempts, 2)
  assert.deepEqual(r.data, { heading: 'Hi', links: [] })
  assert.equal(seen.length, 2)
  assert.match(seen[1], /additional property not allowed/)
  console.log('[3] schema-violate→valid pass: attempts=2, retry carries violation list')
}

// 4. all attempts fail → throws with last error and the schema-validation code
{
  const seen = []
  const fn = makeCall(['prose 1', 'prose 2', 'prose 3'], seen)
  await assert.rejects(
    () => extractWithRetry(fn, schema, 'BASE'),
    (err) => /did not return parseable JSON/.test(err.message) && err.code === 'schema-validation-failed',
  )
  assert.equal(seen.length, 3)
  console.log('[4] all-fail pass: throws after 3 calls with schema-validation-failed code')
}

// 5. Sanity: validateJsonSchema still agrees with the helper (schema path)
{
  const violations = validateJsonSchema(schema, { heading: 'Hi' })
  assert.equal(violations.length, 0, 'valid object should have no violations')
  const bad = validateJsonSchema(schema, { heading: 'Hi', bogus: 1 })
  assert.ok(bad.some((v) => v.includes('additional property not allowed')))
  console.log('[5] validateJsonSchema sanity pass')
}

// 6. parseJsonReply: braces inside JSON strings do not end the scan; top-level
//    arrays are parseable when wrapped in prose.
{
  const { parseJsonReply } = await import('../src/schema-validate.js')
  assert.deepEqual(parseJsonReply('Result: {"x":"}","y":1} done'), { x: '}', y: 1 })
  assert.deepEqual(parseJsonReply('Result: [1,2,{"a":"["}] done'), [1, 2, { a: '[' }])
  console.log('[6] parseJsonReply string-brace + top-level array pass')
}

// 7. parseJsonReply: non-JSON prose with braces BEFORE the real JSON must not
//    cause a false undefined (regression for the bracket-scan fix).
{
  const { parseJsonReply } = await import('../src/schema-validate.js')
  // Text containing a brace block that is NOT JSON, then a valid JSON object.
  assert.deepEqual(parseJsonReply('Count: {n/a} but the data is {"heading":"Hi","links":[]}'), { heading: 'Hi', links: [] })
  // Text containing a non-JSON object before a valid JSON array.
  assert.deepEqual(parseJsonReply('Prefix {not json} then [1,2,3]'), [1, 2, 3])
  // Valid JSON with prose before AND after.
  assert.deepEqual(parseJsonReply('The page shows: {"a":1} (that is all)'), { a: 1 })
  console.log('[7] parseJsonReply skips non-JSON prose-braces pass')
}

console.log('\n[extract-retry-check] ALL PASS')
process.exit(0)
