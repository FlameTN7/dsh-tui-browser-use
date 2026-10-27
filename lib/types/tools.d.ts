/**
 * dsh-tui-browser-use — tool definition builder.
 *
 * Builds the 21 `browser_*` tool definitions for the harness `ctx.tools`
 * service (structural typed). Every tool returns the unified result envelope
 * (proposal §4). Browser failures are returned as structured
 * `{ ok: false, error }` envelopes rather than thrown, so the model always
 * sees the wire contract. Tool descriptions/parameter docs are the ENGLISH
 * model-facing contract (explicitly exempted from the bilingual UI dictionary
 * by AGENTS.md §9); every human-facing string lives in `src/i18n.ts`.
 */
import type { BrowserSession } from './browser.js';
import type { VisionEnv } from './vision.js';
import type { Usage } from './types.js';
import { type SchemaNode } from './schema-validate.js';
import type { RuntimeEnv } from './runtime-env.js';
/** The runtime dependencies a tool needs when it executes. */
export interface ToolDeps {
    session: BrowserSession;
    /** Resolve the vision request environment from the current provider (async). */
    resolveVisionEnv(): Promise<VisionEnv | null>;
    /** Effective vision mode for this call (a getter, so a live `/settings` edit takes effect immediately). */
    visionMode(): 'auto' | 'on' | 'off' | 'deepseek-file-api';
    lang: 'zh' | 'en';
    /** Centralised runtime environment (cost rates, file expiry, ...). */
    runtimeEnv: RuntimeEnv;
}
/** A structurally-shaped tool definition the harness `ctx.tools.register` accepts. */
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: {
        schema: Record<string, unknown>;
        render(args: unknown, value: unknown): Array<Record<string, unknown>>;
        /** Pure replayable presentation projection for native and nested calls (DSH 0.2.1+). */
        presentationMeta?(args: unknown, value: unknown): unknown;
    };
    execute(args: unknown, exec: unknown): Promise<unknown>;
    /** Optional cooperative timeout budget in ms (enforced by `dsh-tool-call-timeout-policy`). */
    timeoutMs?: number;
    /** Optional concurrency classifier: only `true` opts into parallel dispatch. */
    isConcurrencySafe?(args: unknown): boolean;
}
/** Sum two usage blocks (P1-05): `browser_task` accumulates cost across steps. */
export declare function accumulateUsage(acc: Usage | undefined, u: Usage): Usage;
/**
 * Extract the cooperative abort signal a dsh tool timeout passes as `exec.signal`
 * (P0-02), plus a wall-clock budget ceiling for hosts whose timeout policy only
 * hard-kills the tool (no aborting signal threaded — the wait/30s case reports
 * "tool call timed out" and swallows the plugin's envelope). When `exec.signal`
 * is present, compose it with `AbortSignal.timeout(budgetMs)` so the tool can
 * resolve its own `timed-out` envelope just BEFORE the host kill; the budget
 * must sit a few hundred ms under the tool's `timeoutMs`. Without `exec.signal`,
 * derive `AbortSignal.timeout(fallbackMs)` so a hanging op is still
 * interruptible (R-02).
 */
export declare function abortSignalOf(exec: unknown, fallbackMs?: number, budgetMs?: number): AbortSignal | undefined;
/** Render a snapshot of the value as compact text content for the model. */
export declare function renderText(_args: unknown, value: unknown): Array<Record<string, unknown>>;
/**
 * Render page-derived tool output with an explicit untrusted marker, so the
 * model treats anything that came out of a live web page as data, not as
 * instructions to follow (prompt-injection guard, P1-03). Applied only to the
 * tools whose value is page text / the model's reading of a page.
 */
export declare function renderUntrusted(args: unknown, value: unknown): Array<Record<string, unknown>>;
/**
 * Run one vision extract with validate-on-failure retry (≤2 retries, P0-4).
 *
 * Each retry appends the concrete violation/parse error so the model can
 * self-correct instead of the tool hard-failing a transitory miss. `call`
 * isolates the harness-specific image capture + vision read so this loop is
 * pure and unit-testable without a browser or live model.
 */
export declare function extractWithRetry(call: (instruction: string) => Promise<{
    insight: string;
    usage: Usage;
}>, schema: SchemaNode, baseInstruction: string): Promise<{
    data: unknown;
    usage: Usage;
    attempts: number;
}>;
/**
 * Build all tool definitions. `deps` may be a stub at build time; the
 * closures read it only when a tool executes.
 */
export declare function buildToolDefinitions(deps: ToolDeps): ToolDefinition[];
export type { BrowserToolError } from './browser.js';
//# sourceMappingURL=tools.d.ts.map