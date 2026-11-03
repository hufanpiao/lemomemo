# B6-exe 代码审查：前端 B（F5-5、F5-6、R1、R2、R-297）与前端 A（F5-2/N1 接线、FA2-3、外链、S9、sync-transport 拆分、invalidate）

日期：2026-11-03　审查：代码审查员　记录：主持人照审查员回报落盘（审查员只读，没有写文件）

## 一、前端 B：有条件签，7.5 / 10

### 必改
| # | 问题 | 位置 | 改法 |
|---|---|---|---|
| B-M1（高严重、低概率） | 热键回调和 `hotkey_set` 互相卡死：`hotkey_set` 拿着 `QuickAddHotkey` 的 std Mutex 调 `gs.unregister/register`；插件 2.4.1 用 `run_main_thread!` 后 `rx.recv()` 阻塞等主线程；Windows 上热键事件在主线程消息循环里回调，`is_current()` 要同一把锁 → 改热键时按到旧热键，整个程序卡死 | `desktop/src-tauri/src/lib.rs` | 回调不阻塞（`try_lock` 或另存一份用 RwLock/原子量短读）；`hotkey_set` 用自己的锁串行，注册期间不拿回调的锁；结构测试钉住“回调里不调 `.lock()`” |
| B-M2（中） | F5-6 可绕过：Tauri 对 .js/.css 先按内容嗅探，infer 0.22.0 判 XML 先去空白、再去 BOM（含 `FE FF`、`FF FE`）；`checkTextAsset` 用非严格 UTF-8 解码，`FE FF` 成了 U+FFFD 去不掉。实测 `0x20 FE FF "<?xml …"` 的 .js 被放行，infer 判 text/xml，XHTML 命名空间的 `<script>` 会执行且无 CSP | `desktop/src-tauri/scripts/stage-web.mjs` 的 `checkTextAsset` | 在字节上复刻 infer：循环去 `09 0A 0C 0D 20`、`EF BB BF`、`FE FF`、`FF FE`，下一字节 `0x3C` 就拒；或要求严格 UTF-8、不带 BOM。补 `[0x20,0xFE,0xFF]+'<?xml'`、`[0xFF,0xFE]+'<?xml'` 两例 |

### 建议
1. R1 正则漏 esm.sh 的 `/es2022/cors.mjs`、`/denonext/`，和 `dist/cors.min.mjs`；放宽成 `(?:[^?#]*/)?` 和 `cors(?:\.[\w.]+)?`。
2. `policy.rs` RateLimit 注释“两条路径共用一个”过时。
3. `policy.rs` 测试里字符串直接写换行，改 `"\n}\n"`。
4. `hotkey_set` 存档失败时热键已换却返回 Err，改 Ok 带 `saved:false` 或写明。
5. 设置页录到的热键和现在一样、且 `registered:false` 时也应调 `hotkey_set`，让用户能原样重试。
6. Ctrl+Alt+字母在 AltGr 布局下会吃字符，设置页可加提示。

### 核对通过
policy 两条路径都先过 `external_url` 全套检查、协议按路径限、都不放 http；导航只有 main 才转交，新窗口一律 Deny；限速器按路径分、单调时钟；ComGuard 同线程配对。open_external 符合 R-301。session.rs R2 先探后删、从高往低、失败即停，有注入测试。热键默认 Ctrl+Shift+Space、规整、回落默认、拒只有 Shift；被占时注册回旧的；capability、COMMANDS、manifest_check、toml 四处一致只给 main；前端写法和 Rust 规整一致。

### 跑过
`cargo test --locked` 正式、预览各 45 过 1 忽略；`cargo build` 0 警告；stage-web 26/26；desktop-hotkey、check-backend-f11（4/4）通过；check_backend 0 错误；手工复现 B-M2。

## 二、前端 A：有条件签，7 / 10

### 必改
| # | 问题 | 位置 | 改法 |
|---|---|---|---|
| A-M1 | exe 里删会话失败时 `goToAuth` 照样整页重载，可能无限重载；自己退出也看起来没生效。`clearLocalSessionIf` 改成返回 `Promise<boolean>` 但没有调用方使用：sign-out.ts 的 ExitSteps、account-exit.ts、consent-exit.ts、sync-wiring.ts、settings-api.ts 类型仍是 `void`，goToAuth 里 `void clearLocalSessionIf(...)` | `src/platform/session.ts` 的 `goToAuth` 及上述调用方 | exe 分支拿删除结果，失败不重载，提示重试或开登录小窗口且不让会话再启动；sign-out、removed 两条路径把返回值往上传；补测试“Rust 删失败 → 不调 reloadPage”（与安全审查 A-1 同一件事） |

### 建议
1. `DeviceRegistrar.invalidate` 竞态：`await inflight` 后、拿锁前 `mem` 仍是旧 id，并发 `ensure()` 可能同步返回旧 id；id 对不上也清 `failedAt` 绕过 60 秒节流。开头同步清 `mem`，把 invalidate+重新登记放进 `inflight`；`failedAt` 只在 id 对上时清；补并发测试。
2. `native-bridge.ts` 的 openExternal JSDoc 错放在 `sitePageUrl` 上方。
3. `sync-transport.ts` 引 `../push-claim.ts` 的 `claimParams`，把 push.ts 拉进同步层依赖图，挪位置。
4. `installDesktopSession` 失败时用户卡在“登录成功主窗口不变”，记错误码日志或提示。
5. `session.ts` 497 行，可拆。

