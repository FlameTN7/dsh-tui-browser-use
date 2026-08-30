# dsh-tui-browser-use

[简体中文](README.md) | [English](README_EN.md)

> 给 dsh-tui 的 agent 装上"看得见网页"的浏览器自动化工具。

**dsh-tui-browser-use** 是 [dsh-tui](https://github.com/ccch1mneyyy/dsh-TUI) 的子插件（Cordis 插件），随 `dsh --profile dsh-tui` 组合加载。它向 agent 注册 **21 个 `browser_*` 工具**，用 [Playwright](https://playwright.dev/) 驱动真实浏览器，并原生适配DeepSeek视觉模型理解截图，返回经 schema 校验的结构化结果。

## 功能特色

- **21 个工具**：浏览、交互、观察、结构化提取、自然语言多步任务、文件下载等。
- **视觉理解**：DeepSeek Files API（官方）或 OpenAI 兼容 base64 两种传输；
长页自动滚屏分段、宽页分片、截断上报（超级拼装是针对DeepSeek官方识图后端严格压缩适配的，采取了以token换精度的做法）。
- **会话能力**：登录态持久化、弹窗策略、串行互斥、导航/动作/收敛三类超时。
- **文件交互**：`browser_screenshot.savePath` 截图落盘、`browser_download` 带会话 cookie 下载文件。
- **安全默认**：视觉提示注入防护（`<task>` 定界，截图视为不可信内容）、URL/敏感 query/cookie 脱敏、无沙箱参数按需门控。
- **三引擎**：chromium（默认）/ firefox / webkit，配置可进 dsh-tui `/settings` 面板修改。

## 架构

```
┌────────────────────────────────────────────────────────┐
│        dsh --profile dsh-tui (Cordis 组合)              │
│                                                          │
│  dsh-tui-browser-use (本插件)                            │
│    ├── src/index.ts         插件入口 + 配置 schema        │
│    ├── src/tools.ts         注册 browser_* 工具           │
│    ├── src/browser.ts       Playwright 浏览器管理         │
│    ├── src/vision.ts        视觉理解适配层                │
│    │     ├─ DeepSeekAdapter  (Files API 原生)            │
│    │     └─ OpenAIClient     (base64 内联)               │
│    ├── src/capabilities.ts  provider 能力判定             │
│    ├── src/image-pipeline.ts 截图捕获期压缩/尺寸校验/切分判定│
│    ├── src/i18n.ts          双语 UI 字典                  │
│    └── src/settings-section.ts 注册 /settings 设置区块     │
└────────────────────────────────────────────────────────┘
```

长页切分由 `BrowserSession.captureSegments()` 按 `视口高 − overlap` **滚屏分段**截多张原生分辨率视口图，宽页再按 `视口宽 − overlap` 分列；超过 `tiling.maxTiles` 时结果透出 `tilesTruncated` 等元数据。

## 工具一览

| 类别 | 工具 | 说明 |
|---|---|---|
| 导航 | `browser_navigate` / `back` / `forward` / `reload` | 返回标题 + URL + 状态码 |
| 交互 | `browser_click` / `type` / `hover` / `press` / `scroll` / `wait` | 支持 `text=`/`role=`/`label=`/CSS 定位；`type` 可选 `clear` + `enter` |
| 观察 | `browser_screenshot` / `snapshot` / `evaluate` | 截图 + 视觉分析；DOM 元素索引快照；页面内 JS 求值 |
| 提取/任务 | `browser_extract` / `task` | schema 校验 + 失败重试 ≤2；自然语言多步循环，累计成本 |
| 会话 | `browser_cookies` / `console_messages` / `network_requests` / `pdf` / `download` / `status` | cookie 值默认掩码、`readValues` 可选；console/网络捕获；PDF/下载/浏览器状态 |

## 部署

### 安装与挂载

```sh
npm install dsh-tui-browser-use
npx playwright install chromium --with-deps   # Linux；Windows/macOS 去掉 --with-deps
```

在 dsh-tui profile 的 `cordis.patch.yml` 挂载：

```yaml
- insert:
    - id: dsh-tui-browser-use
      name: 'dsh-tui-browser-use'
      config:
        visionMode: 'auto'
```

`postinstall` 会检测系统 Chrome / Playwright Chromium，缺失时输出可复制的安装命令；也可用 `DSH_TUI_BROWSER_EXECUTABLE` 直接指向已有 Chromium。浏览器缺失时工具返回 `browser-error` + 修复指引，不静默崩溃。

### 视觉 API key（可选，建议配置）

`visionMode: auto` 默认走官方 DeepSeek 视觉路由，密钥取 `DEEPSEEK_API_KEY`（官方 Files API）。需要接入其他 OpenAI 兼容视觉端点时，用 `DSH_TUI_BROWSER_PROVIDER` / `DSH_TUI_BROWSER_MODEL` / `DSH_TUI_BROWSER_BASE_URL` 覆盖，密钥按该端点解析（如 `OPENAI_API_KEY`）。无可用视觉模型时，`browser_screenshot` 返回 `visionUsed:false` + `visionUnavailableReason`；DOM 观察由 `browser_snapshot` 承担，浏览器工具不受影响。

### 常用环境变量

部分变量注册到TUI的Settings界面下可供快速调整

| 变量 | 说明 |
|---|---|
| `DSH_TUI_BROWSER_ENGINE` | 浏览器引擎：`chromium`（默认）/ `firefox` / `webkit` |
| `DSH_TUI_BROWSER_EXECUTABLE` | 指向已有 Chromium 二进制 |
| `DSH_TUI_BROWSER_PROVIDER` / `_MODEL` / `_BASE_URL` | 覆盖视觉 provider / 模型 / 端点 |
| `DSH_TUI_BROWSER_PROXY` | 浏览器 HTTP 代理；`DSH_TUI_BROWSER_PROXY_BYPASS` 覆盖回环绕过列表 |
| `DSH_TUI_BROWSER_USER_DATA_DIR` / `_STORAGE_STATE` | 持久化登录态 / 导出导入 storageState 快照 |
| `DSH_TUI_BROWSER_DIALOG` | 弹窗策略：`dismiss`（默认）/ `accept` / `ignore` |
| `DSH_TUI_BROWSER_TIMEOUT_NAVIGATION` / `_ACTION` / `_SETTLE` | 超时 ms（默认 45000 / 12000 / 6000） |
| `DSH_TUI_BROWSER_MAX_TILES` | 滚屏分段最大段数（默认 24） |

### 设置面板

`/settings` 中 browser-use 区块（10 个字段）可改：`visionMode`、`viewport.width/height`、`screenshot.format/quality`、`tiling.mode/threshold/overlap/maxTiles`、`proxy`。`lang` 与 `providers[]` 暂无 UI，走 `cordis.patch.yml` / 环境变量配置。

## 视觉管线（简述）

```
Playwright 截图
  → 捕获期 JPEG 压缩（品质 80→60→40 阶梯，超预算降档）；管线尺寸/字节校验（不做像素级缩放）
  → 超过 tiling.threshold？ → 滚屏分段（原生分辨率多图，含宽页分列）
  → DeepSeek Files API → file_id 引用（按内容 hash 复用，命中 prompt cache）
  → OpenAI 兼容端点 → base64 内联
  → 无视觉模型 → 短路（visionUsed:false + visionUnavailableReason）
```

- **Files API**：使用DeepSeek官方视觉模型时，截图上传一次可多次引用，请求体不随 base64 膨胀且更易于命中缓存；文件默认 24h 过期（`DSH_TUI_BROWSER_FILE_EXPIRES_SECONDS` 可调），同一截图按内容复用 file_id。
- **可靠性**：视觉请求 429/5xx 指数退避重试；`browser_extract` schema 校验失败重试 ≤2 次并附 violation 清单。
- **提示注入防护**：视觉指令用 `<task>…</task>` 定界，system 消息声明截图是不可信页面内容，页内指令一律按数据处理。

## 构建与验证

```sh
npm run build           # tsc → lib/types/
npm run check           # CI 门禁：build + smoke(21 tools) + manifest + i18n + router
npm run test:logic      # 8 个纯逻辑回归（无需浏览器/key）
npm run test:container  # stub harness 加载产物 + 真实启动浏览器（21 工具注册）
npm run test:integration # 真实浏览器集成（导航/点击/输入/截图/切分/快照）
```


## 已知限制

该项目是纯Vibe Coding产物，仅于无头Linux环境进行初步的功能实现与验证，欢迎拷打

## 文档

- 技能文档：`skills/browser-bridge/SKILL.md`

## License

[MIT](LICENSE)
