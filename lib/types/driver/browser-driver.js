/**
 * dsh-tui-browser-use — browser driver contract.
 *
 * AGENTS.md §2 / 竞品 B2: the Playwright-specific behaviour is isolated behind
 * a `BrowserDriver` interface so the harness/plugin can swap the backend (e.g.
 * a stub driver in tests, or a future headless-shell driver). `BrowserSession`
 * keeps the orchestration that is NOT driver-specific — the serial mutex
 * (`run`), timeout envelope, dialog policy, console/network ring buffers,
 * snapshot/tiling/status/saveScreenshots.
 *
 * The driver is a FULL BACKEND seam: it exposes the semantic page- and
 * context-level operations the session/page-ops layer needs, and it does NOT
 * leak a raw Playwright `page`/`context` handle. Navigation, interaction,
 * observation, cookies and download all route through driver methods, so a
 * non-Playwright backend can be swapped in without touching the session. All
 * Playwright handles stay private to the driver implementation; the structural
 * types below exist only as the implementation surface for `PlaywrightDriver`
 * and to keep the plugin compiling without pulling in the playwright type
 * package at build time (AGENTS.md §2).
 */
// Re-export the default Playwright implementation from the contract module so a
// consumer can `import { createPlaywrightDriver } from 'dsh-tui-browser-use/driver'`
// (the `./driver` package subpath maps to this file) and get both the contract
// types AND the concrete backend in one import — otherwise the advertised
// "swap the browser backend" seam is unreachable through its own subpath.
export { createPlaywrightDriver } from './playwright-driver.js';
//# sourceMappingURL=browser-driver.js.map