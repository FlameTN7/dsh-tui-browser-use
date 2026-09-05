/**
 * preset-gate-check — pure-logic regression for the minimal-preset gate
 * (审核 P1-4). The 21 `browser_*` tools are registered globally, so without
 * this gate an official `minimal` two-tool agent still inherits them through
 * dsh-tools' global+scope `view()` merge. This script pins the two pure
 * functions that close that seam.
 *
 * Verifies:
 *   1. `resolvePresetId` — the newest `agent-preset/selected` event wins over
 *      the creation header; an absent session resolves `undefined`.
 *   2. `filterMinimalPresetTools` — under the `minimal` preset every
 *      `browser_*` tool is stripped and the rest kept; every other preset (and
 *      an assembly with no browser tools) returns the original unchanged.
 *
 * Run: `node --import tsx/esm scripts/preset-gate-check.mjs`
 */
import assert from 'node:assert/strict'

const { resolvePresetId, filterMinimalPresetTools } = await import('../src/preset-gate.js')

// 1. resolvePresetId — header fallback.
{
  assert.equal(resolvePresetId({ header: { agentPreset: 'minimal' }, events: [] }), 'minimal')
  assert.equal(resolvePresetId(undefined), undefined)
  assert.equal(resolvePresetId({ header: {}, events: [] }), undefined)
  console.log('[1] resolvePresetId header fallback / absent session — OK')
}

// 2. resolvePresetId — newest selected event wins (blank-session switch).
{
  const session = {
    header: { agentPreset: 'standard' },
    events: [
      { type: 'agent-preset/selected', data: { agentPreset: 'code' } },
      { type: 'agent-preset/selected', data: { agentPreset: 'minimal' } },
    ],
  }
  assert.equal(resolvePresetId(session), 'minimal')
  console.log('[2] resolvePresetId newest selected wins — OK')
}

// 2b. resolvePresetId — a lenient host session without an event log must not
// throw (regression: `reading 'length'` on an undefined `events`).
{
  assert.equal(resolvePresetId({ header: { agentPreset: 'minimal' } }), 'minimal')
  assert.equal(resolvePresetId({ header: {} }), undefined)
  assert.equal(resolvePresetId({}), undefined)
  assert.equal(resolvePresetId({ events: [] }), undefined)
  console.log('[2b] resolvePresetId tolerates lenient session shapes — OK')
}

// 3. filterMinimalPresetTools — minimal strips browser tools, keeps others.
{
  const assembly = {
    sections: [],
    tools: [
      { name: 'bash' },
      { name: 'str_replace_editor' },
      { name: 'browser_navigate' },
      { name: 'browser_screenshot' },
      { name: 'ask_user_question' },
    ],
    variables: {},
  }
  const minimal = filterMinimalPresetTools(assembly, 'minimal')
  assert.deepEqual(minimal.tools.map((t) => t.name), ['bash', 'str_replace_editor', 'ask_user_question'])
  assert.notEqual(minimal, assembly)
  console.log('[3] minimal strips browser_* and keeps the rest — OK')
}

// 4. filterMinimalPresetTools — every other preset returns the original assembly.
{
  const assembly = {
    tools: [{ name: 'bash' }, { name: 'browser_navigate' }],
  }
  for (const preset of ['standard', 'code', 'cordis', 'liangshen', undefined]) {
    assert.equal(filterMinimalPresetTools(assembly, preset), assembly)
  }
  console.log('[4] non-minimal presets return the original assembly — OK')
}

// 5. filterMinimalPresetTools — no browser tools resolves to the original.
{
  const assembly = { tools: [{ name: 'bash' }, { name: 'str_replace_editor' }] }
  assert.equal(filterMinimalPresetTools(assembly, 'minimal'), assembly)
  console.log('[5] minimal with no browser tools returns original — OK')
}

console.log('preset-gate-check passed')