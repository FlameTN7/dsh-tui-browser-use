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
  // Section title is the bare display name — the settings screen appends the
  // namespace id `(browser-use)` itself, so a title already carrying the id
  // rendered it twice.
  'settings.title': {
    zh: '浏览器自动化',
    en: 'Browser Automation',
  },
  'settings.visionMode.label': {
    zh: '视觉模式',
    en: 'Vision mode',
  },
  // The long description is a HINT (rendered under the focused field), NOT the
  // field label. Wiring it into `descriptions` (the localized LABEL) is what put
  // the whole sentence on the label line in /settings.
  'settings.visionMode.description': {
    zh: 'auto 自动判定（官方 DeepSeek 走文件 API，其他走 base64）；on 尝试开启（仍受模型视觉能力与密钥门控）；off 纯 DOM；deepseek-file-api 强制官方文件路径',
    en: 'auto detects (official DeepSeek uses the file API, others base64); on attempts vision (still gated by model capability + key); off is pure DOM; deepseek-file-api forces the official file path',
  },
  'settings.screenshot.format.label': {
    zh: '截图格式',
    en: 'Screenshot format',
  },
  'settings.screenshot.format.description': {
    zh: '截图输出格式。jpeg 体积小（默认）；png 无损但更大。',
    en: 'Screenshot output format. jpeg is compact (default); png is lossless but larger.',
  },
  'settings.screenshot.quality.label': {
    zh: '质量 (1-100)',
    en: 'Quality (1-100)',
  },
  'settings.screenshot.quality.description': {
    zh: '截图质量 (1-100)。仅对 jpeg 生效，越高越清晰、体积越大。',
    en: 'Screenshot quality (1-100). Applies to jpeg; higher is sharper but larger.',
  },
  'settings.viewport.width.label': {
    zh: '视口宽度 (px)',
    en: 'Viewport width (px)',
  },
  'settings.viewport.width.description': {
    zh: '浏览器视口宽度（CSS 像素），决定页面 innerWidth 与响应式断点。',
    en: 'Browser viewport width (CSS px); sets page innerWidth and responsive breakpoints.',
  },
  'settings.viewport.height.label': {
    zh: '视口高度 (px)',
    en: 'Viewport height (px)',
  },
  'settings.viewport.height.description': {
    zh: '浏览器视口高度（CSS 像素）。',
    en: 'Browser viewport height (CSS px).',
  },
  'settings.tiling.mode.label': {
    zh: '切分模式',
    en: 'Tiling mode',
  },
  'settings.tiling.mode.description': {
    zh: '长页面切分。auto 超过阈值自动分段；on 强制分段；off 单张整页。',
    en: 'Long-page tiling. auto splits past the threshold; on forces split; off is a single full page.',
  },
  'settings.tiling.threshold.label': {
    zh: '切分阈值 (宽x高)',
    en: 'Tiling threshold (widthxheight)',
  },
  'settings.tiling.threshold.description': {
    zh: '切分阈值（宽×高）。页面超过此尺寸时按「视口高−重叠」滚动分段截图。',
    en: 'Tiling threshold (widthxheight). Pages past this size are captured as scrolled-viewport segments.',
  },
  'settings.tiling.overlap.label': {
    zh: '重叠像素',
    en: 'Overlap pixels',
  },
  'settings.tiling.overlap.description': {
    zh: '相邻分段的重叠像素数，避免接缝处元素被切断。',
    en: 'Overlap pixels between adjacent segments, so seam elements are not cut off.',
  },
  'settings.tiling.maxTiles.label': {
    zh: '切分上限（段）',
    en: 'Max tiles',
  },
  'settings.tiling.maxTiles.description': {
    zh: '滚动分段截图的最大段数。超过时丢弃页面底部（并上报 tilesTruncated）。默认 24。',
    en: 'Max scroll-capture segments. Past this the page bottom is dropped (with a tilesTruncated report). Default 24.',
  },
  'settings.proxy.label': {
    zh: 'HTTP 代理',
    en: 'HTTP proxy',
  },
  'settings.proxy.description': {
    zh: '访问外网站点用的 HTTP 代理（如 http://host:port）。留空则用环境变量 DSH_TUI_BROWSER_PROXY。',
    en: 'HTTP proxy for external sites (e.g. http://host:port). Empty falls back to env DSH_TUI_BROWSER_PROXY.',
  },
  'settings.session.mode.label': {
    zh: '会话模式',
    en: 'Session mode',
  },
  'settings.session.mode.description': {
    zh: 'persistent 保留一份固定命名的登录态档案（跨重启登录仍在）；isolated 每次独立临时档案、关闭后清理。留空则沿用旧行为（DSH_TUI_BROWSER_USER_DATA_DIR / _STORAGE_STATE 优先）。',
    en: 'persistent keeps one fixed, named login-state profile (login survives restarts); isolated uses a fresh temp profile each run and cleans it up. Leave empty for the legacy behaviour (DSH_TUI_BROWSER_USER_DATA_DIR / _STORAGE_STATE take priority).',
  },
  'settings.session.profile.label': {
    zh: '档案名',
    en: 'Profile name',
  },
  'settings.session.profile.description': {
    zh: '档案目录名（persistent 模式）。需为单段安全字符（字母数字._-，1-64），否则回退 default。',
    en: 'Profile directory name (persistent mode). Must be one safe segment (A-Za-z0-9._-, 1-64); otherwise falls back to default.',
  },
  'tiling.truncated.note': {
    zh: '页面在第 {{captured}}/{{total}} 段后截断，还有 {{dropped}} 段未被采集，可见内容只到约 {{heightPx}}px 处，其下缺失。',
    en: 'The page was truncated after segment {{captured}} of {{total}}; {{dropped}} more segment(s) were not captured, so content is only readable down to roughly {{heightPx}}px and everything below is missing.',
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
  'error.download': {
    zh: '下载失败: {{message}}',
    en: 'Download failed: {{message}}',
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
