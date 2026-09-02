#!/usr/bin/env node
/**
 * dsh-tui-browser-use — standalone vision/real-test secret probe.
 *
 * The vision / real-task test scripts run OUTSIDE the dsh-tui process, so they
 * cannot read the in-memory `launchEnvironment`/`ctx.credentials` seam the
 * plugin uses (AGENTS.md §6). To avoid a false "no key" when the key is stored
 * where dsh actually keeps it, this helper resolves a credential the same way
 * dsh-credentials-local does, across every channel a standalone script CAN see:
 *
 *   1. `process.env[NAME]`                     (shell-exported, explicit intent)
 *   2. `<DSH_HOME>/.credentials.yaml` refs     (dsh Models page managed store)
 *   3. project `.env` / `<DSH_HOME>/.env`      (dsh dotenv fallback)
 *   4. `/proc/<pid>/environ` of a live dsh-tui process (last resort; matches
 *      the actual `dsh-tui.js` host, not only the `dsh --profile` wrapper)
 *
 * The secret value is used in-memory only and never logged in full. A probe
 * that returns null means the key is not reachable from a standalone process in
 * ANY of these channels — the caller should say so rather than implying the key
 * is absent from dsh.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Parse a simple `KEY=value` dotenv-ish text (no exports, strips quotes). */
function parseDotEnv(text) {
  const out = {}
  const lines = text.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!m) continue
    out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

/**
 * Parse dsh-credentials-local's version-1 `refs:` section into a plain map.
 * This is a conservative, dependency-free reader: it understands the exact
 * layout dsh writes (`version: 1` / `refs:` / indented `NAME: value`), and
 * stops at the first top-level sibling (e.g. `records:`). Unknown shapes are
 * silently ignored — a malformed value simply looks unset to a standalone probe.
 */
function parseCredentialsRefs(dshHome) {
  const file = join(dshHome, '.credentials.yaml')
  if (!existsSync(file)) return {}
  const text = readFileSync(file, 'utf8')
  const out = {}
  const lines = text.split('\n')
  let inRefs = false
  let refsIndent = -1
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const indent = (line.match(/^ */)?.[0].length ?? 0)
    const content = line.trim()
    if (!inRefs && /^refs:\s*$/.test(content)) {
      inRefs = true
      refsIndent = indent
      continue
    }
    if (!inRefs) continue
    if (indent <= refsIndent && content) break // left the refs block
    if (!content) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(content)
    if (!m) continue
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

/**
 * Read a single value from a dotenv file if it exists at `paths` (checked in
 * order). Returns the first non-empty match.
 */
function fromEnvFiles(paths, name) {
  for (const p of paths) {
    if (!p || !existsSync(p)) continue
    const parsed = parseDotEnv(readFileSync(p, 'utf8'))
    const v = parsed[name]
    if (v && v.length > 0) return v
  }
  return undefined
}

/**
 * Last-resort `/proc` scan of a live dsh-tui process environ, for the case
 * where the key was shell-exported into the running host. Unlike the old
 * detection, this matches BOTH the `dsh --profile dsh-tui` launcher AND the
 * actual `dsh-tui.js` child process (which carries the real service context).
 */
function fromProc(name) {
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      const isDshTui = cmd.includes('dsh-tui.js') || (cmd.includes('--profile') && cmd.includes('dsh-tui'))
      if (!isDshTui) continue
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8')
      const hit = env.split('\0').find((s) => s.startsWith(`${name}=`))
      if (hit) return hit.slice(`${name}=`.length)
    } catch { /* pid vanished */ }
  }
  return undefined
}

/**
 * Probe one credential across all standalone-reachable channels.
 *
 * @param {string} name - the credential ref (e.g. `DEEPSEEK_API_KEY`).
 * @param {{ dshHome?: string, log?: (msg: string) => void }} [opts=] - optional
 *   dsh home override and a logger for a non-secret "where it came from" note.
 * @returns {string|null} the secret value, or null when no channel had it.
 */
export function probeApiKey(name, opts = {}) {
  const log = opts.log ?? (() => {})
  const dshHome = opts.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME || '', '.dsh')
  const envFiles = [
    join(process.cwd(), '.env'),
    join(dshHome, '.env'),
  ]

  if (process.env[name] && process.env[name].length > 0) {
    log(`${name} from process.env (len=${process.env[name].length})`)
    return process.env[name]
  }
  const credentialRefs = parseCredentialsRefs(dshHome)
  if (credentialRefs[name]) {
    log(`${name} from ${join(dshHome, '.credentials.yaml')}`)
    return credentialRefs[name]
  }
  const envFile = fromEnvFiles(envFiles, name)
  if (envFile) {
    log(`${name} from dotenv fallback`)
    return envFile
  }
  const proc = fromProc(name)
  if (proc) {
    log(`${name} from running dsh-tui process environ`)
    return proc
  }
  return null
}

/**
 * Convenience: probe the canonical vision credentials in order, returning the
 * first configured one. Mirrors `resolveProvider`'s preference for DeepSeek
 * (the only built-in vision route), then the OpenAI-compatible override.
 *
 * @param {{ dshHome?: string, log?: (msg: string) => void }} [opts=]
 * @returns {string|null}
 */
export function probeVisionKey(opts = {}) {
  return probeApiKey('DEEPSEEK_API_KEY', opts) ?? probeApiKey('OPENAI_API_KEY', opts)
}
