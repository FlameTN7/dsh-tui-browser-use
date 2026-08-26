# dsh-tui-browser-use

> Browser automation tools for dsh-tui agents that can "see" the page.

**dsh-tui-browser-use** is a sub-plugin (Cordis plugin) of [dsh-tui](https://github.com/ccch1mneyyy/dsh-TUI).
It loads inside the `dsh --profile dsh-tui` composition and registers a set of browser tools for
the agent. It drives a real browser with [Playwright](https://playwright.dev/) and uses
[deepseek-v4-flash-vision-exp](https://api-docs.deepseek.com/guides/vision) for **visual
understanding** — letting the agent "see" screenshots, read canvas text, text inside images,
rendered charts and complex layouts, and return schema-validated structured data.

A browser-use capability aligned with Claude Code, but natively adapted for the DeepSeek ecosystem.

## Architecture

```
┌────────────────────────────────────────────────────────┐
│        dsh --profile dsh-tui (Cordis composition)        │
│                                                          │
│  dsh-tui-browser-use (this plugin)                       │
│    ├── src/index.ts         plugin entry + config schema │
│    ├── src/tools.ts         registers browser_* tools    │
│    ├── src/browser.ts       Playwright browser manager   │
│    ├── src/vision.ts        vision adapter layer         │
│    │     ├─ DeepSeekAdapter  (file_api native)           │
│    │     └─ OpenAIClient     (base64 inline)             │
│    ├── src/capabilities.ts provider capability detection │
│    ├── src/image-pipeline.ts compress/resize/tiling-det. │
│    ├── src/i18n.ts          bilingual UI dictionary      │
│    └── src/settings-section.ts registers /settings block │
└────────────────────────────────────────────────────────┘
```

> `src/tiling.ts` provides the split geometry; tall-page splitting is done at runtime by
> `BrowserSession.captureSegments()` via **scroll-capture** (scroll and capture multiple
> native-resolution viewport images at `viewport height − overlap`), rather than pixel-cropping
> a single oversized image.

## Tools

| Tool | Function | Notes |
|---|---|---|
| `browser_navigate` | Navigate to a URL | Basic |
| `browser_screenshot` | Screenshot + visual analysis | Auto vision pipeline (file_api / base64 / tiling) |
| `browser_click` | Click an element | Basic |
| `browser_type` | Type text | Basic |
| `browser_evaluate` | Execute JS | Basic |
| `browser_extract` | Structured extraction | Vision read + schema validation (reports `schema-validation-failed`) |
| `browser_task` | Natural-language multi-step task | Vision-driven navigate/click/type loop with per-step cost |
| `browser_status` | Browser status | Availability / version / configuration |

## Configuration

All config is exposed through the [dsh-tui settings section](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/docs/plugins.md)
(seam #6 `tuiSettingsSections`), and also configurable via `cordis.patch.yml`.

### Settings

| Setting | Default | Description |
|---|---|---|
| `visionMode` | `auto` | `auto` (detect) / `on` / `off` / `deepseek-file-api` |
| `screenshot.format` | `jpeg` | Screenshot format: `jpeg` / `webp` / `png` |
| `screenshot.quality` | `80` | Screenshot quality (JPEG/WebP encoding) |
| `screenshot.maxDimension` | `1024×768` | Max screenshot dimension (raw pixels) |
| `tiling.mode` | `auto` | `auto` (split when over threshold) / `on` / `off` |
| `tiling.threshold` | `1200×1200` | Splits the screenshot if it exceeds this size |
| `tiling.overlap` | `60` | Tile overlap pixels |
| `providers` | `[]` | Per-provider capability overrides (built-in table backs off) |

### Provider capability overrides

For non-official providers (OpenAI-compatible, self-hosted gateway, ...):

```json
{
  "providers": [
    {
      "provider": "my-gateway",
      "supportsVision": true,
      "imageTransfer": "base64",
      "maxImageBytes": 10485760,
      "detailPreference": "high"
    }
  ]
}
```

Decision priority: **explicit user config > provider declaration > built-in capability table >
model-name fallback**.

The built-in route table (`src/provider-router.ts`, since Round 4) recognizes two usable
multi-modal routes. Production does **not** read `llm-pi-ai.providers` from harness settings
(verified: that namespace is not registered on `ctx.settings`):

| provider | baseURL | apiKeyEnv | default model | transfer |
|---|---|---|---|---|
| `deepseek` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | `deepseek-v4-flash-vision-exp` | `file` (official Files API) |
| `xiaomi` | `https://api.xiaomimimo.com/v1` | `XIAOMI_API_KEY` | `mimo-v2.5` | `base64` |

> `scnet` is invalid since 2025-08 (429/unavailable) and was removed from the route table.
> **Non-multi-modal text models** (e.g. official `deepseek-v4-flash`) are rejected by
> `isVisionCapableModel`: even with `visionMode` on, `browser_screenshot` degrades to pure DOM
> `elementSummary` instead of sending a screenshot to a model that cannot read it.

#### Runtime route overrides (env vars)

| Var | Effect |
|---|---|
| `DSH_TUI_BROWSER_PROVIDER` | Select the route provider (`deepseek` / `xiaomi`), default `deepseek` |
| `DSH_TUI_BROWSER_MODEL` | Override the default model id |
| `DSH_TUI_BROWSER_BASE_URL` | Override the provider endpoint |
| `DSH_TUI_BROWSER_EXECUTABLE` | Point at a Chromium binary (constrained containers) |
| `DSH_TUI_BROWSER_PROXY` | HTTP proxy for the browser, e.g. `http://127.0.0.1:10800` (required for most external sites from the container) |

## Vision pipeline

```
Playwright screenshot
  → JPEG/WebP compression (q=80)
  → exceeds tiling.threshold?  → scroll-capture split (viewport-h − overlap, native-res images)
  → official DeepSeek+vision  → file_api upload → file_id reference
  → non-official+vision       → base64 inline (image_url, detail:high)
  → no vision / text model    → pure DOM extraction
```

**Why file_api (official DeepSeek)?**
- Upload once, reference many times (multi-step reuse), request body free from base64 bloat
- Single image up to 64 MiB, beyond the 32 MiB base64-inline limit
- Low token / high cache: ≤384 tokens per image, file_id hits prompt cache

**Model-call retry**: OpenAI-compatible / official endpoints retry on 429/5xx with exponential
backoff (`fetchWithRetry`, 600ms base, jitter, up to 4 retries), honoring `Retry-After`. This
absorbs rate-limit-prone endpoints like the former scnet route.

**Why default `quality=80` / `maxDimension=1024×768`?**
- The vision model pre-processes to 800×800; 1024×768 is slightly above it, balancing "readable + not wasteful"
- JPEG q=80 balances clarity and size; single image ≈100-300KB, won't bloat context

**Why `tiling=auto`?**
- Small screenshots (≤1200×1200) are not split — saves tokens
- Large screenshots (full-page / high-res) auto-split for detail. 4-6 tiles ≈ 2304 tokens ≈ $0.0005, negligible cost

## Build & verify

```sh
npm install            # install dependencies (postinstall prints browser guidance)
npm run build          # tsc → lib/types/
npm run check          # CI gate: build+smoke+verify:manifest+verify:i18n+router:check
npm run smoke          # headless smoke (entry + capability + preprocess + tool defs)
npm run verify:manifest # @dsh-std/manifest validates dsh-plugin.json
npm run verify:i18n     # bilingual dictionary completeness / placeholder parity
# Vision full-chain / real external site (needs DSH_TUI_BROWSER_EXECUTABLE + key/proxy):
npm run test:vision        # DeepSeek file_api single image
npm run test:vision-mimo   # xiaomi mimo-v2.5 base64
npm run test:vision-router # provider route (via apply()) → xiaomi
npm run test:vision-textonly # text model degrades to DOM
npm run test:real-task     # real external example.com multi-step browser_task
npm run test:real-extract  # real external browser_extract schema validation
npm run test:real-interact # real external duckduckgo via proxy type+click
```

Runtime imports only `@deepseek-ai/cordis` and `@deepseek-ai/schemastery`; Playwright is the
plugin's own dependency, not part of the harness boundary. Harness services are always accessed
via `ctx.get(...)` with structural typing.

## Docs

- Dev spec & invariants: [AGENTS.md](AGENTS.md)
- Protocol spec (RFC-style): [docs/proposals/browser-use.zh.md](docs/proposals/browser-use.zh.md)
- Skill doc: `skills/browser-bridge/SKILL.md`
- Chinese version: [README.md](README.md)

## Playwright provisioning

- `playwright` npm library is a `dependency` (ships with the package).
- On install, a `postinstall` hook bootstraps the browser: detects system Chrome / Playwright
  Chromium, and when missing prints a copyable command (Linux: `npx playwright install chromium
  --with-deps`; Windows/macOS: `npx playwright install chromium`).
- At startup, browser-source detection: **system Chrome (`channel: 'chrome'`) → explicit binary
  (`DSH_TUI_BROWSER_EXECUTABLE` env var / common `/usr/bin/chromium*`, `/opt/chromium-*` paths) →
  Playwright's own Chromium**, whichever is available. In constrained containers Playwright's
  official download often fails on missing CDN builds — point `DSH_TUI_BROWSER_EXECUTABLE` at an
  existing Chromium. If none, tools return `browser-error` + a fix hint, never a silent crash.

## Cross-platform

Browser capability relies on Playwright's cross-platform abstraction; the plugin never hard-codes
platform paths. Linux install needs `--with-deps`, Windows/macOS does not. **macOS behavior is not
runtime-tested (no test device)** — it relies on Playwright's cross-platform abstraction; regressions
should be checked per platform when integrated.

## i18n

All user-visible UI strings use a bilingual dictionary (zh + en); docs are kept in sync in
Chinese and English. Follows dsh-tui's `src/i18n.ts` flat dictionary + `t(key, params)` pattern,
`{{name}}` placeholder substitution.
