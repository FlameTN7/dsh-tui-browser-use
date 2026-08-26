#!/usr/bin/env node
/**
 * dsh-tui-browser-use — Playwright browser bootstrap guidance.
 *
 * Per AGENTS.md §9, the Playwright npm lib ships in this package but the
 * browser binary is provisioned separately. This postinstall runs after every
 * install and prints the correct platform-specific command. It deliberately
 * does NOT auto-download browsers (that would be a large, surprising download
 * on every `npm install`); the startup probe and tool error hint cover the
 * "missing browser" case with actionable guidance.
 */

const platform = process.platform

const installCmd = platform === 'linux'
  ? 'npx playwright install chromium --with-deps'
  : 'npx playwright install chromium'

const lines = [`\n[dsh-tui-browser-use] Playwright browsers not auto-installed.`]
lines.push(`  The browser toolset needs a Chromium runtime at first use.`)
lines.push(`  Install it once:`)
lines.push(`    ${installCmd}`)
lines.push(`  Alternatively, install system Google Chrome.`)
if (platform === 'linux') {
  lines.push(`  (On Linux, a system package manager is the usual path.)`)
}
if (platform !== 'darwin') {
  lines.push(`  macOS is not yet test-verified for this plugin.`)
}
lines.push(``)
process.stderr.write(lines.join('\n'))
