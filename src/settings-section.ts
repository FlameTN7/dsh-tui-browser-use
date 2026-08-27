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
 * Register the plugin's settings section. Returns nothing — a failure or
 * missing seam just logs (if debug) and leaves settings to patch config.
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
          { value: 'webp', label: 'WebP', descriptions: { zh: 'WebP', en: 'WebP' } },
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
        path: ['screenshot', 'maxDimension'],
        label: d('settings.screenshot.maxDimension.label')?.en ?? 'Max dimension (widthxheight)',
        descriptions: d('settings.screenshot.maxDimension.label'),
        hint: d('settings.screenshot.maxDimension.description')?.en,
        hintDescriptions: d('settings.screenshot.maxDimension.description'),
        kind: 'text',
        placeholder: '1024x768',
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
    ],
  }

  const disposer = sections.register(section)
  debug?.(`settings section registered: ns=${section.ns} fields=${section.fields.length} title="${section.title}"`)
  return disposer
}
