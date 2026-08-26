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
    title: 'Browser Automation (browser-use)',
    descriptions: { zh: d('settings.title')?.zh ?? '浏览器自动化 (browser-use)', en: d('settings.title')?.en ?? 'Browser Automation (browser-use)' },
    fields: [
      {
        path: ['visionMode'],
        label: d('settings.visionMode.label')?.en ?? 'Vision mode',
        descriptions: { zh: d('settings.visionMode.description')?.zh ?? '视觉模式', en: d('settings.visionMode.description')?.en ?? 'Vision mode' },
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
        descriptions: { zh: d('settings.screenshot.format.label')?.zh ?? '截图格式', en: d('settings.screenshot.format.label')?.en ?? 'Screenshot format' },
        kind: 'select',
        options: [
          { value: 'jpeg', label: 'JPEG' },
          { value: 'webp', label: 'WebP' },
          { value: 'png', label: 'PNG' },
        ],
      },
      {
        path: ['screenshot', 'quality'],
        label: d('settings.screenshot.quality.label')?.en ?? 'Quality (1-100)',
        descriptions: { zh: d('settings.screenshot.quality.label')?.zh ?? '质量 (1-100)', en: d('settings.screenshot.quality.label')?.en ?? 'Quality (1-100)' },
        kind: 'number',
      },
      {
        path: ['screenshot', 'maxDimension'],
        label: d('settings.screenshot.maxDimension.label')?.en ?? 'Max dimension (widthxheight)',
        descriptions: { zh: d('settings.screenshot.maxDimension.label')?.zh ?? '最大尺寸 (宽x高)', en: d('settings.screenshot.maxDimension.label')?.en ?? 'Max dimension (widthxheight)' },
        kind: 'text',
        placeholder: '1024x768',
      },
      {
        path: ['tiling', 'mode'],
        label: d('settings.tiling.mode.label')?.en ?? 'Tiling mode',
        descriptions: { zh: d('settings.tiling.mode.label')?.zh ?? '切分模式', en: d('settings.tiling.mode.label')?.en ?? 'Tiling mode' },
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
        descriptions: { zh: d('settings.tiling.threshold.label')?.zh ?? '切分阈值 (宽x高)', en: d('settings.tiling.threshold.label')?.en ?? 'Tiling threshold (widthxheight)' },
        kind: 'text',
        placeholder: '1200x1200',
      },
      {
        path: ['tiling', 'overlap'],
        label: d('settings.tiling.overlap.label')?.en ?? 'Overlap pixels',
        descriptions: { zh: d('settings.tiling.overlap.label')?.zh ?? '重叠像素', en: d('settings.tiling.overlap.label')?.en ?? 'Overlap pixels' },
        kind: 'number',
      },
    ],
  }

  const disposer = sections.register(section)
  debug?.(`settings section registered: ns=${section.ns} fields=${section.fields.length} title="${section.title}"`)
  return disposer
}
