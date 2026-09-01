#!/usr/bin/env node
/**
 * Verify the browser-use i18n dictionary: every key carries both `zh` and
 * `en`, placeholders ({{name}}) match across languages, and no dead keys.
 *
 * The plugin's i18n dict is a flat `Record<string, { zh: string; en: string }>`
 * (string templates only; no plural forms needed for this surface). The
 * checker imports `src/i18n.ts` via tsx and validates:
 *  - each key has a non-empty `zh` and `en`
 *  - `{{name}}` placeholder sets are identical between the two languages
 *  - no stray single-brace `{` / `}` typos
 *  - every key in the dict is referenced somewhere in `src/` (dead-key check)
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const mod = await import(join(root, 'src/i18n.ts') + '?t=' + Date.now())
  const dict = mod.default ?? mod.dict
  if (!dict || typeof dict !== 'object') {
    console.error('[verify-i18n] FAILED: no dictionary exported from src/i18n.ts')
    process.exit(1)
  }

  const keys = Object.keys(dict)
  const errors = []
  const dead = []

  // Whole-source scan for key-value references (rough dead-key detection).
  let sourceText = ''
  for (const file of ['src/index.ts', 'src/browser.ts', 'src/page-ops.ts', 'src/browser-utils.ts', 'src/tools.ts', 'src/settings-section.ts', 'src/capabilities.ts', 'src/vision.ts', 'src/image-pipeline.ts', 'src/types.ts']) {
    try {
      sourceText += readFileSync(join(root, file), 'utf8') + '\n'
    } catch { /* not built yet; ignore */ }
  }

  for (const key of keys) {
    const entry = dict[key]
    const zh = typeof entry?.zh === 'string' ? entry.zh : undefined
    const en = typeof entry?.en === 'string' ? entry.en : undefined
    if (!zh || !en) {
      errors.push(`key "${key}": missing zh or en`)
      continue
    }
    const ph = (s) => [...s.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1]).sort().join(',')
    const zhPh = ph(zh)
    const enPh = ph(en)
    if (zhPh !== enPh) {
      errors.push(`key "${key}": placeholder mismatch zh=[${zhPh}] en=[${enPh}]`)
    }
    // Stray single braces: strip known {{name}} placeholders, then flag leftovers.
    const strip = (s) => s.replace(/\{\{[^}]*\}\}/g, '')
    if (strip(zh).includes('{') || strip(zh).includes('}') || strip(en).includes('{') || strip(en).includes('}')) {
      errors.push(`key "${key}": possible single-brace typo`)
    }
    if (sourceText && !sourceText.includes(`'${key}'`) && !sourceText.includes(`"${key}"`)) {
      dead.push(key)
    }
  }

  if (errors.length) {
    console.error(`[verify-i18n] FAILED (${errors.length}):`)
    for (const e of errors) console.error('  - ' + e)
    process.exit(1)
  }

  console.log(`[verify-i18n] OK: ${keys.length} keys bilingual with matching placeholders`)
  if (dead.length) {
    console.warn(`[verify-i18n] WARN: ${dead.length} possibly dead keys: ${dead.join(', ')}`)
  }
}

await main()