### 核对通过
session-store 网页版用 localStorage、exe 用镜像、删除中键读不到、删失败恢复可读、没装上用 EMPTY/MEMORY_STORE 不退回 localStorage、后端对象不挂 window、删键前问 `removalAllowed`、desktop.ts 按键排队；client.ts 用 `authBackendStorage() ?? authStorage()`；两个入口先 await install；`markAccountUiShown` 区分两种情况；外链 http(s) 才带 `_blank`，exe 点击交 open_external 并 preventDefault；sync-errors 原样搬移；push-claim 只补登记一次。

### 跑过
vitest 14 个文件 190 条全过；tsc app、node 0 错误；eslint 18 个文件 0 报错。没跑 gen-tauri-key。

## 采纳情况（主持人，11-03）
- B-M1、B-M2 交前端 B 必改；建议 1～4 一起改；建议 5 交前端 A（设置页归他）；建议 6 在设置页提示里一并处理。
- A-M1 交前端 A 必改（与安全审查 A-1 合并）；建议 1～4 一起改，建议 5 能做就做。
- 改完由本审查员只看改动、复核签字。

## 复核（11-03，同一审查员）：前端 B 改动

**结论：签，9 / 10，没有剩余必改。**
- B-M1：值锁 + async 排队锁；`hotkey_set` 锁外注册；回调 `is_current` 只用 `try_lock()`；两条结构测试确实钉住（回调里无 `.lock()`、hotkey_set 顺序与启动顺序）。代价：回调撞上 `hotkey_get` 短暂拿锁时这次按键算没按，可接受。
- B-M2：字节上循环去空白和三种 BOM，首字节 `<` 即拒，比 infer 0.22 更严；实测 `20 FE FF <?xml`、`FF FE <?xml`、`EF BB BF 0A <` 都拒，`a<b` 放行。
- open_external 先校验、再独立限速、再另起线程，结构测试钉住；导航只 https；单 Ctrl/单 Alt 规则两边一致；R1 正则放宽后不误报；save_failed 文档已写明。
建议：① lib.rs 约 313 行、364～365 行过时注释；② policy.rs 约 444～446 行字符串仍直接写换行；③ Win+Space 是输入法系统热键，可在 parse 里拒掉。
跑过：cargo test 两套各 48 过 1 忽略；stage-web 27/27；相关 vitest 27/27；check_backend 0 错误。
**采纳（主持人，11-03）**：三条建议交前端 B 一起改。

## 前端 A 复审（11-03，同一审查员，只看改动）

**结论：签，8.5 / 10，没有剩余必改。**
- A-M1 已解决：exe 里 goToAuth 等删除结果（最多 3 秒），只有 ok 才重载，失败或超时显示“退出没完成”；晚到的成功自动重载；重试删成才撤标记；启动先 installDesktopSession、再 settleDropAtStartup、再读会话；标记值只是 "1"；返回值改 Promise<boolean>，无循环依赖。
- 建议 1～5 通过：invalidate 竞态、JSDoc、claim-params.ts、installDesktopSession 失败记原因码并挂整屏、session.ts 部分拆分理由成立。ConsentPage 在 exe 里拼官网 https 地址走 open_external。
- 建议（不阻塞）：① 待删除标记会被 supabase-js 内部删除带出来，登录小窗口删失败后主窗口会删掉新会话——只让显式退出写标记；② 整屏提示给 #root 加 inert 并移焦点；③ localDone 注释写明只代表兜底删除；④ exit.test.tsx 301 行。
- 跑过：相关 vitest 1189 条全过；tsc app 0 错误；eslint 0 错误 1 警告。

**采纳（主持人，11-03）**：建议 ①～④ 交前端 A。

## 前端 A 第三轮复审（11-03，同一审查员）

**结论：签，9 / 10，没有剩余必改。**
- ① 待删除标记折中合理：只有 `markEnabled && collecting !== null`（主窗口 enableDropMark 后的显式退出）才写标记，登录小窗口不写，补了对应测试；显式删除单独记 dropping、dropFailed，全部成功才撤标记；supabase-js 自删只计本页内存 roundFailed、lastRoundFailed。“服务器退成了也兜底删”要改 9 条既有测试，收益不大，不采纳可以接受。
- 小缺口（不阻塞）：supabase-js 删键失败后若 goToAuth 没发新的显式删除，lastRoundFailed 停在旧值，可能误显示“退出没完成”，点重试即自愈；进程关掉后靠下次启动刷新失败走“被移除”兜底。建议在 session-store.ts 文件头注释写明。
- ② inert 只还原自己加的、焦点到按钮；③ localDone 注释；④ exit.test.tsx 300 行内。
- 跑过：src/platform、src/app、src/features/settings 95 个文件 1022 条全过；eslint 0；tsc app 0。

**采纳（主持人，11-03）**：注释建议交前端 A。
