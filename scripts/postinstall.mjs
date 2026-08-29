#!/usr/bin/env node
/**
 * dsh-tui-browser-use — Playwright browser bootstrap guidance.
 *
 * Per AGENTS.md §9, the Playwright npm lib ships in this package but the
 * browser binary is provisioned separately. This postinstall runs after every
 * install and prints the correct platform-specific command — but first it
 * DETECTS whether a usable browser already exists (system Google Chrome/
 * Chromium, or a Playwright-downloaded bundle under ~/.cache/ms-playwright)
 * so a reinstall on an already-provisioned box is a quiet no-op (R-09).
 *
 * It deliberately does NOT auto-download browsers (that would be a large,
 * surprising download on every `npm install`); the startup probe and tool
 * error hint cover the "missing browser" case with actionable guidance.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const platform = process.platform

/** Detect a system-chrome/chromium binary the startup probe would find. */
function hasSystemChrome() {
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  return candidates.some((p) => existsSync(p))
}

/** Detect a Playwright-bundled browser cache (the `install chromium` target). */
function hasPlaywrightBrowsers() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright')
  try { return existsSync(cache) } catch { return false }
}

const browserReady = hasSystemChrome() || hasPlaywrightBrowsers()

const installCmd = platform === 'linux'
  ? 'npx playwright install chromium --with-deps'
  : 'npx playwright install chromium'

const lines = [`\n[dsh-tui-browser-use] Playwright browsers not auto-installed.`]
if (browserReady) {
  lines.push(`  A Chromium runtime is already available — nothing to do.`)
} else {
  lines.push(`  The browser toolset needs a Chromium runtime at first use.`)
  lines.push(`  Install it once:`)
  lines.push(`    ${installCmd}`)
  lines.push(`  Alternatively, install system Google Chrome.`)
}
if (platform === 'linux') {
  lines.push(`  (On Linux, a system package manager is the usual path.)`)
}
// The "unverified" warning is macOS-specific; it must NOT print on
// Linux/Windows (previously the condition was inverted, see P2-04).
if (platform === 'darwin') {
  lines.push(`  macOS is not yet test-verified for this plugin; report any issue.`)
}
lines.push(``)
process.stderr.write(lines.join('\n'))
