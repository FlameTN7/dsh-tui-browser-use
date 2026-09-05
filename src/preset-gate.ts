/**
 * dsh-tui-browser-use — minimal-preset tool gate.
 *
 * The browser-use toolset is registered GLOBALLY on the harness `tools`
 * service (`ctx.get('tools').register`, see `tools/registry.ts`), so every
 * agent preset — including the official `minimal` two-tool profile — inherits
 * the 21 `browser_*` tools through dsh-tools' global+scope `view()` merge.
 * The TUI's own filter only strips its `ask_user_question` host tool, not
 * third-party global registrations, so without a gate here a minimal agent
 * still sees the browser toolset (审核 P1-4).
 *
 * This module holds the pure logic that closes that seam: it resolves which
 * agent preset a live session runs under (the same rule as
 * `@deepseek-ai/dsh-agent-presets` `resolveSessionPreset`, re-implemented as a
 * dependency-free pure function to stay inside the plugin's `harness-only`
 * boundary — AGENTS.md §2 forbids importing host framework packages at
 * runtime) and filters `browser_*` out of any assembly whose session runs the
 * `minimal` preset.
 *
 * Only the `minimal` id is gated; every other preset keeps the browser tools.
 * The tool-set used for the filter is the plugin's own `browser_*` prefix, so
 * a foreign tool sharing the namespace is never touched.
 */

/** The agent-preset id whose model face must stay at the official two tools. */
export const MINIMAL_PRESET_ID = 'minimal'

/** Prefix every tool this plugin registers carries (AGENTS.md §3, 21 tools). */
const BROWSER_TOOL_PREFIX = 'browser_'

/**
 * The session slice a preset resolution needs (header + event log).
 *
 * Resolved structurally from whatever the host exposes as `agent.session`; the
 * field shapes are deliberately lenient (optional) because different host
 * paths hand us different session surfaces (e.g. a live-preview session may
 * carry a header without an event log). Missing surfaces must resolve to
 * "no preset recorded" — never throw (a gate must not break the host turn).
 */
export interface PresetSessionLike {
  readonly header?: { readonly agentPreset?: string }
  readonly events?: readonly { readonly type: string; readonly data?: unknown }[]
}

/** The assembly slice the gate rewrites (minimal: tools only). */
export interface ToolAssemblyLike {
  readonly tools: readonly { readonly name: string }[]
}

/** The event type dsh-agent-presets records when a blank session switches preset. */
const PRESET_SELECTED_EVENT = 'agent-preset/selected'

/**
 * Resolve the preset a live session actually runs under: the newest
 * `agent-preset/selected` event wins over the creation header — same rule as
 * the official `resolveSessionPreset`, re-stated here so the gate does not
 * import the host package. `undefined` means "no preset recorded".
 *
 * @param session - the live session's header + event log.
 * @returns the running preset id, or undefined when none is recorded.
 */
export function resolvePresetId(session: PresetSessionLike | undefined): string | undefined {
  if (session === undefined) return undefined
  const events = session.events ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== PRESET_SELECTED_EVENT) continue
    const data = event.data as { agentPreset?: string } | undefined
    if (typeof data?.agentPreset === 'string') return data.agentPreset
  }
  return session.header?.agentPreset
}

/**
 * Apply the minimal-preset gate to one assembled model face. When the recorded
 * preset is `minimal`, every `browser_*` tool is stripped from the assembly;
 * otherwise the original assembly is returned unchanged.
 *
 * @param assembly - the fully assembled prompt/tool input for one request.
 * @param presetId - the session's running preset id (see {@link resolvePresetId}).
 * @returns the assembly, minus this plugin's tools under the minimal preset.
 */
export function filterMinimalPresetTools<T extends ToolAssemblyLike>(assembly: T, presetId: string | undefined): T {
  if (presetId !== MINIMAL_PRESET_ID) return assembly
  if (!assembly.tools.some((tool) => tool.name.startsWith(BROWSER_TOOL_PREFIX))) return assembly
  return {
    ...assembly,
    tools: assembly.tools.filter((tool) => !tool.name.startsWith(BROWSER_TOOL_PREFIX)),
  }
}