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
| `browser_screenshot` | Capture + understand the page | `instruction?` |
| `browser_click` | Click by selector or visible text | `selector?` / `text?` |
| `browser_type` | Fill an input | `selector`, `text` |
| `browser_evaluate` | Run JS in the page | `expression` |
| `browser_extract` | Extract structured data by a JSON Schema | `schema`, `instruction?` |
| `browser_task` | Run a multi-step natural-language task | `instruction` |
| `browser_snapshot` | Index interactive/semantic elements (role/name/bbox) to observe the page without a screenshot | `maxNodes?` |
| `browser_back` / `browser_forward` / `browser_reload` | Go back / forward / reload | — |
| `browser_scroll` | Scroll by a pixel delta | `x?` / `y?` |
| `browser_press` | Press a keyboard key | `key` |
| `browser_wait` | Wait for a selector visible, or sleep | `selector?` / `ms?` |
| `browser_hover` | Hover a selector or visible text | `selector?` / `text?` |
| `browser_cookies` | Read / clear / add cookies | `clear?` / `cookies?` |
| `browser_console_messages` | Capture console output | `clear?` |
| `browser_network_requests` | Capture network requests | `clear?` |
| `browser_status` | Check availability + config | — |

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
  `browser_screenshot` falls back to a DOM element summary instead of
  visual insight.
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

## Gotchas

- `browser_extract` reads the page with the vision model and returns JSON that
  satisfies the provided schema; a mismatch reports `schema-validation-failed`.
  It needs vision (a provider key). `browser_task` runs a bounded
  vision-driven loop of navigate/click/type actions toward a natural-language
  instruction and reports the answer, step count, and cost.
- Screenshots are compressed (JPEG/WebP q=80) and downsampled to
  `maxDimension` before vision. Large pages that exceed the tiling threshold
  carry a tile plan (geometry only; pixel cropping needs a codec and is
  deferred).
- TUI settings: the plugin's config is editable under `/settings` →
  **Browser Automation (browser-use)**. It can also be set via
  `cordis.patch.yml`.

## See also

- `docs/proposals/browser-use.zh.md` — the versioned protocol spec.
- `README.md` / `README_EN.md` — full config reference and architecture.
