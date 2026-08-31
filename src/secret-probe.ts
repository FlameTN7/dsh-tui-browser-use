/**
 * dsh-tui-browser-use — harness credential probing.
 *
 * AGENTS.md §6: secrets are resolved ASYNC through the harness credentials seam
 * (`ctx.credentials.resolve({ env })`) because a key may live in profile
 * `.credentials.yaml` refs rather than in the process environment. When a
 * credentials SERVICE is present it is the only authority — process env is NOT
 * consulted, so a stale env var can never shadow or override a profile ref.
 * Only a host WITHOUT the seam (stub harnesses, third-party integrations)
 * falls back to env vars. Values are never logged.
 */

type CredentialsLike = {
  get?(name: string): unknown
  read?(ref: unknown): Promise<unknown>
  resolve?(ref: unknown): Promise<unknown>
  [key: string]: unknown
}

interface ContextLike {
  get(name: string, optional?: boolean): unknown
}

/**
 * Probe one secret from the harness credentials seam, then (only when the seam
 * is absent) from process env. Returns the first non-empty value or null.
 */
export async function probeSecretAsync(ctx: ContextLike, names: readonly string[]): Promise<string | null> {
  const creds = ctx.get('credentials', false) as CredentialsLike | undefined
  if (creds) {
    // Correct async path: resolve({ env: 'NAME' }) → { key }.
    if (typeof creds.resolve === 'function') {
      for (const n of names) {
        try {
          const r = await (creds as { resolve(ref: unknown): Promise<{ key?: string; value?: string } | undefined> }).resolve({ env: n })
          const v = r?.key ?? r?.value
          if (typeof v === 'string' && v.length > 0) return v
        } catch { /* not configured — try next */ }
      }
    }
    // Legacy sync `.get` / direct keyed field, for odd harnesses.
    for (const n of names) {
      const v = typeof creds.get === 'function' ? creds.get(n) : creds[n]
      if (typeof v === 'string' && v.length > 0) return v
    }
    // Credentials service present but key not configured: do NOT fall back to
    // process env (AGENTS.md §6 — profile refs are the intended source).
    return null
  }
  for (const n of names) {
    const env = process.env[n] ?? process.env[n.replace(/\./g, '_')]
    if (env && env.length > 0) return env
  }
  return null
}
