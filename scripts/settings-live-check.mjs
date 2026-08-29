/**
 * settings-live-check — pure-logic regression for R-01 (settings defaults
 * shadowing cordis config) and R-07 (live viewport hot-apply wiring).
 *
 * Reproduces the host `settings.register` behavior WITHOUT a browser or a live
 * settings service, so it runs as a fast `test:logic` gate:
 *   A. Stub the settings register to capture the `{ base, applies }` options
 *      and to compute the host's resolved layer (`schema(mergeLayers(base,
 *      section))`) from the settings-namespace defaults.
 *   B. Apply the plugin with a non-default patch config (visionMode 'off',
 *      viewport 1440x900, png, tiling off, providers filled).
 *   C. Assert `settings.register` was invoked with `base` carrying the patch
 *      config (the R-01 fix) — if the base is dropped, the host fills every
 *      schema default and the patch config is silently overridden.
 *   D. Trigger the settings `watch` callback with a live vision change and
 *      assert the next `browser_screenshot` short-circuits to `vision-off`
 *      (proving the effective config is updated live and the setting is read
 *      on the very next tool call).
 *   E. Apply with NO settings service → assert the tools still register (the
 *      soft-probe must never block tool registration).
 *
 * Run: `node --import tsx/esm scripts/settings-live-check.mjs`
 */
import assert from 'node:assert/strict'

const { apply } = await import('../src/index.js')

// The settings-namespace schema defaults (copied from the plugin Config, the
// same shape the host fills when resolving a namespace). Duplicated here so the
// test reproduces the host's default-injection faithfully.
const SCHEMA_DEFAULTS = {
  visionMode: 'auto',
  viewport: { width: 1024, height: 768 },
  screenshot: { format: 'jpeg', quality: 80 },
  tiling: { mode: 'auto', threshold: '1200x1200', overlap: 60 },
  providers: [],
}

