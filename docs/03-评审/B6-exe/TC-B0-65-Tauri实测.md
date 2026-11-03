# TC-B0-65：Tauri 窗口里的 Turnstile 实测（B6-exe 开工第一件事）

日期：2026-11-03　执行：前端 B　依据：B6-exe 任务单 A1、R1、D0～D1；架构 5.10、0.48；[B0 验证：Tauri 里 Turnstile](../../07-开发日志/B0-验证-Tauri里Turnstile.md)

## 结论：**行**

在真 Tauri 2 窗口（WebView2，来源 `http://tauri.localhost`）里，Turnstile 能加载、能出题、能通过，5.10 的 CSP 没有拦任何东西。用**预览站点**的真 sitekey（主机名列表里已有 `tauri.localhost`）也直接通过；**正式站点**的真 sitekey 报 `110200`（主机名不在允许列表里），这和预期一致——正式站点还没加 `tauri.localhost`。

按 TC-B0-65 的分法：**exe 照原计划在 `auth` 小窗口里登录（TC-B6X-01 生效，TC-B6X-02 的系统浏览器退路不用做）**。Q-O1 可以照任务单原样问负责人：“要在**正式** Turnstile 站点加 `tauri.localhost`，请本人在控制台加，同意吗？”

## 怎么测的

- 壳：仓库里 B0 留下的 `desktop/turnstile-probe/`，**一行没改**。窗口标签 `auth`、`withGlobalTauri: false`、`tauri.conf.json` 里是 5.10 的 CSP 原文，页面 meta CSP 把 `style-src` 收紧到 `'self'`。
- 编译：`cargo build --release --features tauri/custom-protocol`，即正式打包时的取页方式（页面打包进 exe，经自定义协议从 `http://tauri.localhost` 取）。编译产物放在临时目录，没进仓库。
- 工具链：rustc 1.99.1（stable-x86_64-pc-windows-msvc）、VS 2022 生成工具、WebView2 156.0.4314.58；tauri 2.12.5、tauri-build 2.7.4、wry 0.57.1、webview2-com 0.39.1（`Cargo.lock` 第一次生成，见下面“文件”）。
- 取证：启动时给 WebView2 加 `--remote-debugging-port`、`--remote-debugging-address=127.0.0.1`（只在本机），用脚本经 DevTools 协议读页面日志、换 sitekey、截图。没有操作桌面、没有点击任何验证。
- 截图在 [TC-B0-65-截图/](TC-B0-65-截图/)。页面日志里令牌只记长度和前 8 位。

## 结果

| # | sitekey | 预期 | 实际 | 截图 |
|---|---|---|---|---|
| 0 | — | 来源 `http://tauri.localhost`，`window.__TAURI__` 不存在 | `location.origin` = `http://tauri.localhost`；`window.__TAURI__` 不存在；UA 是 Edg/156 | 1 |
| 1 | 测试 `1x…AA`（总是通过） | 通过 | 脚本加载后 1 秒内通过，令牌长度 21、前 8 位 `XXXX.DUM` | 1-pass-1x-AA.png |
| 2 | 测试 `2x…AB`（总是失败） | 报错 | `error-callback` 收到 `600010`（测试 key 的固定失败码） | 2-fail-2x-AB.png |
| 3 | 测试 `3x…FF`（强制交互题） | 出交互题，人点了才过 | 小部件出现“请验证您是真人”复选框，等人点；**按安全规则 AI 不代点**，由负责人本人点（见下面“负责人”第 1 条） | 3-interactive-3x-FF.png |
| 4 | **预览站点真 sitekey** `0x4AAAAAAFpdC02AiF5T434s`（主机名含 `tauri.localhost`） | 不报 110200 | **通过**（Managed 模式这次没弹交互题），令牌长度 752、前 8 位 `1.4zo-VS`；令牌没有拿去用 | 4-real-preview.png |
| 5 | **正式站点真 sitekey** `0x4AAAAAAFpdI0aVBgMXQ40y`（主机名不含 `tauri.localhost`） | 报 110200 | 报 `110200` 两次，小部件显示“无法连接到网站” | 5-real-prod.png |

- 全程页面没有任何 `securitypolicyviolation`（日志里没有“CSP 违规”）。
- sitekey 是公开值（环境清单 Turnstile 一节）；secret 没有经手。

## 顺带发现（不影响结论）

1. **`window.__TAURI_INTERNALS__` 是存在的**（类型 object）。Tauri 2 不论 `withGlobalTauri` 怎么设都会注入它，IPC 靠它走；`__TAURI__` 确实不存在。第 9 节“主窗口没有 `window.__TAURI__`”这条照样成立，但别把“页面里够不到 Tauri”当成安全前提：能不能调命令要靠 capabilities（`auth` 窗口权限为空）和 CSP 管住，S-B6 审查时请安全审查员留意这一点。
2. **siteverify 那一步没在本机做**：测试 secret 配测试令牌的校验跟来源无关；真 secret 的校验在 Supabase Auth 一侧（5.10：函数里的 hostname 白名单不加），由 TC-B6X-01 在预览环境端到端验。

## 这次留下的东西

- 新文件：本文件、`TC-B0-65-截图/` 下 5 张 png、`desktop/turnstile-probe/src-tauri/Cargo.lock`（B0 验证文档要求第一次编译后提交，8.3 `--locked`）。
- 本机清理：探针窗口和 WebView2 子进程已全部结束；测试生成的 WebView2 数据目录 `%LOCALAPPDATA%\com.lemomemo.turnstile-probe` 已删除并核对不在。
- 没有改 `functions/_lib/cors.ts`，没有改探针源码。
