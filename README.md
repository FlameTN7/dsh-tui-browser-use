# dsh-tui-browser-use

> 给 dsh-tui 的 agent 装上"看得见网页"的浏览器自动化工具。

**dsh-tui-browser-use** 是 [dsh-tui](https://github.com/ccch1mneyyy/dsh-TUI) 的子插件（Cordis 插件）。
它在 `dsh --profile dsh-tui` 组合内随 dsh-tui 一起加载，向 agent 注册一组浏览器工具，用
[Playwright](https://playwright.dev/) 驱动真实浏览器，再用
[deepseek-v4-flash-vision-exp](https://api-docs.deepseek.com/guides/vision) 做**视觉理解**——
让 agent 能"看见"截图，读懂 canvas 文字、图片内文字、渲染图表和复杂布局，并返回 schema
校验后的结构化数据。

对标 Claude Code 的 browser-use 能力，但针对 DeepSeek 生态做了原生适配。

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
│    │     ├─ DeepSeekAdapter  (file_api 原生)             │
│    │     └─ OpenAIClient     (base64 内联)               │
│    ├── src/capabilities.ts  provider 能力判定             │
│    ├── src/image-pipeline.ts 截图压缩/降采样/切分判定      │
│    ├── src/i18n.ts          双语 UI 字典                  │
│    └── src/settings-section.ts 注册 /settings 设置区块     │
└────────────────────────────────────────────────────────┘
```

> 长页切块由 `BrowserSession.captureSegments()` 内联计算切分几何并做**滚屏分段**
> （按视口高−overlap 滚动截多张原生分辨率视口图），而非对整张超长图做像素裁剪。

## 工具集

| 工具 | 功能 | 说明 |
|---|---|---|
| `browser_navigate` | 导航到 URL | 基础 |
| `browser_screenshot` | 截图 + 视觉分析 | 走视觉管线（file_api / base64 / tiling 自动） |
| `browser_click` | 点击元素 | 基础 |
| `browser_type` | 输入文本 | 基础；可选 `clear` 先清空 + `enter` 后按回车 |
| `browser_evaluate` | 执行 JS | 基础 |
| `browser_extract` | 结构化提取 | 视觉读取 + schema 校验（`schema-validation-failed` 上报，失败重试 ≤2 次） |
| `browser_task` | 自然语言多步任务 | 视觉驱动的 navigate/click/type/scroll/press/wait/hover 循环，带累计成本 |
| `browser_snapshot` | 可访问性快照 | 返回可交互/语义元素索引（role/name/bbox），作为默认观察，视觉降为兜底 |
| `browser_back` / `browser_forward` / `browser_reload` | 前进/后退/刷新 | 返回标题+URL+状态码 |
| `browser_scroll` | 滚动 | 按像素偏移 `x`/`y`，返回实际滚动位置 |
| `browser_press` | 按键 | `key` 如 Enter/Escape/Tab/Control+S |
| `browser_wait` | 等待 | `selector` 可见或 `ms` 睡眠（上限 30000） |
| `browser_hover` | 悬停 | `selector`/`text`，显示下拉/工具提示 |
| `browser_cookies` | Cookie | 读取，可选 `clear` 或 `cookies` 写入；值默认掩为 `***`，`readValues:true` 读原值 |
| `browser_console_messages` | console 捕获 | `[type] text`，`clear`（默认 true） |
| `browser_network_requests` | 网络捕获 | `REQ <method> <url>` / `<status> <url>` / `<no-response> <url>`，`clear`（默认 true） |
| `browser_pdf` | 打印 PDF | 返回 `{ url, path, bytes }`，`path` 省略则写入临时文件 |
| `browser_status` | 浏览器状态 | 可用性/版本/配置 |

## 配置

主要配置项经 [dsh-tui 设置区块](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/docs/plugins.md)（接缝六 `tuiSettingsSections`）
暴露到 `/settings` 界面，也可经 `cordis.patch.yml` 静态配置。注意 `lang` 与 `providers[]` 暂无 UI，只能走
`cordis.patch.yml` / env 配置。

### 设置项

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `visionMode` | `auto` | `auto`（自动探测）/ `on` / `off` / `deepseek-file-api` |
| `viewport.width` | `1024` | 真实视口宽度（CSS px） |
| `viewport.height` | `768` | 真实视口高度（CSS px） |
| `screenshot.format` | `jpeg` | 截图格式：`jpeg` / `png`（webp 已移除） |
| `screenshot.quality` | `80` | 截图质量（JPEG 编码） |
| `screenshot.maxDimension` | — | 已废弃别名（见 `viewport`；历史配置仍兼容） |
| `tiling.mode` | `auto` | `auto`（超阈值自动切分）/ `on` / `off` |
| `tiling.threshold` | `1200×1200` | 超过则该截图进入切分流程 |
| `tiling.overlap` | `60` | tile 间重叠像素 |
| `providers` | `[]` | 用户可配置各 provider 的能力覆盖（内置表兜底） |

### Provider 能力覆盖

非官方 provider（OpenAI 兼容、自部署网关等）的能力通过设置区块配置：

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

判定优先级：**用户显式配置 > provider 声明 > 内置能力表 > 模型名回退**。

内置路由表（`src/provider-router.ts`，Round 4 起）识别两条可用的多模态路由，生产环境**不读
harness settings 的 `llm-pi-ai.providers`**（实测该 namespace 未注册到 `ctx.settings`）：

| provider | baseURL | apiKeyEnv | 默认模型 | 传输 |
|---|---|---|---|---|
| `deepseek` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | `deepseek-v4-flash-vision-exp` | `file`（官方 Files API） |
| `xiaomi` | `https://api.xiaomimimo.com/v1` | `XIAOMI_API_KEY` | `mimo-v2.5` | `base64` |

> `scnet` 已于 2025-08 失效（429/不可用），从路由表移除。**非多模态文本模型**（如官方
> `deepseek-v4-flash`）会被 `isVisionCapableModel` 判为不支持视觉：即使 `visionMode` 未关，也
> 不把截图发给它，`browser_screenshot` **短路**为无视觉返回（`visionUsed:false` + `visionUnavailableReason`），
> DOM 观察统一交给 `browser_snapshot`（R-05）。

#### 运行时路由覆盖（环境变量）

| 变量 | 作用 |
|---|---|
| `DSH_TUI_BROWSER_PROVIDER` | 选择路由 provider（`deepseek` / `xiaomi`），默认 `deepseek` |
| `DSH_TUI_BROWSER_MODEL` | 覆盖默认模型 id |
| `DSH_TUI_BROWSER_BASE_URL` | 覆盖 provider 端点 |
| `DSH_TUI_BROWSER_EXECUTABLE` | 指定 Chromium 二进制（受限容器用） |
| `DSH_TUI_BROWSER_ENGINE` | 选择浏览器引擎：`chromium`（默认）/ `firefox` / `webkit` |
| `DSH_TUI_BROWSER_PROXY` | 给浏览器接 HTTP 代理，如 `http://127.0.0.1:10800`（容器访问多数外网站点必需） |
| `DSH_TUI_BROWSER_TIMEOUT_NAVIGATION` | 导航超时 ms（默认 45000，`goto/back/forward/reload`） |
| `DSH_TUI_BROWSER_TIMEOUT_ACTION` | 交互超时 ms（默认 12000，`click/type` 等待元素可交互） |
| `DSH_TUI_BROWSER_TIMEOUT_SETTLE` | 等待/收敛超时 ms（默认 6000，`wait` 的 selector 等待） |
| `DSH_TUI_BROWSER_DIALOG` | 弹窗处理：`dismiss`（默认）/ `accept` / `ignore` |
| `DSH_TUI_BROWSER_USER_DATA_DIR` | Chromium 用户数据目录（持久化 cookie/localStorage/登录态） |
| `DSH_TUI_BROWSER_STORAGE_STATE` | storageState 快照路径（启动导入 + 关闭导出 cookie/localStorage） |
| `DSH_TUI_BROWSER_MAX_TILES` | 滚屏切分最大段数（默认 12） |
| `DSH_TUI_BROWSER_SENSITIVE_QUERY_KEYS` | 脱敏的敏感 query 键（逗号分隔；默认 `token,key,signature,sig,secret,api_key,apikey,access_token,session,cred,auth`） |

## 视觉管线

截图进入模型前的流水线：

```
Playwright 截图
  → JPEG/WebP 压缩 (q=80)
  → 超过 tiling.threshold?  → 滚屏分段 (视口高−overlap 切多张原生分辨率图)
  → 官方 DeepSeek+vision → file_api 上传 → file_id 引用
  → 非官方+vision       → base64 内联 (image_url, detail:high)
  → 无视觉/文本模型      → 短路 (visionUsed:false + visionUnavailableReason)，DOM 观察交给 browser_snapshot
```

**为什么用 file_api（官方 DeepSeek）？**
- 截图上传一次，多次引用（多步任务复用），请求体不受 base64 膨胀
- 单图可达 64 MiB，超出 base64 内联的 32 MiB 限制
- 低 token 高缓存：每张 ≤384 token，file_id 可命中 prompt cache
- **文件存活期**：上传可设 `expires_after[seconds]`（1h–30d，省略=永久）。`DSH_TUI_BROWSER_FILE_EXPIRES_SECONDS`
  控制（默认 24h；`0`/空/负 → 永久）。默认不永久堆积，且长于一次会话，保证复用的 file_id 不透支。
- **file_id 复用（content-hash）**：同一张截图（相同字节）复用同一 file_id，避免重复上传，也让重复请求的
  前缀稳定 → 命中 DeepSeek 磁盘 prompt cache。缓存在 `usage` 透出
  `promptCacheHitTokens` / `promptCacheMissTokens`，计费对命中 token 按 cache-hit 折扣费率。

**模型调用重试**：OpenAI 兼容端点/官方 API 在 429/5xx 时按指数退避重试（`fetchWithRetry`，
基础 600ms 增长，抖动 ±，上限 4 次），尊重 `Retry-After`。scnet 这类易 429 的端点由此扛住。

**提取校验-重试 + 提示注入防护**：`browser_extract` 按调用方 JSON Schema 校验，失败会重试 ≤2 次并
附上 violation 清单让模型自纠；视觉指令用 `<task>…</task>` 定界，system 消息声明截图是**不可信页面
内容**——页面里出现的指令一律当数据读，绝不当作命令执行（防 prompt injection）。

**为什么默认 `quality=80` / `viewport=1024×768`？**
- 视觉模型预处理会缩到 800×800，1024×768 略高于它，兼顾"看得清 + 不浪费"
- JPEG q=80 在清晰度和体积间取平衡，单图约 100-300KB，不撑上下文

**为什么 `tiling=auto`？**
- 小截图（≤1200×1200）不切，省 token
- 大截图（整页/高分辨率）自动切块，保证细节可见。4-6 块 ≈ 2304 token ≈ $0.0005，成本可忽略
- **宽页也分片**：按 `视口宽−overlap` 分列 + `视口高−overlap` 分行，宽页不再只留最左视口。
- **截断上报**：需要段数超过 `maxTiles`（默认 12）时，`browser_screenshot` 结果透出
  `tilesTotal`/`tilesCaptured`/`tilesTruncated`，并向视觉模型注入「内容到 ~Y px 为止、其后缺失」。
- **sticky 去重**：相邻块边缘 `overlap` 重叠，视觉指令说明「属同一页面区域，勿重复计数」。

## 构建与验证

```sh
npm install            # 安装依赖（postinstall 打印浏览器就绪指引）
npm run build          # tsc → lib/types/
npm run check          # CI 门禁：build+smoke+verify:manifest+verify:i18n+router:check
npm run smoke          # 无头冒烟（入口 + 能力判定 + 截图预处理 + 工具定义，20 工具）
npm run test:logic     # 纯逻辑测试：extract 重试 / 提示注入护栏 / settings-live / render 契约 / 脱敏 / usage 累计 / abort（无需浏览器/key）
npm run test:integration # 真实浏览器集成（需 DSH_TUI_BROWSER_EXECUTABLE）
npm run test:tiling-defects # tiling 三缺陷回归：宽页分片/截断上报/控制页（需 DSH_TUI_BROWSER_EXECUTABLE）
npm run verify:manifest # @dsh-std/manifest 校验 dsh-plugin.json
npm run verify:i18n     # 双语字典完整性/占位符一致性校验
# 视模型全链路 / 真实外网站点（需 DSH_TUI_BROWSER_EXECUTABLE + 对应 key/代理）：
npm run test:vision        # DeepSeek file_api 单图
npm run test:vision-cache  # file_api/缓存命中验证（需 DSH_TUI_BROWSER_EXECUTABLE + DeepSeek key）
npm run test:vision-mimo   # xiaomi mimo-v2.5 base64
npm run test:vision-router # provider 路由(经 apply())→ xiaomi
npm run test:vision-textonly # 文本模型降级 DOM
npm run test:dynamic       # SPA/懒加载/text+role 定位/waitFor/shadow
npm run test:engine        # 跨浏览器引擎 (chromium/firefox/webkit)
npm run test:real-task     # 真实外网 example.com 多步 browser_task
npm run test:real-extract  # 真实外网 browser_extract schema 校验
npm run test:real-interact # 真实外网 duckduckgo 走代理 type+click
```

运行时只 import `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`；Playwright 作为插件自身
依赖，不进 harness 边界。harness 服务一律 `ctx.get(...)` 结构类型化访问。

## 文档

- 开发规范与不变量：[AGENTS.md](AGENTS.md)
- 协议规格（RFC 式）：[docs/proposals/browser-use.zh.md](docs/proposals/browser-use.zh.md)
- 技能文档：`skills/browser-bridge/SKILL.md`
- 英文版：[README_EN.md](README_EN.md)

## Playwright 配套

- `playwright` npm 库进 `dependencies`（随包分发）。
- 安装时 `postinstall` 引导浏览器就绪：检测系统 Chrome / Playwright Chromium，缺失时输出
  可复制命令（Linux 为 `npx playwright install chromium --with-deps`，Windows/macOS 为
  `npx playwright install chromium`）。
- **跨引擎**：`DSH_TUI_BROWSER_ENGINE=firefox|webkit` 选非 chromium 引擎（Chromium/Firefox/WebKit
  三引擎均实测可用）。Firefox 用 `npx playwright install firefox`；WebKit 需再加
  `npx playwright install-deps webkit` 装系统库（apt 拉 libmanette/libenchant/libhyphen/
  libsecret/libgles2 等）。
- 启动时浏览器源探测：**系统 Chrome（`channel: 'chrome'`）→ 显式二进制（`DSH_TUI_BROWSER_EXECUTABLE`
  环境变量 / 常见 `/usr/bin/chromium*`、`/opt/chromium-*` 路径）→ Playwright 自带 Chromium**，
  哪个可用用哪个。受限容器里 Playwright 官方下载常因 CDN 缺 build 失败，可用
  `DSH_TUI_BROWSER_EXECUTABLE=/path/to/chrome` 指向现有 Chromium。缺失时工具返回
  `browser-error` + 修复指引，绝不静默崩溃。

## 多端适配

浏览器能力依赖 Playwright 跨平台抽象，插件不硬编码平台路径。Linux 安装需 `--with-deps`，
Windows/macOS 无需。**macOS 行为未实测（无测试设备）**，依赖 Playwright 跨平台抽象，接入
时发现问题在对应平台回归。

## i18n

所有用户可见 UI 字符串走双语字典（zh + en），文档中英文双语同步。参照 dsh-tui 的
`src/i18n.ts` flat dictionary + `t(key, params)` 模式，`{{name}}` 占位符替换。