/** Deep-merge the user section over the base (mirrors the host mergeLayers). */
function mergeLayers(under, over) {
  if (!under) return over
  if (!over) return under
  const out = { ...under }
  for (const [k, v] of Object.entries(over)) {
    const uv = out[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && uv && typeof uv === 'object' && !Array.isArray(uv)) {
      out[k] = mergeLayers(uv, v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}

/** Fill schema defaults for fields still undefined after the layer merge. */
function fillDefaults(merged) {
  const out = { ...merged, screenshot: { ...SCHEMA_DEFAULTS.screenshot, ...(merged.screenshot ?? {}) }, tiling: { ...SCHEMA_DEFAULTS.tiling, ...(merged.tiling ?? {}) } }
  if (out.visionMode === undefined) out.visionMode = SCHEMA_DEFAULTS.visionMode
  if (!out.viewport) out.viewport = { ...SCHEMA_DEFAULTS.viewport }
  if (out.providers === undefined) out.providers = SCHEMA_DEFAULTS.providers
  return out
}

function makeStubTools() {
  const defs = []
  return {
    defs,
    register(d) { defs.push(d); return () => {} },
    schemas() { return defs.map((d) => ({ name: d.name })) },
  }
}

function makeStubSettings(registerImpl) {
  let watchCb = null
  return {
    scope: { get: () => {}, watch: (cb) => { watchCb = cb; return () => {} } },
    get watchCb() { return watchCb },
    register(ns, schema, options) {
      // Compute the host's resolved layer: schema defaults, then base, then the
      // user section (which the stub supplies via an optional `section`).
      const section = registerImpl.section ?? {}
      const resolved = fillDefaults(mergeLayers(options?.base, section))
      this.scope.get = () => resolved
      registerImpl.calls.push({ ns, schema, options, resolved })
      return this.scope
    },
  }
}

function makeCtx({ stubTools, stubSettings }) {
  const injectCb = typeof stubSettings === 'undefined'
    ? null
    : (cb) => cb({ get: (n) => (n === 'settings' ? stubSettings : undefined), settings: stubSettings })
  return {
    get(name, optional) {
      if (name === 'tools') return stubTools
      if (name === 'settings') return stubSettings
      return undefined
    },
    inject(services, cb) { if (injectCb) injectCb(cb) },
    effect() { return () => {} },
  }
}

// ── Test D1: settings.register carries the patch config as `base` (R-01) ──
{
  const stubTools = makeStubTools()
  const registerImpl = { calls: [], section: {} }
  const stubSettings = makeStubSettings(registerImpl)
  stubSettings.scope.get = () => fillDefaults(mergeLayers(undefined, {})) // defaults layer

  const patchConfig = {
    lang: 'zh',
    visionMode: 'off',
    viewport: { width: 1440, height: 900 },
    screenshot: { format: 'png', quality: 95, maxDimension: '1440x900' },
    tiling: { mode: 'off', threshold: '2000x2000', overlap: 0 },
    providers: [{ provider: 'deepseek', supportsVision: false, imageTransfer: 'none' }],
  }
  const ctx = makeCtx({ stubTools, stubSettings })
  apply(ctx, patchConfig)

  // register() MUST have been called with a base carrying the patch config.
  const reg = registerImpl.calls[0]
  assert.ok(reg, 'settings.register should have been called')
  assert.ok(reg.options?.base, 'settings.register MUST pass a `base` layer (R-01)')
  assert.equal(reg.options.applies, 'live')
  // If the base had been dropped, the host would fill defaults and override the
  // patch config. With the base present, the resolved layer preserves the patch.
  assert.equal(reg.resolved.visionMode, 'off', 'base must keep visionMode=off')
  assert.deepEqual(reg.resolved.viewport, { width: 1440, height: 900 })
  assert.equal(reg.resolved.screenshot.format, 'png')
  assert.equal(reg.resolved.tiling.mode, 'off')
  assert.equal(reg.resolved.providers.length, 1)
  assert.equal(reg.resolved.providers[0].provider, 'deepseek')

  console.log('[D1] settings.register passed base with patch config — OK')
}

// ── Test D2: watch callback hot-applies a vision change (R-01/R-07) ──
{
  const stubTools = makeStubTools()
  const registerImpl = { calls: [], section: {} }
  const stubSettings = makeStubSettings(registerImpl)
  stubSettings.scope.get = () => fillDefaults(mergeLayers({ visionMode: 'auto', viewport: { width: 1024, height: 768 }, screenshot: { format: 'jpeg', quality: 80 }, tiling: { mode: 'auto', threshold: '1200x1200', overlap: 60 }, providers: [] }, {}))

  const ctx = makeCtx({ stubTools, stubSettings })
  apply(ctx, { lang: 'zh', visionMode: 'auto', viewport: { width: 1024, height: 768 }, screenshot: { format: 'jpeg', quality: 80 }, tiling: { mode: 'auto', threshold: '1200x1200', overlap: 60 }, providers: [] })

  // Capture the watch callback the plugin registered.
  const watchCb = stubSettings.watchCb
  assert.ok(watchCb, 'settings scope.watch should have been configured')
  // Fire a live visionMode change to 'off'.
  watchCb({ visionMode: 'off' })

  // The very next browser_screenshot must short-circuit to vision-off.
  const shot = stubTools.defs.find((d) => d.name === 'browser_screenshot')
  assert.ok(shot, 'browser_screenshot tool should be registered')
  const res = await shot.execute({}, {})
  assert.equal(res.ok, true)
  assert.equal(res.value.visionUsed, false)
  assert.equal(res.value.visionUnavailableReason, 'vision-off')
  assert.equal(res.value.elementSummary, '')

  console.log('[D2] watch change to visionMode=off short-circuits screenshot — OK')
}

// ── Test E: no settings service → tools still register (soft-probe) ──
{
  const stubTools = makeStubTools()
  const ctx = makeCtx({ stubTools, stubSettings: undefined })
  apply(ctx, { lang: 'zh', visionMode: 'off', viewport: { width: 1440, height: 900 }, screenshot: { format: 'png', quality: 95 }, tiling: { mode: 'off', threshold: '2000x2000', overlap: 0 }, providers: [] })
  assert.ok(stubTools.defs.length >= 20, `expected >=20 tools registered, got ${stubTools.defs.length}`)
  const status = stubTools.defs.find((d) => d.name === 'browser_status')
  assert.ok(status, 'browser_status tool should be registered without a settings service')
  console.log('[E] no settings service → tools still register — OK')
}

console.log('\n[settings-live-check] ALL PASS')
process.exit(0)
