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

## 复核（11-03，同一审查员）：前端 B 改动

**结论：通过，没有剩余必改。** cargo test 48 过 1 忽略；stage-web 27 条；desktop-hotkey、native-bridge、safe-link 49 条全过。
- B-1：值锁与 async 排队锁分开，register/unregister 在锁外，回调 `try_lock()`，不再互等；失败注册回旧热键、存档不动。
- B-2：Rust `parse` 与前端 `hotkeyFromKeyboardEvent` 同一规则，单 Ctrl、单 Alt 一律 `hotkey_invalid`；只带 Win 仍可，系统占用的返回 `hotkey_in_use`。
- B-3：先核窗口、再 `external_url`、再独立 `OPEN_EXTERNAL_LIMIT`、再另起线程；写法不对的网址不占名额；结构核对钉住。
- 顶层导航只放 https，注释口径正确。
- B-M2：字节上复刻 infer 规则，`20 FE FF <?xml`、`FF FE 3C 00` 都拒，比 infer 更保守。
建议（不阻塞）：① `Ctrl+Shift+C/V/T/N` 仍可设，会抢别的程序常用键，可加小黑名单或在设置页提示——可用性问题，请负责人定（明早清单第 78 条）；② `hotkey_set` 在 async 命令里调阻塞的 `register`，以后可改 `spawn_blocking`。
前端 A 的 A-1 改完另送。

## 前端 A 复核（11-03，同一审查员）

**结论：有条件通过，剩 1 条必改。**
- 必改：`native-bridge.ts` 的 `sitePageUrl` 只拦 `//` 开头，URL 解析把 `\` 当 `/`、去掉制表符换行，`/\evil.com`、`/\t/evil.com` 都会拼成 `https://evil.com/`。现调用方只传常量，暂不可利用。改：拼后核 origin 与官网一致，路径限 `^/[A-Za-z0-9/_-]*$`，补三个反例。
- 已核过：A-1 标记只存 "1"、删成才撤、失败不重载、启动顺序正确，伪造标记最多让用户退出一次；readStoredAccessToken 读 sessionStore()；旧 sb-*-auth-token 键在装上后删除；热键设置页只在 exe 显示；SW“完成”只对待办、走 K-sw-seal 规则，“知道了”只关通知；clipText 过滤 C0、DEL、C1、双向控制符。
- 建议：① 登录小窗口不要写待删除标记；② clipText 再加 U+200E、U+200F、U+061C、U+2028、U+2029、U+FEFF，与后端 payload.ts 同步；③ hasDropMark 在 localStorage 不可用时返回 false，写进注释。
- 顺带发现：后端 push-dispatch 那批 17 条测试当前失败（正在改），已转后端。
- 跑过：相关 60 个文件 1107 条通过。只读。

**采纳（主持人，11-03）**：必改和建议 ①、③ 交前端 A；建议 ② 前端 A 与后端同步改。

## 前端 A 复核二（11-03，同一审查员）

**结论：通过，没有剩余必改。**
- sitePageUrl：路径正则 `^/[A-Za-z0-9/_-]*$`、不许 `//` 开头，拼后核 origin 一致；`\`、制表符、换行、`%`、`?`、`#`、`.`、空格第一道就拦，第二道兜底；数据接口非 https 返回 null；拼不出时 exe 里不打开也不跳走。
- 待删除标记折中可接受：只有主窗口 enableDropMark() 后的显式退出写标记，登录小窗口不写；supabase-js 自删失败记本页内存，goToAuth 显示“退出没完成”不重载。剩余漏洞：用户不重试直接关 exe，本机凭据里留一个服务器已吊销、最长约 1 小时的 access token，只在本人 Windows 账号下，风险低。
- clipText 与后端 payload.ts 同一套，保留 U+200D；hasDropMark 注释到位；ExitIncompleteScreen 给 #root 加 inert、只还原自己加的、焦点到按钮。
- 建议（不阻塞）：exe 里 signOut 成功后也调一次 clearLocalSessionIf(sid)，让这一路有跨重启兜底。
- 跑过：相关 10 个文件 142 条通过。只读。

**采纳（主持人，11-03）**：建议交前端 A。

## 复核三（11-03）：exe 退出兜底删除与 isLiveRow 替换

**结论：通过，没有必改。代码分 9 / 10。** 只读复核，同一审查员。

