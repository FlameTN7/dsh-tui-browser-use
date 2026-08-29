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

> Tall-page splitting computes the split geometry inline in
> `BrowserSession.captureSegments()` via **scroll-capture** (scroll and capture multiple
> native-resolution viewport images at `viewport height − overlap`), rather than pixel-cropping
> a single oversized image.

## Tools

| Tool | Function | Notes |
|---|---|---|
| `browser_navigate` | Navigate to a URL | Basic |
| `browser_screenshot` | Screenshot + visual analysis | Auto vision pipeline (file_api / base64 / tiling) |
| `browser_click` | Click an element | Basic |
| `browser_type` | Type text | Basic; optional `clear` to empty first + `enter` to press a trailing key |
| `browser_evaluate` | Execute JS | Basic |
| `browser_extract` | Structured extraction | Vision read + schema validation (reports `schema-validation-failed`, retried ≤2 times) |
| `browser_task` | Natural-language multi-step task | Vision-driven navigate/click/type/scroll/press/wait/hover loop with cumulative cost |
| `browser_snapshot` | Accessibility snapshot | Returns an indexed list of interactive/semantic elements (role/name/bbox) as the default observation; vision is the fallback |
| `browser_back` / `browser_forward` / `browser_reload` | Back / forward / reload | Returns title + URL + status |
| `browser_scroll` | Scroll | Pixel offset `x`/`y`, returns the resulting scroll position |
| `browser_press` | Press a key | `key` like Enter/Escape/Tab/Control+S |
| `browser_wait` | Wait | A `selector` becomes visible, or sleep `ms` (capped 30000) |
| `browser_hover` | Hover | `selector`/`text`, reveals dropdowns/tooltips |
| `browser_cookies` | Cookies | Read, optional `clear` or `cookies` to write; values masked as `***` by default, `readValues:true` reads them |
| `browser_console_messages` | Console capture | `[type] text`, `clear` (default true) |
| `browser_network_requests` | Network capture | `REQ <method> <url>` / `<status> <url>` / `<no-response> <url>`, `clear` (default true) |
| `browser_pdf` | Print to PDF | Returns `{ url, path, bytes }`; temp file when `path` omitted |
| `browser_download` | Download file | Uses the session request context (cookies/auth) to fetch a URL; returns `{ url, path, bytes, contentType }` |
| `browser_status` | Browser status | Availability / version / configuration |

## Configuration

