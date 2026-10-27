/**
 * dsh-tui-browser-use — Cordis plugin entry.
 *
 * Runs as a sub-plugin inside the dsh-tui composition. It wires a
 * Playwright-driven browser toolset for the agent (`ctx.tools.register`),
 * a vision path (`deepseek-v4-flash-vision-exp` + DeepSeek file_api on the
 * official channel, base64 on others), and a dsh-tui settings section.
 *
 * The plugin reads no secret values itself: API keys and provider routing
 * come from the harness (`ctx.get('credentials')` / `ctx.get('settings')`)
 * or host environment variables. Diagnostics report only whether a key is
 * set — never its value (AGENTS.md §7).
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { BrowserUseConfig, ProviderOverride, ImageTransfer, VisionMode, ScreenshotFormat, TilingMode } from './types.js';
export declare const name = "dsh-tui-browser-use";
export declare const inject: string[];
export interface Config extends BrowserUseConfig {
    /** Browser language for strings: 'zh' (default) or 'en'. */
    lang: 'zh' | 'en';
}
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config: Config): void;
export { BrowserSession, BrowserToolError } from './browser.js';
export { buildToolDefinitions } from './tools.js';
export { registerTools } from './tools/registry.js';
export { createPlaywrightDriver } from './driver/playwright-driver.js';
export { createVisionAdapter } from './vision/vision-adapter.js';
export { effectiveViewport, detectCapability } from './capabilities.js';
export type { BrowserUseConfig, ProviderOverride, ImageTransfer, VisionMode, ScreenshotFormat, TilingMode };
export type { ResultEnvelope, Usage, ErrorCode } from './types.js';
//# sourceMappingURL=index.d.ts.map