**exe 退出兜底删除（sign-out.ts、sign-out-sid.test.ts、session-store.ts 头注释）**
- sid 比对严格：兜底走 `clearLocalSessionIf(sid)`，本机会话的 session_id 和退出前记下的 sid 全等才删；别的账号、新登录的会话 session_id 不同，不删、不写标记。supabase-js 删成功时 Rust 回来后镜像置 null（desktop.ts `removeItem`），读不到 sid，什么都不做、localDone 为 true；删失败时镜像还在，兜底再删一次、开新的显式一轮、写标记，删成才撤。
- 竞态：兜底在 signOut 返回后、goToAuth 之前紧接着跑，exe 里登录小窗口这时还没开，退出途中写不进新会话；guardRemoval 只拦 supabase-js 的删键，不影响这次显式删除。理论窗口见建议 ⑤，风险低。
- localDone 如实：删除失败或抛错为 false（`.catch(() => false)`），不是那个会话为 true；标记写不进 localStorage 时 writeMark 吞掉，只少了跨重启那一层，不影响 localDone（删除本身的结果）。Rust 删不存在的凭据按成功（credman.rs `ERROR_NOT_FOUND` → Ok），sid 为 null 时多发 3 次空删，无害。
- inTauri：生产调用方（useAccountGate、useSessionGate、useSessionExit）都不传，默认 `isTauri()`（globalThis）；没有路径能把 exe 误判成网页版。
- session-store.ts 头注释与实际一致：标记只在主窗口 enableDropMark 后的显式删除写；第 ① 条“兜底删除开新一轮、刷新 lastRoundFailed”成立（兜底时 supabase-js 的删除已回来，pending 为 0，roundFailed 先清零）。小出入：“已经删掉了就什么都不做”在 sid 为 null 时不严格（会空删一次），可补半句。
- 测试拦得住回归：改回“只在 serverDone=false 时兜底”第二条测试失败；去掉 inTauri 判断第三条失败；删失败/抛错映射成 true 第一条失败。

**isLiveRow 替换（today-model.ts、todo-list.ts、两份 live-row.test.ts）**
- 语义完全相同：`(deleted_at ?? null) === null` 等价于“为 null 或 undefined（含没有这一列）”，`undone !== true` 不变；undefined、0、''、'0'、NaN、{}、[]、false 等 14 种取值两两组合，本功能 isLive、isLiveRow、原写法三者逐条相等（两份各 198 行输入）。
- 类型断言：Row 的列都是 unknown，isLiveRow 运行时只做 `??`、`===`，断言不掩盖现有错误；隐患是以后 isLiveRow 若按 deleted_at 的声明类型调方法，断言会把它藏起来（建议 ①）。todo-list 的 `live` 改名 `isLive` 后没有别的引用。

**必改**：无。

**建议（不阻塞）**
1. 把 isLiveRow 入参放宽成 `{ readonly deleted_at?: unknown; readonly undone?: unknown }`，今天页、待办页直接传 Row，去掉 `as Parameters<...>` 断言。
2. `localDone` 目前生产代码没人读（三个调用方都只看 serverDone，失败靠 goToAuth 看 session-store 状态）；注释写明“供测试和以后用”，或接到日志，免得以后误以为有人处理。
3. dropSession 改成返回 Promise 后，`useAccountGate.ts:159`、`useSessionExit.ts:118` 是悬空 Promise，建议加 `void`，eslint 开 `no-floating-promises`。
4. 补一条接真 session-store 后端的集成测试：exe、serverDone=true、本机已换成 s2 → 不删、不写标记；supabase-js 删失败 → 兜底删成、标记撤掉。
5. 理论竞态：登录小窗口若在主窗口退出的同时写入新会话、且 supabase-js 删键失败，主窗口镜像过期仍显示旧 sid，按键名删会删到新会话。现流程里退出时小窗口不会开，记下即可；另 `session_remove` 只许主窗口调，登录小窗口里的退出兜底删一律失败（原来 supabase-js 删键也一样，且小窗口不写标记），属已有情况。

**跑过**：`npx vitest run src/platform src/features/today src/features/todos` 49 个文件 566 条全过；`npx tsc -p tsconfig.app.json --noEmit`、`npx tsc -p tsconfig.shared.json --noEmit` 0 错；eslint 相关 9 个文件 0 问题。没跑 gen-tauri-key，没连 Supabase、Docker。

### 复核三采纳情况（主持人，11-03）

- 建议 2（localDone 注释）、建议 3（两处悬空 Promise 加 void，no-floating-promises 先只统计不开）和头注释“sid 为 null”一处的出入，已转前端 A。
- 建议 1（isLiveRow 入参放宽成 unknown、去掉断言）：cal-items.ts 归前端 B，等前端 B 下一轮一起改，暂记在这里。
- 建议 4（接真 session-store 后端的集成测试）：留到 exe 实测那一轮（11-04 21:20 以后）由前端 B 补。
- 建议 5 的两件事照原文记录：登录小窗口与主窗口退出同时发生、且 supabase-js 删失败时，理论上可能删到新会话，现流程碰不到；session_remove 只许主窗口调，小窗口里的退出兜底删除一律失败，这是原来就有的情况，小窗口也不写标记。
