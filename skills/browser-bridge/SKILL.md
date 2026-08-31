---
name: browser-bridge
description: Browser automation toolset (Playwright + vision) for dsh-tui agents. Prefer browser_snapshot to observe the DOM, browser_screenshot to read the visual page, browser_extract for schema-typed data, and browser_task for a multi-step goal.
---

# browser-bridge — Browser Automation Tools

`dsh-tui-browser-use` gives the agent a browser-automation toolset driven by
Playwright, with visual understanding via a vision model. Use these tools when
a task needs to see or interact with a real web page — reading canvas/text-in-
images, filling forms, clicking through flows, evaluating page JavaScript, or
grabbing structured data from a rendered DOM.

## Tools

All tools live in the `browser_*` namespace and return a unified envelope
`{ ok, value?, error?, usage? }`.

| Tool | Purpose | Key params |
|---|---|---|
| `browser_navigate` | Go to a URL | `url` |
| `browser_screenshot` | Capture + understand the page. Result reports `oversizeTiles` when some captured tiles still exceed the byte budget. `savePath` writes to disk: a single capture goes to `savePath` verbatim; tiled captures write `stem-N.ext` beside it (the extension honors `savePath` first, then falls back to `screenshot.format`) | `instruction?` / `savePath?` |
| `browser_click` | Click by selector or visible text | `selector?` / `text?` |
| `browser_type` | Fill an input | `selector`, `text` |
| `browser_evaluate` | Run JS in the page | `expression` |
| `browser_extract` | Extract structured data by a JSON Schema | `schema`, `instruction?` |
| `browser_task` | Run a multi-step natural-language task | `instruction` |
| `browser_snapshot` | Index interactive/semantic elements (role/name/bbox) to observe the page without a screenshot. Nodes carry a stable, cross-call `id`; `delta:true` returns `added/changed/removed/reindexed` since the last snapshot | `maxNodes?` / `delta?` |
| `browser_back` / `browser_forward` / `browser_reload` | Go back / forward / reload | — |
| `browser_scroll` | Scroll by a pixel delta | `x?` / `y?` |
| `browser_press` | Press a keyboard key | `key` |
| `browser_wait` | Wait for a selector visible, or sleep | `selector?` / `ms?` |
| `browser_hover` | Hover a selector or visible text | `selector?` / `text?` |
| `browser_cookies` | Read / clear / add cookies | `clear?` / `cookies?` |
| `browser_console_messages` | Capture console output | `clear?` |
| `browser_network_requests` | Capture network requests | `clear?` |
| `browser_pdf` | Print the page to a PDF | `path?` / `format?` |
| `browser_download` | Download a file from a URL to disk (uses session cookies/auth) | `url` / `savePath?` |
| `browser_status` | Check availability + config + the effective session profile (`value.session`: mode/profile/sanitized profileDir/degraded) | — |

## Common workflow

1. `browser_navigate` to the target URL.
2. `browser_screenshot` with an `instruction` describing what you want to read
   (e.g. "read all link text", "describe the chart").
3. Act: `browser_click` / `browser_type`, then re-screenshot to confirm.
4. If you need structured output, use `browser_evaluate` (scripts) or
   `browser_extract` (schema-driven).

## Vision behavior

- Vision is **auto by default**: official DeepSeek uses the Files API
  (`file_id`), other providers inlined as base64 `image_url`, `detail: high`.
- If the current provider has no vision endpoint (or `visionMode: off`),
  `browser_screenshot` short-circuits to a no-vision result
  (`visionUsed:false` + `visionUnavailableReason`). Observe the DOM with
  `browser_snapshot` instead — it is the default way to see what is clickable
  or typeable without a screenshot.
- `detail: high` is mandatory for page screenshots — a `low` detail resizes to
  512×512 and makes text unreadable.
- Only the **official DeepSeek** channel supports file-based image transfer;
  other providers use base64 inline.

## Browser provisioning

- The `playwright` npm lib ships with this plugin; the browser binary is
  installed once: `npx playwright install chromium` (Linux: add `--with-deps`).
- At first use the plugin probes **system Chrome → Playwright Chromium**. If
  neither exists, tools return `browser-error` with an install hint — never a
  silent crash.

## Session / login state

The plugin manages browser login state through a `session` config block (and the
`DSH_TUI_BROWSER_USER_DATA_DIR` / `DSH_TUI_BROWSER_STORAGE_STATE` env vars).

- **`session.mode: persistent`** keeps one fixed, named profile whose login
  survives browser restarts. Useful for accounts that must stay signed in across
  turns. It takes an atomic lock at startup; if the same named profile is already
  locked by another session, the plugin auto-degrades to a fresh `isolated`
  profile (`browser_status` reports `degraded:true`) instead of hanging.
- **`session.mode: isolated`** (default) uses a brand-new ephemeral profile each
  run and cleans it up on close — a clean login state every time.
- **`session.profile`** names the profile directory (validated as one safe path
  segment, 1-64 chars of `A-Za-z0-9._-`). Copy the whole `profiles/<name>/`
  directory to another machine or path, point `session.profile` at it, and the
  login state follows — the profile dir is packable/migratable.
- The env vars take precedence over `session.mode` (external, unmanaged profile).
- `browser_status`'s `value.session` reflects the sanitized runtime-effective
  profile. Change `session.mode` by restarting the session (like `proxy`).

## Gotchas

- `browser_extract` reads the page with the vision model and returns JSON that
  satisfies the provided schema; a mismatch reports `schema-validation-failed`.
  It needs vision (a provider key). `browser_task` runs a bounded
  vision-driven loop of navigate/click/type/scroll/press/wait/hover actions
  toward a natural-language instruction and reports the answer, step count,
  and cost.
- Screenshots are compressed at capture time against the real `viewport`
  (`viewport.width`/`viewport.height`, default 1024×768; the old
  `screenshot.maxDimension` is a deprecated alias): JPEG uses a descending
  quality staircase (configured → 60 → 40) so an oversized tile is re-captured
  at a lower quality; the pipeline then validates the byte budget and reports
  `oversize`. No pixel-level scaling is done (a codec is not wired). Large
  pages that exceed the tiling threshold carry a tile plan (geometry only;
  pixel cropping needs a codec and is deferred).
- `browser_cookies` masks cookie values as `***` by default and reads them
  only with `readValues:true`, so a page's auth state never leaks into the
  model context.
- `browser_click` / `browser_type` / `browser_scroll` accept an optional
  `delta:true` to return a short page-change delta (labeled untrusted); it is
  off by default, so existing callers see no extra output.
- TUI settings: the plugin's config is editable under `/settings` →
  **Browser Automation (browser-use)**, including `session.mode` /
  `session.profile`. It can also be set via `cordis.patch.yml`.

## See also

- `docs/proposals/browser-use.zh.md` — the versioned protocol spec.
- `README.md` / `README_EN.md` — full config reference and architecture.
