/**
 * dsh-tui-browser-use localization — bilingual UI strings (zh + en).
 *
 * Mirrors dsh-tui's flat dictionary convention: every user-visible string
 * (settings-section labels/descriptions, tool error messages, status
 * information) lives here as a `{ zh, en }` template; placeholders use
 * `{{name}}`. `scripts/verify-i18n.mjs` enforces completeness and
 * placeholder parity.
 */
import type { I18nTemplate } from './types.js';
export type Lang = 'zh' | 'en';
export declare const LANGS: readonly ["zh", "en"];
export type I18nDict = Record<string, I18nTemplate>;
export declare const dict: I18nDict;
export default dict;
/** Resolve a template for a language with `{{name}}` substitution. */
export declare function t(key: string, lang: Lang, params?: Record<string, string | number>): string;
//# sourceMappingURL=i18n.d.ts.map