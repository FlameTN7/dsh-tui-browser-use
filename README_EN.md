# dsh-tui-browser-use

[简体中文](README.md) | [English](README_EN.md)

> Browser automation tools for dsh-tui agents that can "see" the page.

**dsh-tui-browser-use** is a sub-plugin (Cordis plugin) of [dsh-tui](https://github.com/ccch1mneyyy/dsh-TUI). It loads inside the `dsh --profile dsh-tui` composition, registers **21 `browser_*` tools** for the agent, drives a real browser with [Playwright](https://playwright.dev/), and is natively adapted to DeepSeek vision models for screenshot understanding, returning schema-validated structured results.

## Features

- **21 tools**: browsing, interaction, observation, structured extraction, natural-language multi-step tasks, file download, and more.
- **Vision**: DeepSeek Files API (official) or OpenAI-compatible base64 transfer; automatic scroll-capture for tall pages, column splitting for wide pages, truncation reporting. (The super-assembly tiling is tuned for the strict compression constraints of DeepSeek's official vision backend — a deliberate token-for-accuracy trade-off.)
- **Session**: login-state persistence, dialog policy, serialized mutex, navigation/action/settle timeouts.
- **File interaction**: `browser_screenshot.savePath` writes screenshots to disk; `browser_download` downloads files with the session's cookies.
- **Secure defaults**: vision prompt-injection fencing (`<task>` delimiters, screenshots treated as untrusted content), URL/sensitive-query/cookie redaction, sandbox flags gated by need.
- **Three engines**: chromium (default) / firefox / webkit; config editable in the dsh-tui `/settings` panel.

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
│    │     ├─ DeepSeekAdapter  (Files API native)          │
│    │     └─ OpenAIClient     (base64 inline)             │
│    ├── src/capabilities.ts provider capability detection │
│    ├── src/image-pipeline.ts capture-compress/size-check/tiling-det. │
│    ├── src/i18n.ts          bilingual UI dictionary      │
│    └── src/settings-section.ts registers /settings block │
└────────────────────────────────────────────────────────┘
```

Tall pages are captured by `BrowserSession.captureSegments()` as multiple native-resolution viewport images at `viewport height − overlap`; wide pages are split into columns at `viewport width − overlap`. Results expose `tilesTruncated` and related metadata when the page needs more than `tiling.maxTiles` segments.

## Tools

| Category | Tools | Notes |
|---|---|---|
| Navigation | `browser_navigate` / `back` / `forward` / `reload` | Returns title + URL + status |
| Interaction | `browser_click` / `type` / `hover` / `press` / `scroll` / `wait` | `text=`/`role=`/`label=`/CSS locators; `type` supports `clear` + `enter` |
| Observation | `browser_screenshot` / `snapshot` / `evaluate` | Screenshot + vision; indexed DOM snapshot; in-page JS evaluation |
| Extraction/tasks | `browser_extract` / `task` | Schema validation with ≤2 retries; natural-language multi-step loop with cumulative cost |
| Session | `browser_cookies` / `console_messages` / `network_requests` / `pdf` / `download` / `status` | Cookie values masked by default (`readValues` opt-in); console/network capture; PDF/download/status |

## Deployment

### Install and mount

```sh
npm install dsh-tui-browser-use
npx playwright install chromium --with-deps   # Linux; omit --with-deps on Windows/macOS
```

Mount it in the dsh-tui profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-tui-browser-use
      name: 'dsh-tui-browser-use'
      config:
        visionMode: 'auto'
```

The `postinstall` hook detects a system Chrome or Playwright Chromium and prints a copyable install command when missing; you can also point `DSH_TUI_BROWSER_EXECUTABLE` at an existing Chromium. When no browser is available, tools return `browser-error` with a fix hint instead of failing silently.

### Vision API key (optional, recommended)

With `visionMode: auto`, the default route is official DeepSeek vision, keyed by `DEEPSEEK_API_KEY` (Files API). To use another OpenAI-compatible vision endpoint, override `DSH_TUI_BROWSER_PROVIDER` / `DSH_TUI_BROWSER_MODEL` / `DSH_TUI_BROWSER_BASE_URL` and resolve the key for that endpoint (e.g. `OPENAI_API_KEY`). When no vision-capable model is available, `browser_screenshot` returns `visionUsed:false` + `visionUnavailableReason`; DOM observation stays available through `browser_snapshot` and browser tools keep working.

### Common environment variables

Some of these are also exposed in the TUI Settings screen for quick adjustment.

| Variable | Effect |
|---|---|
| `DSH_TUI_BROWSER_ENGINE` | Browser engine: `chromium` (default) / `firefox` / `webkit` |
| `DSH_TUI_BROWSER_EXECUTABLE` | Point at an existing Chromium binary |
| `DSH_TUI_BROWSER_PROVIDER` / `_MODEL` / `_BASE_URL` | Override vision provider / model / endpoint |
| `DSH_TUI_BROWSER_PROXY` | HTTP proxy for the browser; `DSH_TUI_BROWSER_PROXY_BYPASS` overrides the loopback bypass list |
| `DSH_TUI_BROWSER_USER_DATA_DIR` / `_STORAGE_STATE` | Persist login state / export-import a storageState snapshot |
| `DSH_TUI_BROWSER_DIALOG` | Dialog policy: `dismiss` (default) / `accept` / `ignore` |
| `DSH_TUI_BROWSER_TIMEOUT_NAVIGATION` / `_ACTION` / `_SETTLE` | Timeouts in ms (defaults 45000 / 12000 / 6000) |
| `DSH_TUI_BROWSER_MAX_TILES` | Max scroll-capture segments (default 24) |

### Settings panel

The browser-use section in `/settings` (10 fields) exposes: `visionMode`, `viewport.width/height`, `screenshot.format/quality`, `tiling.mode/threshold/overlap/maxTiles`, `proxy`. `lang` and `providers[]` have no UI yet — configure them via `cordis.patch.yml` / environment variables.

## Vision pipeline (brief)

```
Playwright screenshot
  → capture-time JPEG compression (quality staircase 80→60→40, drop on budget).
    Pipeline size/byte validation; no pixel-level scaling.
  → exceeds tiling.threshold? → scroll-capture (native-res images, wide pages split into columns)
  → DeepSeek Files API → file_id reference (content-hash reuse, prompt-cache friendly)
  → OpenAI-compatible endpoint → base64 inline
  → no vision model → short-circuit (visionUsed:false + visionUnavailableReason)
```

- **Files API**: with an official DeepSeek vision model, screenshots are uploaded once and referenced many times; request bodies do not grow with base64 and cache hits are easier to achieve. Uploads expire after 24h by default (`DSH_TUI_BROWSER_FILE_EXPIRES_SECONDS`); identical screenshots reuse one file_id.
- **Reliability**: vision requests retry 429/5xx with exponential backoff; `browser_extract` retries parse/schema failures ≤2 times with the violation list attached.
- **Prompt-injection defense**: vision instructions are fenced with `<task>…</task>` and the system message declares screenshots untrusted page content — instructions inside a page are data, never directives.

## Build & verify

```sh
npm run build           # tsc → lib/types/
npm run check           # CI gate: build + smoke(21 tools) + manifest + i18n + router
npm run test:logic      # 8 pure-logic regression suites (no browser/key)
npm run test:container  # stub harness loads the artifact + real browser boot (21 tools)
npm run test:integration # live browser integration (navigate/click/type/screenshot/tiling/snapshot)
```

## Known limitations

This project is a pure Vibe Coding product: it has only been initially implemented and verified in a headless Linux environment. Feedback — including hard scrutiny — is welcome.

## Docs

- Skill doc: `skills/browser-bridge/SKILL.md`

## License

[MIT](LICENSE)
