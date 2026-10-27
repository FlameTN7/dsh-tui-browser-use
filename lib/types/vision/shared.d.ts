/**
 * dsh-tui-browser-use — shared vision building blocks.
 *
 * These helpers are transport-agnostic and shared by both `VisionAdapter`
 * implementations (DeepSeek Files-API and OpenAI-compatible base64/url). They
 * carry the prompt-injection fencing, the retry/backoff policy, the cost/token
 * accounting, and the chat/completions request that both adapters converge on.
 */
import type { ImageTransfer, PreparedImage, Usage, VisionMode } from '../types.js';
import type { RuntimeEnv } from '../runtime-env.js';
/** A resolved vision request environment. */
export interface VisionEnvLike {
    baseUrl: string;
    apiKey: string;
    model: string;
    imageTransfer: ImageTransfer;
    provider: string;
}
export declare const RETRYABLE_STATUS: Set<number>;
export declare const DEFAULT_MAX_RETRIES = 4;
export declare const DEFAULT_BASE_DELAY_MS = 600;
/** Read `Retry-After` seconds (or an HTTP-date) from a response header, if sane. */
export declare function retryAfterMs(resp: Response, capMs?: number): number | null;
/** Exponential backoff with jitter for one HTTP attempt. Returns false to stop. */
export declare function backoffDelayMs(attempt: number, baseDelayMs: number): number;
/**
 * Abort-aware sleep: rejects with the signal reason as soon as the signal
 * fires, so a cancelled vision call never sits out a full backoff/Retry-After
 * delay (AGENTS.md §5 — the whole vision fetch chain honours `exec.signal`).
 */
export declare function sleepMs(ms: number, signal?: AbortSignal): Promise<void>;
/** Perform a fetch that retries on retryable statuses (429 / 5xx). */
export declare function fetchWithRetry(url: string, init: RequestInit, maxRetries?: number, signal?: AbortSignal): Promise<Response>;
/** Parse a JSON response body robustly, tolerating an empty or non-JSON body. */
export declare function parseJsonRobust(resp: Response): Promise<Record<string, unknown>>;
export type CostRates = {
    input: number;
    output: number;
    cacheHit: number;
};
export declare function costRates(env: RuntimeEnv): CostRates;
/** Estimate token/cost for a set of images + text (best-effort). */
export declare function estimateUsage(env: RuntimeEnv, model: string, visionMode: VisionMode, imagesSent: number, textLength: number): Usage;
/** Compute cost (USD/CNY) from real prompt/completion token counts. */
export declare function costFromUsage(env: RuntimeEnv, promptTokens: number, completionTokens: number, cacheHitTokens?: number): {
    costUsd: number;
    costCny: number;
};
export declare function baseUrlOf(env: VisionEnvLike): string;
export declare function fileExpiresSeconds(env: RuntimeEnv): number | null;
/** Build the system message: mark the screenshot as untrusted page content. */
export declare function buildSystemPrompt(): string;
/** A single user message content block. */
export type ChatContent = Record<string, unknown>;
/**
 * Do the actual chat/completions request and build the Usage block. This is
 * transport-agnostic: both adapters build the message array (images encoded as
 * file_id or base64 image_url) and converge here.
 */
export declare function performChat(env: VisionEnvLike, runtimeEnv: RuntimeEnv, messages: Array<{
    role: string;
    content: ChatContent[] | string;
}>, imagesSent: number, signal?: AbortSignal): Promise<{
    text: string;
    usage: Usage;
}>;
/** Build the user-message content array (images + optional <task> fence). */
export declare function buildUserContent(content: ChatContent[], instruction: string): ChatContent[];
/** A prepared image reference for adapters. */
export type { PreparedImage };
//# sourceMappingURL=shared.d.ts.map