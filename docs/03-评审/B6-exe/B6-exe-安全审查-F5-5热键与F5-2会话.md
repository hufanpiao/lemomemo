# B6-exe 安全审查：前端 B（壳子、热键、F5-5/F5-6、F11）与前端 A（F5-2 会话存储）

日期：2026-11-03　审查：安全审查员　记录：主持人照审查员回报落盘（审查员只读，没有写文件）

## 结论
- 前端 B：**有条件通过**，3 条必改。
- 前端 A：**有条件通过**，1 条必改。

## 一、前端 B

### 必改
| # | 问题 | 改法 |
|---|---|---|
| B-1（高） | `hotkey_set` 死锁：拿着 std Mutex 调插件 register/unregister（`run_on_main_thread` + `rx.recv()` 阻塞），主线程 `WM_HOTKEY` 回调里 `is_current()` 要同一把锁，整个 App 永久卡死（读插件 2.4.1 `src/lib.rs` 113–120 行推出，未真机复现） | 锁里只读旧值、放锁后注册、再拿锁写回，并发 `hotkey_set` 另用 async Mutex 串行；或回调改 `try_lock()`；补测试或结构核对（与代码审查 B-M1 同一件事） |
| B-2（中） | 热键能设成 Ctrl+C/V/X/Z/A/S/W、Ctrl+F4、Alt+F4 等系统常用键，`RegisterHotKey` 成功即从全系统抢走并写进存档；误按或注入脚本调 `hotkey_set('Ctrl+V')` 可长期让粘贴失灵 | 规则：Ctrl 或 Alt 单独作修饰键时必须再带 Shift、Win 或另一个修饰键；前端 `hotkeyFromKeyboardEvent` 同规则 |
| B-3（中） | `open_external` 没有限速，也没有“用户点过”的检查，main 页任何脚本都能无限次拉起邮件、电话程序 | 加 `OPEN_EXTERNAL_LIMIT`（1 秒 1 次，超出 `Err("rate_limited")`），另起线程 `shell_open`，`policy.rs` 结构核对钉住 |

### “顶层导航也只放 https”：推荐采用
- 没有功能代价：生产代码里用 mailto、tel 的只有 `LocationText`，exe 里 `openExternal` 一律 preventDefault，不靠导航。
- 会拉起别的程序的协议只剩 `open_external` 一个入口，审查和限速都只盯一处。
- 在 R-301 范围内（R-301 只写了“顶层导航不放 http”）。
- **理由修正**：“只有 open_external 能保证用户亲手点过”不成立。它是普通 IPC 命令，Rust 看不到网页的用户激活状态。收窄导航的作用是“只留一个入口”。能利用的前提是 main 页已能跑脚本，届时对方本可调 `session_get`，拉起邮件程序只是附带骚扰，评为中低，补 B-3 后可接受。
- 建议：`openExternal` 里加 `navigator.userActivation?.isActive` 检查（防自己代码误调）；原生级保证可用 WebView2 `NavigationStarting` 的 `IsUserInitiated`，留到 4.x。

### 核对通过
热键命令只给 main，capability、manifest_check、toml 一致；热键写法校验（白名单键名、长度上限、去重、至少一个非 Shift 修饰键、规整、存档坏了回落默认）；F5-5 新窗口只 https、导航 https/mailto/tel、都不放 http、限速分开、COM 初始化正确；session.rs 从高往低删、失败即停；stage-web（F5-6）后缀白名单、文件头核对、.js/.css 开头不许 `<`、SVG 白名单；check_backend F11 不分大小写、识别 CORS 库和 import map；`cors.ts` 新放行的 `x-retry-count`、`Retry-After` 不敏感；`desktop-hotkey.ts` 不挂全局。

### 建议
`ConsentPage.tsx` 相对链接加 `target=_blank`，exe 里解析成 `http://tauri.localhost/...` 被新窗口路径拒，点了没反应（功能问题），exe 里改官网完整 https 地址走 `openExternal`。

## 二、前端 A（F5-2）

### 必改
| # | 问题 | 改法 |
|---|---|---|
| A-1（中） | exe 里删凭据管理器失败没人接：`ExitSteps.clearLocalSessionIf` 仍是 `void`，`goToAuth` 不管成败都重载，带着会话又登录回去。自己点退出时（服务器那步没完成）用户以为在公用电脑上退出了；被移除时可能一直循环重载 | exe 里 `goToAuth` 等删除结果，失败不重载回已登录界面，提示“退出没完成，点重试”；localStorage 记只含标记的“待删除”，下次启动先删会话、不渲染账号界面；`clearLocalSessionIf` 返回 `Promise<boolean>` 接进退出结果；补“removeItem 失败”测试 |

### 逐点核对通过
exe 里会话 token 不落 localStorage；凭据管理器失败时关着失败；后端对象只在模块作用域；删除中标记逻辑正确；退出最多等 3 秒再重载可接受；外链拦截不退回页面跳转，中键或 Ctrl+点击走新窗口只放 https。

### 建议
- `local-exit.ts` 的 `readStoredAccessToken` 直接读 localStorage，exe 里永远 null，“退出并换账号”找不到设备行，改用 `sessionStore()`。
- `installDesktopSession` 成功后一次性删掉 localStorage 里 `^sb-.+-auth-token` 的旧键。
- push-claim、device-reg invalidate 可以通过。

## 跑过
`cargo test --offline` 45 过 1 忽略；stage-web 26 条；vitest 10 个文件 132 条全过。没跑 gen-tauri-key，没下载安装。

## 采纳情况（主持人，11-03）
- B-1～B-3 交前端 B 必改；“顶层导航只放 https”采纳，注释按修正后的理由写。B-2 规则按审查推荐定，在明早清单知会负责人。
- A-1 交前端 A 必改，两条建议一起做；ConsentPage 交前端 A。
- 改完由本审查员只看改动、复核。
