/**
 * dsh-tui-browser-use — tool registry.
 *
 * Owns how the 21 `browser_*` tool definitions are registered on the harness
 * `ctx.tools` service. The registry keeps a `Map<name, disposer>` so every tool
 * can be independently unregistered. The bundled `buildToolDefinitions` stays
 * in `tools.ts`; this module only wires them.
 */

import type { ToolDeps, ToolDefinition } from '../tools.js'
import { buildToolDefinitions } from '../tools.js'

export { buildToolDefinitions } from '../tools.js'

/** A harness `ctx.tools` service (structural shape). */
interface ToolsService {
  register?(definition: ToolDefinition): () => void
}

/** Register all bundled `browser_*` tools; returns the combined disposer. */
export function registerTools(ctx: { get(name: string, optional?: boolean): unknown }, deps: ToolDeps): (() => void) | null {
  const tools = ctx.get('tools', false) as ToolsService | undefined
  if (!tools?.register) return null
  const defs = buildToolDefinitions(deps)
  const store = new Map<string, () => void>()
  for (const d of defs) {
    // Serialize every tool call onto the single shared browser page (P1 #9):
    // the session locks itself across calls, so concurrent tool dispatch never
    // interleaves Playwright operations. Read-only tools (status) still queue —
    // the harness's `isConcurrencySafe` classifier may launch them in parallel,
    // but they now drain serially instead of racing a navigate/click/type.
    const execute = (args: unknown, exec: unknown): Promise<unknown> =>
      deps.session.run(() => d.execute(args, exec))
    store.set(d.name, tools.register!({ ...d, execute }))
  }
  return () => store.forEach((d) => d())
}
