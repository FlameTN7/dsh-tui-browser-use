# dsh-tui-browser-use

[简体中文](README.md) | [English](README_EN.md)

> Browser automation tools for dsh-tui agents that can "see" the page.

**dsh-tui-browser-use** is a sub-plugin (Cordis plugin) of [dsh-tui](https://github.com/ccch1mneyyy/dsh-TUI). It loads inside the `dsh --profile dsh-tui` composition, registers **21 `browser_*` tools** for the agent, drives a real browser with [Playwright](https://playwright.dev/), and is natively adapted to DeepSeek vision models for screenshot understanding, returning schema-validated structured results.

## Features

- **21 tools**: 21 atomic `browser_*` tools covering navigation, interaction, DOM snapshot & extraction, vision analysis, and multi-step autonomous tasks.
- **Super-assembly tiling**: tuned for DeepSeek's vision compression limits; tall or wide pages are automatically scroll-split, sliced, and resolution-preserved so key information is not lost to compression.
- **Session**: persistent login profiles and one-shot isolated sessions, with a built-in concurrency lock and conflict-degradation mechanism, plus packable cross-device migration.
- **Security**: built-in vision prompt-injection fencing and sensitive-parameter redaction; `file:` and SSRF (cloud metadata) are rejected by default, and file writes are strictly confined to the workspace.
- **Browser engines**: chromium (bundled, cross-platform) / firefox / webkit; config editable in the dsh-tui `/settings` panel.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│        dsh --profile dsh-tui (Cordis composition)              
│                                                          
│  dsh-tui-browser-use (this plugin)                            
│    ├── src/index.ts             plugin entry + config/public exports    
│    ├── src/tools/registry.ts    registers browser_* tools (per-tool dispose)
│    ├── src/browser.ts          Playwright browser session manager   
│    │     └─ driver/            BrowserDriver + PlaywrightDriver 
│    ├── src/vision/             VisionAdapter dual transports        
│    │     ├─ deepseek-file-adapter (Files API native)       
│    │     └─ openai-compat-adapter (base64 inline)          
│    ├── src/session-profiles.ts session profiles/lock/storage-state atomic write     
│    ├── src/runtime-env.ts      centralized DSH_TUI_* env injection 
│    ├── src/capabilities.ts     provider capability detection          
│    ├── src/image-pipeline.ts   capture-compress/size-check/tiling-det. 
│    ├── src/i18n.ts             bilingual UI dictionary               
│    └── src/settings-section.ts registers /settings block     
└──────────────────────────────────────────────────────────────────┘
```

## Tools

| Category | Tools | Notes |
|---|---|---|
| Navigation | `browser_navigate` / `back` / `forward` / `reload` | Returns title + URL + status |
| Interaction | `browser_click` / `type` / `hover` / `press` / `scroll` / `wait` | `text=`/`role=`/`label=`/CSS locators; `type` supports `clear` + `enter` |
| Observation | `browser_screenshot` / `snapshot` / `evaluate` | Screenshot + vision (`oversizeTiles` reports tiles still over the byte budget; `savePath` writes tiles to disk); indexed DOM snapshot (nodes carry a cross-call stable `id`; optional `delta` returns incremental changes); in-page JS evaluation |
| Extraction/tasks | `browser_extract` / `task` | Schema validation with ≤2 retries; natural-language multi-step loop with cumulative cost |
| Session | `browser_cookies` / `console_messages` / `network_requests` / `pdf` / `download` / `status` | Cookie values masked by default (`readValues` opt-in); console/network capture; PDF/download; `browser_status` also reports the effective session profile (`value.session`: mode/profile/sanitized profileDir/degraded) |

## Deployment

### Install and mount

```sh
npm install dsh-tui-browser-use
npx playwright install chromium --with-deps   # Linux; omit --with-deps on Windows/macOS
```

> Compatibility: this plugin targets **dsh-tui v0.10.0-beta.5** and depends on its harness services `tools` / `credentials` / `settings` / `tuiSettingsSections` / `skills`.

Mount it in the dsh-tui profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-tui-browser-use
      name: 'dsh-tui-browser-use'
      config:
        visionMode: 'auto'
```

The `postinstall` hook detects a system Chrome or Playwright Chromium and prints a copyable install command when missing; you can also point `DSH_TUI_BROWSER_EXECUTABLE` at an existing Chromium.

### Session profile modes (optional)

The `session` config block manages browser login-state profiles:

```yaml
config:
  visionMode: 'auto'
  session:
    mode: 'persistent'   # persistent keeps a fixed named profile (login survives restarts); isolated uses a fresh temp profile each run
    profile: 'default'    # profile directory name (`^[A-Za-z0-9._-]{1,64}$`, rejects `.`/`..`)
```

- Layout under the profile root: `profiles/<name>/user-data` (cookies/login state), `states/<name>.storage-state.json` (atomic write, chmod 0600), `ephemeral/<run-id>/` (isolated temp profile, cleaned on close).
- The profile root is a cross-platform cache dir: Linux `$XDG_CACHE_HOME` (default `~/.cache`) → macOS `~/Library/Caches` → Windows `%LOCALAPPDATA%`, under `dsh-tui-browser-use`.
- Packable/migratable: copy `profiles/<name>/` to another machine/path, point `session.profile` at it, and the login state follows the profile.

### Settings panel

The plugin registers a `browser-use` namespace in dsh-tui; common settings are visible in `/settings`, and some changes need a session restart to take effect.

### Environment overrides (optional)

Common settings can also be overridden via environment variables; some take effect only on session restart:

| Variable | Purpose | Default |
|---|---|---|
| `DSH_TUI_BROWSER_PROVIDER` / `_MODEL` + `OPENAI_API_KEY` | Switch to an OpenAI-compatible vision route (non-DeepSeek endpoint) | Built-in `deepseek` route |
| `DSH_TUI_BROWSER_BASE_URL` | Required endpoint for a non-DeepSeek/non-OpenAI provider (e.g. an Anthropic/Gemini gateway). Without it such providers degrade to pure DOM rather than being misrouted to OpenAI | Built-in `deepseek`/`openai` endpoints |
| `DSH_TUI_BROWSER_DIALOG` | Dialog policy `dismiss` / `accept` / `ignore` | `dismiss` |
| `DSH_TUI_BROWSER_ENGINE` | Browser engine `chromium` / `firefox` / `webkit` | `chromium` |
| `DSH_TUI_BROWSER_PROXY` / `_PROXY_BYPASS` | Outbound proxy (read at browser startup) | none |
| `DSH_TUI_BROWSER_TIMEOUT_NAVIGATION` / `_ACTION` / `_SETTLE` | Navigation / action / settle timeouts (ms) | 45000 / 12000 / 6000 |
| `DSH_TUI_BROWSER_USER_DATA_DIR` / `_STORAGE_STATE` | External session dir / login-state snapshot (falls back to a fresh session on failure) | built-in profile root |
| `DSH_TUI_BROWSER_NO_SANDBOX` | Force-inject `--no-sandbox`; when unset the chromium container args are auto-injected only for root/container (uid===0) | auto (root/container only) |
| `DSH_TUI_BROWSER_WORKSPACE` | Extra workspace root permitted for writes (alongside CWD/temp) | none (CWD/temp only) |
| `DSH_TUI_BROWSER_WRITE_ANY` | `1` opts out of the write containment (security opt-in; refuses writes outside the workspace by default) | `0` |
| `DSH_TUI_BROWSER_ALLOW_UNSAFE_URL` | `1` relaxes the URL policy (`file:` / cloud-metadata/link-local), so `browser_navigate` may also visit `file:` (whose download is now read locally); navigation and downloads reject these by default | `0` |
| `DSH_TUI_BROWSER_MAX_DOWNLOAD_BYTES` | Max bytes buffered per `browser_download` (over-limit returns `response too large`) | 100MB |
| `DSH_TUI_BROWSER_CNY_USD_RATE` | USD→CNY rate for cost estimation | 7.2 |

## Vision pipeline (brief)

```
Playwright screenshot
  → capture-time JPEG compression (quality staircase 80→60→40, drop on budget).
    Pipeline size/byte validation.
  → exceeds tiling.threshold? → scroll-capture (native-res images, wide pages split into columns)
  → DeepSeek Files API → file_id reference (content-hash reuse before expiry, prompt-cache friendly)
  → OpenAI-compatible endpoint → base64 inline
```

## Build & verify

```sh
npm run build           # tsc → lib/types/
npm run check           # CI gate: build + smoke(21 tools) + manifest + i18n + router
npm run test:logic      # 20 pure-logic regression suites (no browser/key)
npm run test:container  # stub harness loads the artifact + real browser boot (21 tools)
npm run test:integration # live browser integration (navigate/click/type/screenshot/tiling/snapshot)
npm run test:storage-state # storageState corruption fallback + persistent import (live browser)
```

## Architecture extension points

The plugin's core logic is fully decoupled from the underlying browser driver and never exposes a raw `page` / `context` handle.

- **Swap the browser backend**: `BrowserSession` depends only on the `BrowserDriver` abstraction. To plug in a non-Playwright backend (e.g. Puppeteer or a standalone CDP connection), implement that contract and inject your implementation via `dsh-tui-browser-use/driver`.
- **Custom vision routing**: via `createVisionAdapter` in `dsh-tui-browser-use/vision`, you can switch or extend the image-transport strategy (DeepSeek Files API and OpenAI-compatible base64 are supported by default).
- **Tool extension**: via `registerTools` you can inject a custom session and vision resolver, so a host can wrap or intercept tool behavior.

## Notes & feedback

Implementation and the full regression suite are verified on headless Linux. If you hit edge-case issues or have suggestions, feel free to open an Issue / PR.

## Docs

- Skill doc: `skills/browser-bridge/SKILL.md`

## License

[MIT](LICENSE)
