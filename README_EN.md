# dsh-tui-browser-use

[简体中文](README.md) | [English](README_EN.md)

> Browser automation tools for dsh-tui agents that can "see" the page.

**dsh-tui-browser-use** is a sub-plugin (Cordis plugin) of [dsh-tui](https://github.com/ccch1mneyyy/dsh-TUI). It loads inside the `dsh --profile dsh-tui` composition, registers **21 `browser_*` tools** for the agent, drives a real browser with [Playwright](https://playwright.dev/), and is natively adapted to DeepSeek vision models for screenshot understanding, returning schema-validated structured results.

## Features

- **21 tools**: browsing, interaction, observation, structured extraction, natural-language multi-step tasks, file download, and more.
- **Super-assembly tiling**: tuned for the strict compression of DeepSeek's official vision backend; tall or wide pages are automatically captured in scroll segments / column splits with truncation reporting, keeping recognition accuracy high.
- **Session**: session-profile & login-state management (`session.mode` persistent / isolated, lock file for concurrency, conflict auto-degrades to a fresh ephemeral profile, whole directory is packable/migratable), dialog policy, serialized mutex, navigation/action/settle timeouts.
- **Security**: vision prompt-injection fencing (`<task>` delimiters, screenshots treated as untrusted content), URL/sensitive-query/cookie redaction, sandbox flags gated by need.
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
npm run test:logic      # 18 pure-logic regression suites (no browser/key)
npm run test:container  # stub harness loads the artifact + real browser boot (21 tools)
npm run test:integration # live browser integration (navigate/click/type/screenshot/tiling/snapshot)
npm run test:storage-state # storageState corruption fallback + persistent import (live browser)
```

## Programmatic use / extension points

The plugin exposes a small programming surface so a host or third party can drive the browser or swap a backend without touching the tool registries.

- **Browser backend**: `BrowserSession` is constructed with a `BrowserDriver` (default `PlaywrightDriver`). Inject your own driver (e.g. a stub or a future headless-shell backend) to replace the Playwright implementation. The driver contract lives at `dsh-tui-browser-use/driver`.
- **Vision transport**: `createVisionAdapter(env, runtimeEnv)` returns the adapter for the resolved image-transfer mode (`file` → DeepSeek Files-API; `base64`/`url` → OpenAI-compatible inline). Swappable at `dsh-tui-browser-use/vision`.
- **Tool registration**: `buildToolDefinitions(deps)` / `registerTools(ctx, deps)` registries accept an injected session + vision resolver, so a host can wrap or extend them.

Subpath exports: `dsh-tui-browser-use/driver`, `dsh-tui-browser-use/vision`, `dsh-tui-browser-use/types`. The tool count and the unified result envelope (`{ ok, value|error, usage? }`) are part of the contract and must not change.

## Known limitations

This project is a pure Vibe Coding product: implementation and the full regression suite are verified on headless Linux. Feedback — including hard scrutiny — is welcome.

## Docs

- Skill doc: `skills/browser-bridge/SKILL.md`

## License

[MIT](LICENSE)
