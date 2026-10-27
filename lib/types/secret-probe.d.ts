/**
 * dsh-tui-browser-use — harness credential probing.
 *
 * AGENTS.md §6: secrets are resolved ASYNC through the harness credentials seam
 * (`ctx.credentials.resolve(ref)`) because a key may live in profile
 * `.credentials.yaml` refs rather than in the process environment. When a
 * credentials SERVICE is present it is the only authority — process env is NOT
 * consulted, so a stale env var can never shadow or override a profile ref.
 * Only a host WITHOUT the seam (stub harnesses, third-party integrations)
 * falls back to env vars. Values are never logged.
 *
 * `CredentialRef` is a bare POSIX identifier string (e.g. `'DEEPSEEK_API_KEY'`),
 * NOT `{ env: name }` — the provider's `launchEnvironment.getFrom(ref)` keys its
 * layers by string, so the object shape never matched and any key present in
 * the process env or `.credentials.yaml` resolved to `undefined`, degrading the
 * whole vision path (regression from 55e070c, where the env fallback masked it).
 */
interface ContextLike {
    get(name: string, optional?: boolean): unknown;
}
/**
 * Probe one secret from the harness credentials seam, then (only when the seam
 * is absent) from process env. Returns the first non-empty value or null.
 */
export declare function probeSecretAsync(ctx: ContextLike, names: readonly string[]): Promise<string | null>;
export {};
//# sourceMappingURL=secret-probe.d.ts.map