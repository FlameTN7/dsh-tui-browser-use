/**
 * dsh-tui-browser-use — TUI settings-section registration.
 *
 * Registers a settings section over the plugin's settings namespace
 * (`browser-use`) so the dsh-tui settings screen can render editable fields.
 * Storage and validation remain with the dsh settings service; this registry
 * is display metadata only (mirrors seam #6 `ctx.tuiSettingsSections`).
 *
 * The section is soft-probed (`ctx.get('tuiSettingsSections', false)`): a
 * composition without the seam silently degrades instead of failing the
 * plugin.
 *
 * Field semantics (match the seam's `TuiSettingsField`):
 *  - `label` + `descriptions`: the row label (descriptions are the localized
 *    label; `pick(label, descriptions)` returns `descriptions[lang] ?? label`).
 *  - `hint` + `hintDescriptions`: the one-line help rendered under the focused
 *    field (`pick(hint, hintDescriptions)`). Wiring a long explanation into
 *    `descriptions` is the exact mistake that puts the whole sentence on the
 *    label line — it belongs in `hint`.
 */

import { dict } from './i18n.js'

// ── Structural host types (local copies; do not import dsh-tui) ─────────

interface LocalizedDescription {
  zh?: string
  en?: string
}

interface SettingsFieldOption {
  value: string
  label: string
  descriptions?: LocalizedDescription
}

interface SettingsField {
  path: readonly string[]
  label: string
  descriptions?: LocalizedDescription
  hint?: string
  hintDescriptions?: LocalizedDescription
  kind: 'text' | 'number' | 'boolean' | 'select'
  options?: readonly SettingsFieldOption[]
  placeholder?: string
}

interface SettingsSection {
  ns: string
  title: string
  descriptions?: LocalizedDescription
  fields: readonly SettingsField[]
}

interface SettingsSectionsRuntime {
  register(section: SettingsSection): () => void
}

// ── Registration ─────────────────────────────────────────────────────────

/**
 * Register the plugin's settings section on the dsh-tui section registry.
 *
 * The registration is DEFERRED to a microtask so it runs after dsh-tui's own
 * `ns:'dsh-tui'` section is inserted. The screen renders sections in registry
 * insertion order (a Map, one entry per namespace), so registering early — as
 * happened when this plugin's `apply` ran before dsh-tui's — put the
 * `browser-use` section at the TOP of `/settings`. Deferring until the current
 * synchronous boot phase settles appends it LAST, moving it below the host's
 * own (and any other plugin's) section. The namespace registration on the
 * settings *service* (the `[命名空间未注册]` fix) stays synchronous and is
 * untouched.
 *
 * The section registry records the owner from the SERVICE context, not the
 * calling stack, so a deferred `register()` still resolves a valid owner; the
 * channel reads the host list (`host.list()`), which returns every section in
 * insertion order regardless of owner. A missing seam just logs (if debug) and
 * leaves settings to patch config.
 */