The main config is exposed through the [dsh-tui settings section](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/docs/plugins.md)
(seam #6 `tuiSettingsSections`), and also configurable via `cordis.patch.yml`. Note `lang` and
`providers[]` have no UI yet — configure them via `cordis.patch.yml` / env.

### Settings

| Setting | Default | Description |
|---|---|---|
| `visionMode` | `auto` | `auto` (detect) / `on` / `off` / `deepseek-file-api` |
| `viewport.width` | `1024` | Real viewport width (CSS px) |
| `viewport.height` | `768` | Real viewport height (CSS px) |
| `screenshot.format` | `jpeg` | Screenshot format: `jpeg` / `png` (webp removed) |
| `screenshot.quality` | `80` | Screenshot quality (JPEG encoding) |
| `screenshot.maxDimension` | — | Deprecated alias (see `viewport`; historical configs still accepted) |
| `tiling.mode` | `auto` | `auto` (split when over threshold) / `on` / `off` |
| `tiling.threshold` | `1200×1200` | Splits the screenshot if it exceeds this size |
| `tiling.overlap` | `60` | Tile overlap pixels |
| `tiling.maxTiles` | `24` | Max scroll-capture segments; `DSH_TUI_BROWSER_MAX_TILES` env backs off |
| `proxy` | — (empty) | HTTP proxy (e.g. `http://127.0.0.1:10800`); empty falls back to `DSH_TUI_BROWSER_PROXY` |
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
> `isVisionCapableModel`: even with `visionMode` on, `browser_screenshot` short-circuits to a
> no-vision result (`visionUsed:false` + `visionUnavailableReason`); DOM observation is unified
> under `browser_snapshot` (R-05) instead of sending a screenshot to a model that cannot read it.

#### Runtime route overrides (env vars)

| Var | Effect |
|---|---|
| `DSH_TUI_BROWSER_PROVIDER` | Select the route provider (`deepseek` / `xiaomi`), default `deepseek` |
| `DSH_TUI_BROWSER_MODEL` | Override the default model id |
| `DSH_TUI_BROWSER_BASE_URL` | Override the provider endpoint |
| `DSH_TUI_BROWSER_EXECUTABLE` | Point at a Chromium binary (constrained containers) |
| `DSH_TUI_BROWSER_ENGINE` | Browser engine: `chromium` (default) / `firefox` / `webkit` |
| `DSH_TUI_BROWSER_PROXY` | HTTP proxy for the browser, e.g. `http://127.0.0.1:10800` (required for most external sites from the container) |
| `DSH_TUI_BROWSER_TIMEOUT_NAVIGATION` | Navigation timeout ms (default 45000: `goto`/`back`/`forward`/`reload`) |
| `DSH_TUI_BROWSER_TIMEOUT_ACTION` | Action timeout ms (default 12000: `click`/`type` waiting for an element) |
| `DSH_TUI_BROWSER_TIMEOUT_SETTLE` | Settle timeout ms (default 6000: `wait` selector) |
| `DSH_TUI_BROWSER_DIALOG` | Dialog handling: `dismiss` (default) / `accept` / `ignore` |
| `DSH_TUI_BROWSER_USER_DATA_DIR` | Chromium user data dir (persist cookies/localStorage/login across runs) |
| `DSH_TUI_BROWSER_STORAGE_STATE` | storageState snapshot path (loaded on start, saved on close) |
| `DSH_TUI_BROWSER_MAX_TILES` | Max scroll-capture tile count (default 12) |
| `DSH_TUI_BROWSER_SENSITIVE_QUERY_KEYS` | Sensitive query keys to redact (comma-separated; default `token,key,signature,sig,secret,api_key,apikey,access_token,session,cred,auth`) |

## Vision pipeline

```
Playwright screenshot
  → JPEG/WebP compression (q=80)
  → exceeds tiling.threshold?  → scroll-capture split (viewport-h − overlap, native-res images)
  → official DeepSeek+vision  → file_api upload → file_id reference
  → non-official+vision       → base64 inline (image_url, detail:high)
  → no vision / text model    → short-circuit (visionUsed:false + visionUnavailableReason); DOM observation via browser_snapshot
```

**Why file_api (official DeepSeek)?**
- Upload once, reference many times (multi-step reuse), request body free from base64 bloat
- Single image up to 64 MiB, beyond the 32 MiB base64-inline limit
- Low token / high cache: ≤384 tokens per image, file_id hits prompt cache
- **File lifetime**: an upload accepts `expires_after[seconds]` (1h–30d; omit for permanent). `DSH_TUI_BROWSER_FILE_EXPIRES_SECONDS`
  controls it (default 24h; `0`/empty/negative → permanent). The default avoids piling up files forever and outlives
  a single session, so a reused file_id never expires mid-conversation.
- **file_id reuse (content-hash)**: identical screenshot bytes reuse one file_id, avoiding re-uploads and keeping the
  request prefix stable → hits DeepSeek's disk prompt cache. The cache surfaces in `usage` as `promptCacheHitTokens` /
  `promptCacheMissTokens`, and cost bills hit tokens at the cache-hit discount rate.

**Model-call retry**: OpenAI-compatible / official endpoints retry on 429/5xx with exponential
backoff (`fetchWithRetry`, 600ms base, jitter, up to 4 retries), honoring `Retry-After`. This
absorbs rate-limit-prone endpoints like the former scnet route.

**Extract retry + prompt-injection fencing**: `browser_extract` validates against the caller JSON Schema
and retries ≤2 times on a parse/schema failure, surfacing the concrete violation list so the model can
self-correct. The vision instruction is framed with `<task>…</task>` and the system message marks the
screenshot as untrusted page content — an instruction appearing *inside* the page is treated as data,
never as a directive (defends against prompt injection).

**Why default `quality=80` / `viewport=1024×768`?**
- The vision model pre-processes to 800×800; 1024×768 is slightly above it, balancing "readable + not wasteful"
- JPEG q=80 balances clarity and size; single image ≈100-300KB, won't bloat context

**Why `tiling=auto`?**
- Small screenshots (≤1200×1200) are not split — saves tokens
- Large screenshots (full-page / high-res) auto-split for detail. 4-6 tiles ≈ 2304 tokens ≈ $0.0005, negligible cost
- **Wide pages also split**: columns step by `viewport-width − overlap` and rows by `viewport-height − overlap`, so a wide page is no longer clipped to the left viewport.
- **Truncation reported**: when a page needs more tiles than `maxTiles` (default 24, adjustable via `/settings` or `DSH_TUI_BROWSER_MAX_TILES`), `browser_screenshot` surfaces `tilesTotal`/`tilesCaptured`/`tilesTruncated` and injects a "content only read down to ~Y px, rest is missing" note into the vision instruction.
- **sticky de-dup**: adjacent tiles overlap at the seam; the vision instruction says duplicated band is the same page region — never double-count it.

## Build & verify

```sh
npm install            # install dependencies (postinstall prints browser guidance)
npm run build          # tsc → lib/types/
npm run check          # CI gate: build+smoke+verify:manifest+verify:i18n+router:check
npm run smoke          # headless smoke (entry + capability + preprocess + tool defs, 20 tools)
npm run test:logic     # pure-logic tests: extract retry / prompt-injection fencing / settings-live / render contract / redact / usage accumulate / abort (no browser/key)
npm run test:integration # live browser integration (needs DSH_TUI_BROWSER_EXECUTABLE)
npm run test:tiling-defects # tiling 3-defect regression: wide split/truncation/control (needs DSH_TUI_BROWSER_EXECUTABLE)
npm run verify:manifest # @dsh-std/manifest validates dsh-plugin.json
npm run verify:i18n     # bilingual dictionary completeness / placeholder parity
# Vision full-chain / real external site (needs DSH_TUI_BROWSER_EXECUTABLE + key/proxy):
npm run test:vision        # DeepSeek file_api single image
npm run test:vision-cache  # file_api / cache-hit verification (needs DSH_TUI_BROWSER_EXECUTABLE + DeepSeek key)
npm run test:vision-mimo   # xiaomi mimo-v2.5 base64
npm run test:vision-router # provider route (via apply()) → xiaomi
npm run test:vision-textonly # text model degrades to DOM
npm run test:dynamic       # SPA/lazy + text/role locator + waitFor + shadow
npm run test:engine        # cross-engine (chromium/firefox/webkit)
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
- **Cross-engine**: `DSH_TUI_BROWSER_ENGINE=firefox|webkit` selects a non-chromium engine
  (Chromium/Firefox/WebKit all verified). Firefox via `npx playwright install firefox`; WebKit also
  needs `npx playwright install-deps webkit` for its system libs (apt pulls libmanette/libenchant/
  libhyphen/libsecret/libgles2, etc.).
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
