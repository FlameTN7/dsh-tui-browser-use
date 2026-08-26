/**
 * dsh-tui-browser-use localization — bilingual UI strings (zh + en).
 *
 * Mirrors dsh-tui's flat dictionary convention: every user-visible string
 * (settings-section labels/descriptions, tool error messages, status
 * information) lives here as a `{ zh, en }` template; placeholders use
 * `{{name}}`. `scripts/verify-i18n.mjs` enforces completeness and
 * placeholder parity.
 */

import type { I18nTemplate } from './types.js'

export type Lang = 'zh' | 'en'

export const LANGS = ['zh', 'en'] as const

export type I18nDict = Record<string, I18nTemplate>

export const dict: I18nDict = {
  // ── settings section ───────────────────────────────────────────────────
  'settings.title': {
    zh: '浏览器自动化 (browser-use)',
    en: 'Browser Automation (browser-use)',
  },
  'settings.visionMode.label': {
    zh: '视觉模式',
    en: 'Vision mode',
  },
  'settings.visionMode.description': {
    zh: 'auto 自动判定（官方 DeepSeek 走文件 API，其他走 base64）；on 强制开启；off 纯 DOM；deepseek-file-api 强制官方文件路径',
    en: 'auto detects (official DeepSeek uses the file API, others base64); on forces vision; off is pure DOM; deepseek-file-api forces the official file path',
  },
  'settings.screenshot.format.label': {
    zh: '截图格式',
    en: 'Screenshot format',
  },
  'settings.screenshot.quality.label': {
    zh: '质量 (1-100)',
    en: 'Quality (1-100)',
  },
  'settings.screenshot.maxDimension.label': {
    zh: '最大尺寸 (宽x高)',
    en: 'Max dimension (widthxheight)',
  },
  'settings.tiling.mode.label': {
    zh: '切分模式',
    en: 'Tiling mode',
  },
  'settings.tiling.threshold.label': {
    zh: '切分阈值 (宽x高)',
    en: 'Tiling threshold (widthxheight)',
  },
  'settings.tiling.overlap.label': {
    zh: '重叠像素',
    en: 'Overlap pixels',
  },

  // ── tool status ────────────────────────────────────────────────────────
  'error.browser': {
    zh: '浏览器操作失败: {{message}}',
    en: 'Browser operation failed: {{message}}',
  },
  'error.browser-missing': {
    zh: '浏览器未安装。修复指引: npx playwright install chromium（Linux 加 --with-deps），或安装系统 Chrome。',
    en: 'Browser not installed. Fix: npx playwright install chromium (add --with-deps on Linux), or install system Chrome.',
  },
  'error.vision-unavailable': {
    zh: '视觉通路不可用: 当前 provider 不支持图片，或 visionMode 为 off。',
    en: 'Vision path unavailable: the current provider does not support images, or visionMode is off.',
  },
  'error.schema-validation': {
    zh: '提取结果未通过调用方 schema 校验: {{message}}',
    en: 'Extracted data failed caller schema validation: {{message}}',
  },
  'error.argument': {
    zh: '参数错误: {{message}}',
    en: 'Argument error: {{message}}',
  },

  // ── screenshot insight ─────────────────────────────────────────────────
  'screenshot.insight.empty': {
    zh: '（视觉模型未返回可读内容）',
    en: '(vision model returned no readable content)',
  },
}

export default dict

/** Resolve a template for a language with `{{name}}` substitution. */
export function t(key: string, lang: Lang, params?: Record<string, string | number>): string {
  const entry = dict[key]
  const template = entry?.[lang] ?? key
  return template.replace(/\{\{([^}]+)\}\}/g, (_, name: string) =>
    params?.[name] !== undefined ? String(params[name]) : `{{${name}}}`,
  )
}
