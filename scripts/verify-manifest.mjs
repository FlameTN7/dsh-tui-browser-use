#!/usr/bin/env node
/**
 * Verify dsh-plugin.json against the official @dsh-std/manifest parser AND
 * the dsh-tui semantic validation layer (validatePlugin) when available.
 *
 * Green here means:
 *  - parseManifest accepts the manifest structure (manifestVersion 0.15)
 *  - validateManifest checks the object model
 *  - projectManifest projects into the host composition model
 *  - validatePlugin checks contracts/permissions/subscriptions against the
 *    pinned dsh-ecosystem-spec registry (when dsh-tui is vendored; e.g. local
 *    development; on CI this step is a no-op warning unless DSH_TUI_DIR is set)
 *
 * No network access: the schema is never fetched.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'dsh-plugin.json')

async function loadFirst(specifiers) {
  for (const specifier of specifiers) {
    try {
      const mod = await import(specifier)
      return mod
    } catch {
      /* try next */
    }
  }
  return null
}

async function main() {
  const dshTuiDir = process.env.DSH_TUI_DIR
  const manifestSpecifiers = [
    'file://' + join(root, 'node_modules/@dsh-std/manifest/lib/index.js'),
    ...(dshTuiDir
      ? ['file://' + join(dshTuiDir, 'vendor/dsh-std/packages/manifest/lib/index.js')]
      : []),
  ]
  const dshStdManifest = await loadFirst(manifestSpecifiers)
  if (!dshStdManifest) {
    console.error('[verify-manifest] FAILED: @dsh-std/manifest not found (run npm install, or set DSH_TUI_DIR to a vendored dsh-tui checkout)')
    process.exit(1)
  }
  let dshTui = null
  if (dshTuiDir && existsSync(join(dshTuiDir, 'src/plugin-spec/registry.ts'))) {
    try {
      const registryMod = await import(
        pathToFileURL(join(dshTuiDir, 'src/plugin-spec/registry.ts')).href
        + '?t=' + Date.now(),
      )
      const validateMod = await import(
        pathToFileURL(join(dshTuiDir, 'src/plugin-spec/validate.ts')).href
        + '?t=' + Date.now(),
      )
      dshTui = { ...registryMod, ...validateMod }
    } catch (e) {
      console.warn(`[verify-manifest] WARN: dsh-tui semantic layer import failed: ${e.message}`)
    }
  }

  try {
    const raw = readFileSync(manifestPath, 'utf8')
    const parsed = dshStdManifest.parseManifest(raw, { source: manifestPath })
    dshStdManifest.validateManifest(parsed)
    dshStdManifest.projectManifest(parsed)

    console.log(`[verify-manifest] OK: ${parsed.id}@${parsed.version} (manifest v${parsed.manifestVersion})`)

    if (dshTui) {
      const specDir = join(dshTuiDir, 'dsh-ecosystem-spec')
      const data = dshTui.loadSpecData(specDir)
      if (!data) {
        console.error('[verify-manifest] FAILED: ecosystem spec data unreadable')
        process.exit(1)
      }
      const index = dshTui.createContractIndex(data.registry, data.permissions)
      dshTui.validatePlugin(index, parsed)
      console.log(`[verify-manifest] validatePlugin: PASSED (contracts=${parsed.requires.contracts.length}, permissions=${parsed.permissions.length}, subscriptions=${parsed.subscriptions.length})`)
    } else {
      console.warn('[verify-manifest] semantic layer skipped (dsh-tui not vendored); set DSH_TUI_DIR to enable')
    }
  } catch (e) {
    console.error(`[verify-manifest] FAILED: ${e.message}`)
    process.exit(1)
  }
}

await main()