export function registerSettingsSection(ctx: { get(name: string, optional?: boolean): unknown }, debug?: (msg: string) => void): (() => void) | undefined {
  const sections = ctx.get('tuiSettingsSections', false) as SettingsSectionsRuntime | undefined
  if (!sections?.register) {
    debug?.('tuiSettingsSections seam unavailable; settings section skipped')
    return undefined
  }

  // Build descriptions from the shared i18n dict (single source of truth).
  const d = (key: string) => dict[key]

  const section: SettingsSection = {
    ns: 'browser-use',
    // Title is the bare name; the screen appends `(ns)` itself, so keep it out.
    title: d('settings.title')?.en ?? 'Browser Automation',
    descriptions: d('settings.title'),
    fields: [
      {
        path: ['visionMode'],
        label: d('settings.visionMode.label')?.en ?? 'Vision mode',
        descriptions: d('settings.visionMode.label'),
        hint: d('settings.visionMode.description')?.en,
        hintDescriptions: d('settings.visionMode.description'),
        kind: 'select',
        options: [
          { value: 'auto', label: 'Auto', descriptions: { zh: '自动', en: 'Auto' } },
          { value: 'on', label: 'On', descriptions: { zh: '强制开启', en: 'On' } },
          { value: 'off', label: 'Off', descriptions: { zh: '关闭', en: 'Off' } },
          { value: 'deepseek-file-api', label: 'DeepSeek File API', descriptions: { zh: '官方文件 API', en: 'DeepSeek File API' } },
        ],
      },
      {
        path: ['screenshot', 'format'],
        label: d('settings.screenshot.format.label')?.en ?? 'Screenshot format',
        descriptions: d('settings.screenshot.format.label'),
        hint: d('settings.screenshot.format.description')?.en,
        hintDescriptions: d('settings.screenshot.format.description'),
        kind: 'select',
        options: [
          { value: 'jpeg', label: 'JPEG', descriptions: { zh: 'JPEG', en: 'JPEG' } },
          { value: 'png', label: 'PNG', descriptions: { zh: 'PNG', en: 'PNG' } },
        ],
      },
      {
        path: ['screenshot', 'quality'],
        label: d('settings.screenshot.quality.label')?.en ?? 'Quality (1-100)',
        descriptions: d('settings.screenshot.quality.label'),
        hint: d('settings.screenshot.quality.description')?.en,
        hintDescriptions: d('settings.screenshot.quality.description'),
        kind: 'number',
      },
      {
        path: ['viewport', 'width'],
        label: d('settings.viewport.width.label')?.en ?? 'Viewport width (px)',
        descriptions: d('settings.viewport.width.label'),
        hint: d('settings.viewport.width.description')?.en,
        hintDescriptions: d('settings.viewport.width.description'),
        kind: 'number',
        placeholder: '1024',
      },
      {
        path: ['viewport', 'height'],
        label: d('settings.viewport.height.label')?.en ?? 'Viewport height (px)',
        descriptions: d('settings.viewport.height.label'),
        hint: d('settings.viewport.height.description')?.en,
        hintDescriptions: d('settings.viewport.height.description'),
        kind: 'number',
        placeholder: '768',
      },
      {
        path: ['tiling', 'mode'],
        label: d('settings.tiling.mode.label')?.en ?? 'Tiling mode',
        descriptions: d('settings.tiling.mode.label'),
        hint: d('settings.tiling.mode.description')?.en,
        hintDescriptions: d('settings.tiling.mode.description'),
        kind: 'select',
        options: [
          { value: 'auto', label: 'Auto', descriptions: { zh: '自动', en: 'Auto' } },
          { value: 'on', label: 'On', descriptions: { zh: '强制开启', en: 'On' } },
          { value: 'off', label: 'Off', descriptions: { zh: '关闭', en: 'Off' } },
        ],
      },
      {
        path: ['tiling', 'threshold'],
        label: d('settings.tiling.threshold.label')?.en ?? 'Tiling threshold (widthxheight)',
        descriptions: d('settings.tiling.threshold.label'),
        hint: d('settings.tiling.threshold.description')?.en,
        hintDescriptions: d('settings.tiling.threshold.description'),
        kind: 'text',
        placeholder: '1200x1200',
      },
      {
        path: ['tiling', 'overlap'],
        label: d('settings.tiling.overlap.label')?.en ?? 'Overlap pixels',
        descriptions: d('settings.tiling.overlap.label'),
        hint: d('settings.tiling.overlap.description')?.en,
        hintDescriptions: d('settings.tiling.overlap.description'),
        kind: 'number',
      },
      {
        path: ['tiling', 'maxTiles'],
        label: d('settings.tiling.maxTiles.label')?.en ?? 'Max tiles',
        descriptions: d('settings.tiling.maxTiles.label'),
        hint: d('settings.tiling.maxTiles.description')?.en,
        hintDescriptions: d('settings.tiling.maxTiles.description'),
        kind: 'number',
        placeholder: '24',
      },
      {
        path: ['proxy'],
        label: d('settings.proxy.label')?.en ?? 'HTTP proxy',
        descriptions: d('settings.proxy.label'),
        hint: d('settings.proxy.description')?.en,
        hintDescriptions: d('settings.proxy.description'),
        kind: 'text',
        placeholder: 'http://127.0.0.1:10800',
      },
    ],
  }

  // Defer the actual `register()` so this section is appended after dsh-tui's
  // own section (see the doc comment above). Return a disposer that cancels the
  // pending registration or unregisters the already-registered section.
  let runtimeDisposer: (() => void) | undefined
  let cancelled = false
  queueMicrotask(() => {
    if (cancelled) return
    try {
      runtimeDisposer = sections.register(section)
      debug?.(`settings section registered: ns=${section.ns} fields=${section.fields.length} title="${section.title}"`)
    } catch (err) {
      debug?.(`settings section register failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  return () => {
    cancelled = true
    runtimeDisposer?.()
  }
}
