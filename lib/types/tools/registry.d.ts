/**
 * dsh-tui-browser-use — tool registry.
 *
 * Owns how the 21 `browser_*` tool definitions are registered on the harness
 * `ctx.tools` service. The registry keeps a `Map<name, disposer>` so every tool
 * can be independently unregistered. The bundled `buildToolDefinitions` stays
 * in `tools.ts`; this module only wires them.
 */
import type { ToolDeps } from '../tools.js';
export { buildToolDefinitions } from '../tools.js';
/** Register all bundled `browser_*` tools; returns the combined disposer. */
export declare function registerTools(ctx: {
    get(name: string, optional?: boolean): unknown;
}, deps: ToolDeps): (() => void) | null;
//# sourceMappingURL=registry.d.ts.map