# dsh-tui-browser-use

[简体中文](README.md) | [English](README_EN.md)

> 给 dsh-tui 的 agent 装上"看得见网页"的浏览器自动化工具。

**dsh-tui-browser-use** 是 [dsh-tui](https://github.com/ccch1mneyyy/dsh-TUI) 的子插件（Cordis 插件），随 `dsh --profile dsh-tui` 组合加载。它向 agent 注册 **21 个 `browser_*` 工具**，用 [Playwright](https://playwright.dev/) 驱动真实浏览器，并原生适配DeepSeek视觉模型理解截图，返回经 schema 校验的结构化结果。

## 功能特色

- **21 个工具**：浏览、交互、观察、结构化提取、自然语言多步任务、文件下载等。
- **超级拼装**: 针对DeepSeek官方识图后端的严格压缩进行适配,长页或宽页自动滚屏分段、分片、截断上传,确保识图的精度。
- **会话能力**：会话档案与登录态管理（`session.mode` 持久化 / isolated 独立、锁文件防并发、冲突自动降级为独立临时档案、整目录可打包迁移），弹窗策略、串行互斥、导航/动作/收敛三类超时。
- **安全策略**：视觉提示注入防护（`<task>` 定界，截图视为不可信内容）、URL/敏感 query/cookie 脱敏；**导航与下载默认拦 `file:` 与云元数据/link-local**（`DSH_TUI_BROWSER_ALLOW_UNSAFE_URL=1` 放开），写盘默认收窄到工作区/临时目录（`DSH_TUI_BROWSER_WRITE_ANY=1` 放开）。**在 root/容器（uid===0）下会自动为 chromium 注入 `--no-sandbox` 等容器参数**（隐式安全降级，可用 `DSH_TUI_BROWSER_NO_SANDBOX=1` 强制，详见环境变量表）。
- **浏览器引擎支持**：chromium（默认内嵌,可跨平台）/ firefox / webkit，配置可进 dsh-tui `/settings` 面板修改。

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│        dsh --profile dsh-tui (Cordis 组合)              
│                                                          
│  dsh-tui-browser-use (本插件)                            
│    ├── src/index.ts            插件入口 + 配置/公共导出    
│    ├── src/tools/registry.ts   注册 browser_* 工具（逐工具注销）
│    ├── src/browser.ts          Playwright 浏览器会话管理   
│    │     └─ driver/            BrowserDriver + PlaywrightDriver 
│    ├── src/vision/             VisionAdapter 双实现        
│    │     ├─ deepseek-file-adapter (Files API 原生)       
│    │     └─ openai-compat-adapter (base64 内联)          
│    ├── src/session-profiles.ts 会话档案/锁/存储态原子写     
│    ├── src/runtime-env.ts      集中注入 DSH_TUI_* 环境变量 
│    ├── src/capabilities.ts     provider 能力判定          
│    ├── src/image-pipeline.ts   截图捕获期压缩/尺寸校验/切分 
│    ├── src/i18n.ts             双语 UI 字典               
│    └── src/settings-section.ts 注册 /settings 设置区块     
└──────────────────────────────────────────────────────────────────┘
```


## 工具一览

| 类别 | 工具 | 说明 |
|---|---|---|
| 导航 | `browser_navigate` / `back` / `forward` / `reload` | 返回标题 + URL + 状态码 |
| 交互 | `browser_click` / `type` / `hover` / `press` / `scroll` / `wait` | 支持 `text=`/`role=`/`label=`/CSS 定位；`type` 可选 `clear` + `enter` |
| 观察 | `browser_screenshot` / `snapshot` / `evaluate` | 截图 + 视觉分析（`oversizeTiles` 报告超字节预算的段数）；DOM 元素索引快照（节点带跨调用稳定 `id`，可选 `delta` 返回增量）；页面内 JS 求值 |
| 提取/任务 | `browser_extract` / `task` | schema 校验 + 失败重试 ≤2；自然语言多步循环，累计成本 |
| 会话 | `browser_cookies` / `console_messages` / `network_requests` / `pdf` / `download` / `status` | cookie 值默认掩码、`readValues` 可选；console/网络捕获；PDF/下载；`browser_status` 额外报告运行期会话档案（`value.session`：mode/profile/profileDir 脱敏/degraded） |

## 部署

### 安装与挂载

```sh
npm install dsh-tui-browser-use
npx playwright install chromium --with-deps   # Linux；Windows/macOS 去掉 --with-deps
```

> 兼容性：本插件面向 **dsh-tui v0.10.0-beta.4 及以上**组合（当前评审基线），依赖其提供
> `tools` / `credentials` / `settings` / `tuiSettingsSections` / `skills` 等 harness 服务。

在 dsh-tui profile 的 `cordis.patch.yml` 挂载：

```yaml
- insert:
    - id: dsh-tui-browser-use
      name: 'dsh-tui-browser-use'
      config:
        visionMode: 'auto'
```

`postinstall` 会检测系统 Chrome / Playwright Chromium，缺失时输出可复制的安装命令；也可用 `DSH_TUI_BROWSER_EXECUTABLE` 直接指向已有 Chromium。

### 会话档案模式（可选）

`session` 配置块管理浏览器登录态档案：

```yaml
config:
  visionMode: 'auto'
  session:
    mode: 'persistent'   # persistent 保留固定命名档案（重启登录仍在）；isolated 每次独立临时档案
    profile: 'default'    # 档案目录名（`^[A-Za-z0-9._-]{1,64}$`，拒绝 `.`/`..`）
```

- 目录布局：`<档案根>/profiles/<name>/user-data`（含 cookies/登录态）、`<档案根>/states/<name>.storage-state.json`（原子写、0644→0600）、`<档案根>/ephemeral/<run-id>/`（isolated 临时档案，关闭即清理）。
- 档案根为跨平台缓存目录：Linux `$XDG_CACHE_HOME`（默认 `~/.cache`）→ macOS `~/Library/Caches` → Windows `%LOCALAPPDATA%`，下挂 `dsh-tui-browser-use`。
- 整目录可打包迁移：把 `profiles/<name>/` 复制到另一台机器/路径，将 `session.profile` 指向它，登录态即随档案迁移。


### 设置面板

本插件于dsh-tui注册命名空间,可于dsh-tui的/settings看见常用设置,部分设置需要会话重启后生效

### 环境变量覆盖（可选）

常用配置也可经环境变量覆盖，部分需会话重启后生效：

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_TUI_BROWSER_PROVIDER` / `_MODEL` + `OPENAI_API_KEY` | 切换到 OpenAI 兼容视觉路由（非 DeepSeek 端点） | 内置 `deepseek` 路由 |
| `DSH_TUI_BROWSER_BASE_URL` | 非 DeepSeek/OpenAI provider 必填端点（如 Anthropic/Gemini 网关）。未设时该类 provider 降级为纯 DOM，不会误发到 OpenAI 端点 | `deepseek`/`openai` 内置端点 |
| `DSH_TUI_BROWSER_DIALOG` | 弹窗策略 `dismiss` / `accept` / `ignore` | `dismiss` |
| `DSH_TUI_BROWSER_ENGINE` | 浏览器引擎 `chromium` / `firefox` / `webkit` | `chromium` |
| `DSH_TUI_BROWSER_PROXY` / `_PROXY_BYPASS` | 外网代理（浏览器启动时读取） | 无 |
| `DSH_TUI_BROWSER_TIMEOUT_NAVIGATION` / `_ACTION` / `_SETTLE` | 导航 / 动作 / 收敛超时（ms） | 45000 / 12000 / 6000 |
| `DSH_TUI_BROWSER_USER_DATA_DIR` / `_STORAGE_STATE` | 外部会话目录 / 登录态快照（读取失败回退全新会话） | 内置档案根 |
| `DSH_TUI_BROWSER_NO_SANDBOX` | 强制注入 `--no-sandbox`；未设时仅在 root/容器（uid===0）下自动注入 chromium 的容器参数 | 自动（仅 root/容器） |
| `DSH_TUI_BROWSER_WORKSPACE` | 额外允许写入的 workspace 根（与 CWD/临时目录并列） | 无（仅 CWD/临时目录） |
| `DSH_TUI_BROWSER_WRITE_ANY` | `1` 放开“任意路径写盘”（安全 opt-in，默认拒绝工作区外写入） | `0` |
| `DSH_TUI_BROWSER_ALLOW_UNSAFE_URL` | `1` 放开 URL 策略（`file:` / 云元数据/link-local），使 `browser_navigate` 也能访问 `file:`（其下载 `file:` 现走本地读取）；默认导航与下载都拦截 | `0` |
| `DSH_TUI_BROWSER_MAX_DOWNLOAD_BYTES` | 单次 `browser_download` 缓冲上限（超限返回 `response too large`） | 100MB |
| `DSH_TUI_BROWSER_CNY_USD_RATE` | 成本估算的 USD→CNY 汇率 | 7.2 |

## 视觉管线（简述）

```
Playwright 截图
  → 捕获期 JPEG 压缩（品质 80→60→40 阶梯，超预算降档）；管线尺寸/字节校验
  → 超过 tiling.threshold？ → 滚屏分段（原生分辨率多图，含宽页分列）
  → DeepSeek Files API → file_id 引用（过期前按内容 hash 复用，命中 prompt cache）
  → OpenAI 兼容端点 → base64 内联
```

## 构建与验证

```sh
npm run build           # tsc → lib/types/
npm run check           # CI 门禁：build + smoke(21 tools) + manifest + i18n + router
npm run test:logic      # 19 个纯逻辑回归（无需浏览器/key；含会话档案/启动失败锁释放/快照 delta/驱动契约/密钥探测/运行时环境/provider 路由守卫等）
npm run test:container  # stub harness 加载产物 + 真实启动浏览器（21 工具注册）
npm run test:integration # 真实浏览器集成（导航/点击/输入/截图/切分/快照）
npm run test:storage-state # storageState 损坏回退 + persistent 导入（真实浏览器）
```

## 编程接口 / 扩展点

插件暴露一个小的编程面，供宿主或第三方在不动工具注册表的情况下驱动浏览器或替换后端。

- **浏览器后端**：`BrowserSession` 以一个 `BrowserDriver`（默认 `PlaywrightDriver`）构造。该 seam 是**完整后端抽象**：它是唯一的 Playwright 边界，负责启动/关闭、页面收敛（`settleStable`），并把导航/点击/类型/截图/PDF/下载/cookie 等全部页面操作收敛为语义化方法（`goto`/`goBack`/`click`/`fill`/`evaluate`/`screenshot`/`pdf`/`requestGet`…）。`BrowserSession`/page-ops 只经它驱动浏览器，**不暴露裸 `page`/`context` 句柄**——因此可整体替换成非 Playwright 后端。`dsh-tui-browser-use/driver` 同时导出 `BrowserDriver` 契约与 `createPlaywrightDriver()` 默认实现，替换后端只需注入一个实现了该契约的自定义 driver。
- **视觉传输**：`createVisionAdapter(env, runtimeEnv)` 返回解析到的图像传输模式对应的 adapter（`file` → DeepSeek Files-API；`base64`/`url` → OpenAI 兼容内联）。可在 `dsh-tui-browser-use/vision` 替换。
- **工具注册**：`buildToolDefinitions(deps)` / `registerTools(ctx, deps)` 注册表接受注入的 session + 视觉 resolver，宿主可包裹或扩展。

子路径导出：`dsh-tui-browser-use/driver`（`BrowserDriver` 契约 + `createPlaywrightDriver()`）、`dsh-tui-browser-use/vision`（`createVisionAdapter`）、`dsh-tui-browser-use/types`。工具数与统一结果信封（`{ ok, value|error, usage? }`）属契约，不可改动。

## 已知限制

该项目是纯Vibe Coding产物：功能实现与完整回归在无头 Linux 验证，欢迎拷打。

## 文档

- 技能文档：`skills/browser-bridge/SKILL.md`

## License

[MIT](LICENSE)
