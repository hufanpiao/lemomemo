# B6-exe 安全审查：F5（CORS）与复核 N1～N3、X-5、X-S7～X-S9

- 审查日期：2026-11-03
- 审查人：安全审查员（只读，没有改任何仓库文件）
- 被审对象：前端 B 这一批工作区改动（都没 git add，以 `git diff`、`git status` 为准）：
  `functions/_lib/cors.ts`、`tests/functions/cors-exe-426.test.ts`、`tests/functions/cors-supabase-js-headers.test.ts`、
  `build/check_backend.py`（F11）及 `tests/arch-fixtures/check_backend/f11-edge-cors*/`、`src/platform/http.ts`、`src/platform/desktop.ts`、
  `desktop/src-tauri/`（`session.rs`、`lib.rs`、`policy.rs`、`env.rs`、`Cargo.toml`、`scripts/stage-web.mjs`、`scripts/ci-guard.mjs`）
- 参考：`docs/03-评审/B6-exe/` 下以前的安全审查（外壳审查 X-1～X-6、X-S1～X-S9，desktop 与 release-build 工作流审查）、代码审查 F1 至 F4F8 的 N1～N3、
  `docs/10-架构/架构设计-v4.md` 5.10 节和 0.54、`docs/08-发布/环境清单-v4.md`

## 结论：有条件签

CORS 改动（F5 ①②④⑤）本身没有问题，可以签：新增的 `x-retry-count` 确有必要、不扩大攻击面；白名单仍只有 `http://tauri.localhost`、精确比对；
本地生成的 426、404、502 等都经 `applyCors`，非白名单来源拿不到任何 `Access-Control-*`。Rust 一侧（session.rs 收窄、RateLimit 改 Instant、
ComGuard、预览更新地址）也没有问题，两套 feature 的 `cargo test` 都通过。

但有四条必改：

- **F5-1**：exe 会话存储接上 supabase-js 以后，退出登录会抛 `key_not_allowed`，删不全，`SIGNED_OUT` 事件也不发（已用假 invoke 复现）。
- **F5-2**：N1 只交付了存储接口，还没接进客户端，退出兜底仍只清 localStorage。
- **F5-3**：stage-web 的 svg 检查能被轻易绕过。另外 Tauri 对不认识的后缀一律按 `text/html` 返回、不带 CSP，按后缀拉黑名单的办法本身就不完整。
- **F5-4**：F11 跳过了 `supabase/functions/` 下的 `tests/`、`__tests__/`、`dist/` 目录，和 BE1-S3 的结论相反。

签字条件：

- F5-1、F5-3、F5-4 在这批改动提交前改好；
- F5-2 在 A8 验收（TC-B6X-09、15）前、并且第一次在 CI 打 exe 之前做完。

## 一、必改项

| 编号 | 问题 | 证据 | 改法 | 时限 |
|---|---|---|---|---|
| **F5-1** | **退出登录删不全，而且 signOut 直接抛错**。`desktopSessionStorage.removeItem` 把 Rust 的错误照样抛给 auth-js。auth-js 2.x 的 `_removeSession()` 依次做三件事：删 `storageKey`；`removeAllPKCEVerifiers`（删 `<key>-flows-code-verifier`、`<key>-code-verifier`）；删 `<key>-user`。第二步的键不在 Rust 白名单里，`session_remove` 回 `key_not_allowed`，于是 `_removeSession` 在第二步中断：<br>① `-user` 那条留在凭据管理器里；<br>② 后面的 `_notifyAllSubscribers('SIGNED_OUT')` 不执行，订阅退出事件的逻辑（断 Realtime、清界面状态）都不触发；<br>③ `signOut({scope:'local'})` 不是返回 `{error}`，而是直接 reject。 | 草稿脚本 `C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\sec-feb-f5\signout-probe.mts`：抽出 `desktopSessionStorage` 原样代码，用假 invoke 模拟 Rust 白名单（只认 `sb-lemomemo-auth-token`、`-user`），接到真的 supabase-js 上执行 `signOut({scope:'local'})`。结果：`signOut 返回: {"thrown":"key_not_allowed"}`，`凭据里剩下: ['sb-lemomemo-auth-token-user']`，事件只有 `SIGNED_IN`、`INITIAL_SESSION`。`getItem` 对白名单外的键已按 null 处理，所以只有删除会出问题 | `removeItem` 对白名单外的键当成功（不调 Rust，或者调了也吞掉 `key_not_allowed`）。白名单从 `buildInfo` 或 env 派生，和 env.rs 的 `session_keys` 一致，做法照 `desktop_scan.mjs` 直接读 env.rs，或者加单测钉住两边相等。<br>`setItem` 对白名单外的键照旧抛错：现在是 `flowType: 'implicit'`，不会写 PKCE 键；以后改成 pkce，必须先改白名单。<br>加一条用真 supabase-js 的单测：`signOut` 不抛错、两个键都删掉、收到 `SIGNED_OUT`。也可以照抄上面的草稿脚本 | 本批提交前 |
| **F5-2** | **N1 还没接进客户端（代码审查 N1 的后半段）**。`createDesktopSessionStorage`、`onAuthDone` 都没有调用方。`src/platform/supabase/client.ts` 的 `clientOptions()` 仍用 `authStorage()`（localStorage）。`session.ts` 的 `readSessionId`、`readSessionUserId`、`clearLocalSessionIf` 仍然同步读写 localStorage。<br>这样一来：<br>① exe 里会话现在仍然落在 WebView2 的 localStorage（违反 F4、14.2 第 2 点）；<br>② 退出第 ④ 步的兜底 `clearLocalSessionIf` 在 exe 里清不到凭据管理器；<br>③ auth 小窗口和 main 同源（`http://tauri.localhost`），共用同一份 localStorage。auth 页的 supabase-js 如果不换存储，令牌会先写进共享的 localStorage，“auth 小窗口只写不读”的隔离就形同虚设 | `grep createDesktopSessionStorage\|onAuthDone src`：只在 desktop.ts 自己出现。`client.ts:37` | 接线时同时做到四点：<br>① main、auth 两个窗口在 exe 里都用 `createDesktopSessionStorage()`，启动时先 `preload(session_keys)` 再建客户端；<br>② `readSessionId` / `readSessionUserId` 在 exe 里改读 `peek`；<br>③ `clearLocalSessionIf` 在 exe 里改成对两个白名单键调 `session_remove`，失败要能让调用方知道；<br>④ 加一条架构检查或单测：exe 打包产物里 supabase 客户端不落 localStorage（比如在 `isTauri()` 分支断言 storage 不是 `authStorage()`）。<br>接线的存储对象只放在模块作用域，不挂到 `window` / `globalThis` 上（见第三节“会话存储”） | A8 验收前；并且在第一次 CI 打 exe 前 |
| **F5-3** | **stage-web 的 svg 检查能绕过，后缀黑名单本身也不完整（X-S7 没有真正落地）**。<br>① `checkSvg` 只用正则匹配原文，下列写法全部放行：<br>  • 带命名空间前缀的 `<s:script>`、`<h:script xmlns:h="http://www.w3.org/1999/xhtml">`；<br>  • 带前缀的 `<s:foreignObject>`、`<h:iframe>`；<br>  • 字符引用 `javascript&#58;`、`&#106;avascript:`、`java&#9;script:`；<br>  • SMIL 写法 `<set attributeName="href" to="&#106;avascript:…">`；<br>  • 外部 DOCTYPE；<br>  • 带 BOM 的 UTF-16LE 文件（按 utf8 读进来，每个字符中间夹 NUL）。<br>大写 `<SCRIPT>`、CDATA、换行后的 `onload=` 能拦住。<br>② Tauri 2.12.5 的资源协议只给路径以 `.html` 结尾的文件注入 CSP（`tauri-2.12.5/src/manager/mod.rs` 的 `is_html`），MIME 由 `tauri-utils-2.10.2/src/mime_type.rs` 按后缀判断：**不认识的后缀一律回落成 `text/html`**（`Some(_) => fallback`，fallback = Html）。所以 `.htm`、`.xhtml` 只是冰山一角，任何新后缀（现在产物里就有 `manifest.webmanifest`）都会被当成没有 CSP 的 HTML 页面。<br>③ main 页的 meta CSP 是 `frame-src 'self' …`，同源 iframe 能加载这类文件，加载后又能拿到父窗口的 `__TAURI_INTERNALS__`。<br>顶层导航有 `navigation_allowed` 的精确路径名单挡着，要利用还得先有一处注入，所以风险是“纵深防线失效”，不是现成的漏洞；但 X-S7 要的正是这道防线 | 草稿脚本 `C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\sec-feb-f5\svg-probe.mjs`：13 种写法放过 9 种（输出见第四节）。产物后缀统计：css 9、html 3、ico 1、js 26、json 1、png 26、svg 3、webmanifest 1、woff2 2 | ① 后缀改成**白名单**：只许 `.js .css .png .ico .svg .woff2 .json .webmanifest` 和 PAGES 里的 `.html`。名单外的一律失败，不再列黑名单。<br>`.webmanifest` 会被 Tauri 当成 HTML，要另外断言它能被 `JSON.parse` 解析，并且不含 `<`。<br>② `checkSvg` 先校验编码：不许 BOM、不许 NUL、必须是合法 UTF-8。再拒绝下列内容：<br>  • `<!DOCTYPE`；<br>  • 任何 `&#` 字符引用，以及 5 个预定义实体以外的实体；<br>  • 任何带前缀的元素名（`<\w+:`）；<br>  • `xmlns` / `xmlns:*` 的值不是 SVG、xlink 命名空间的；<br>  • `href` / `xlink:href` / `to` / `values` 的值不是 `#…` 或相对路径的。<br>也可以换成真 XML 解析加元素、属性白名单。<br>③ 上面 13 种写法全部进 `stage-web.test.mjs` | 本批提交前 |
| **F5-4** | **F11 跳过了函数目录里的 `tests/`、`__tests__/`、`dist/` 等目录**。`check_edge_cors` 用 `_is_test_source(rel)`，又用 `DOCKER_HOST_SKIP_DIRS` 过滤 `supabase/functions/` 下的目录，于是 `supabase/functions/_shared/tests/h.ts`、`supabase/functions/_shared/dist/h.ts` 里写的 `Access-Control-Allow-Origin` 不报；被 `index.ts` import 以后会进部署产物。F10 已经按 BE1-S3 改成“函数目录下只按文件名认测试”，F11 没跟上，F11 头注释写的“tests/ 目录不算”也和 BE1-S3 相反 | 草稿样例 `C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\sec-feb-f5\f11\`：`hello/index.ts` import 上面两个文件并用它们的常量设头。`python -I build/check_backend.py --root <该目录>` 只报 1 条 F7（`\u` 转义），F11 一条都没报 | 函数目录里只按文件名认测试源码（照 `_docker_host_skip_file`），目录一律照扫，只排除 `node_modules`。给 `f11-edge-cors` 样例加一个 `_shared/tests/` 下的违规文件，同步改 `tests/build/check-backend-f11-cors.test.ts` 的期望。头注释改正 | 本批提交前 |

## 二、建议（不卡签字）

1. **F11 静态检查拦不住拼接写法**：`'Access-Control-' + 'Allow-Origin'`、模板串、`['access','control','allow','origin'].join('-')` 都能绕过（`\u` 转义有 F7 兜着）。转发层的 `applyCors` 会先删掉上游所有 `Access-Control-*`，经 `/sb` 到不了客户端，所以只是纵深防线。可以把匹配放宽到 `allow-origin`（不分大小写），能多拦一种拼接；另外在 `tests/edge/` 给每个函数的响应加一条断言：没有任何 `access-control-*` 头，用运行结果兜底。
2. **ci-guard 的扫描范围（X-S8）**：现在扫 workflows、`.github/actions/**` 和根目录 `package.json` 的 scripts。还可以补：
   - 仓库里除 node_modules 以外的所有 `package.json`（现在有 `tools/deploy/package.json`）；
   - `desktop/src-tauri/tauri*.json` 的 `build.beforeBuildCommand` / `beforeBundleCommand`；
   - `build/ci/*.mjs`。

   另一道防线是 stage-web 在 CI 环境里拒绝跳过参数，但它靠的是环境变量 `CI` / `GITHUB_ACTIONS`，工作流某一步写 `env: { CI: '', GITHUB_ACTIONS: '' }` 就能把它关掉。建议 ci-guard 同时拦“工作流里把 `CI`、`GITHUB_ACTIONS` 设成空或 false”。参数拼接（`--skip-env-${x}`）静态查不出，靠代码审查。
3. **预览更新地址两处写死**：env.rs 写死 `lemomemo-preview`，desktop.yml 生成 `latest.json` 用的是仓库变量 `PREVIEW_PAGES_PROJECT`。两边不一致时，exe 去的地址和上传的地址对不上（安装包有 updater 签名兜底，不会装错包，只会更新失败）。建议 desktop.yml 在“整理产物”一步用 `parseEnvRs` 读出预览 `update_url` 的主机，和 `desktop.${PREVIEW_PAGES_PROJECT}.pages.dev` 比对，不一致就失败。
4. **session.rs 的孤段**：收窄以后，“删旧代号段”的循环里如果中间某一段删除失败（比如 a3），后面的段照样删掉，a3 就成了不连续的孤段，后面的 `trim` 探到第一个不存在的段就停，清不到它，要等下次轮到同一代号、段数够多时被覆盖，或者退出登录时 `remove` 全删。孤段拼不回会话：读取先校验头部记的代号、段数，再校验总字节数、SHA-256 和 UTF-8，全部对上才用，头部又只在新段全部写好以后才写。所以只是“旧令牌碎片在本人凭据里多留一阵”，可以接受。想更干净的话，可以在 `trim` 之外，对旧头部记的段数里删失败的序号记一笔，下次写入时补删。
5. **auth 小窗口的第三方脚本**：auth 页的 `script-src` 放行了 `https://challenges.cloudflare.com`（Turnstile），这个脚本和页面同在一个 JS 环境里，能直接调 `session_set`、`auth_done`、`auth_open_signup`（写一份任意会话然后通知 main）。这是外壳审查时已知、已接受的取舍（auth 本来就要写会话），这里记一笔：以后 auth 页不得再加其他第三方脚本来源。
6. **peek 镜像**：`mirror` 在 `desktopSessionStorage` 的闭包里，本身不挂到 `window`；页面里的其他脚本本来就能直接 invoke `session_get`，所以 peek 没有扩大暴露面。接线时（F5-2）不要把存储对象放到 `window` 或 `globalThis` 上，可以在 F5-2 的单测里一起断言。
7. **`getItem` 吞掉所有错误**：凭据管理器偶尔读失败时当成“没登录”，界面会走登录提示，安全上是保守的。真机验收时留意一下是否会误把用户弹回登录页。
8. **`NetworkUnreadableError`**：只在 `cause` 里保留原错误，不带响应体，不会让错误页内容进日志，可以。

## 三、逐项核对

### CORS（`functions/_lib/cors.ts`）

| 核对项 | 结果 |
|---|---|
| `x-retry-count` 是否必要 | ✓。postgrest-js（node_modules 里的 `@supabase/postgrest-js/dist/index.cjs` 第 194、203 行）对 GET / HEAD 遇到 fetch 失败或 503、520 时重试，重试请求带 `X-Retry-Count`；不放行的话 exe 的重试卡在预检。`cors-supabase-js-headers.test.ts` 用 503 + `Retry-After: 0` 把重试请求抓出来钉住 |
| 是否扩大攻击面 | ✓ 没有。只对 exe 来源的预检放行；值是重试序号，转发到 Supabase 后对方不据此做鉴权或路由。`Retry-After` 暴露给 exe，只是等待秒数 |
| 删 `x-upsert`、`cache-control` | ✓。src、shared 里已没有使用（grep 无结果）；`/files` 走自己的上传；426 测试另外断言两个名单里都没有 |
| 白名单只有 `http://tauri.localhost`，精确比对 | ✓。`isAllowedOrigin` 用 `===`；`applyCors` 先删上游全部 `access-control-*`，再只在白名单命中时写；不带 `Allow-Credentials`；`Vary: Origin` 总是加 |
| 本地生成的响应带 CORS 头会不会泄露给非白名单来源 | ✓ 不会。`/sb` 的 405、404、500、502（`localJson`）和 426（`upgradeRequiredResponse(…, applyCors)`），`/files` 的 426，全都经 `applyCors`，非白名单来源一个 `Access-Control-*` 都没有，浏览器读不到响应体。`cors-exe-426.test.ts` 正反两向都测了。426 的响应体只有 `{code, min}`，本来就不敏感 |
| Edge Functions 不加 CORS | 现状 ✓：`check_backend` 0 个错误，仓库里的函数没有加。F11 的覆盖面见 F5-4、建议 1 |
| 测试 | `npx vitest run`（cors-exe-426、cors-supabase-js-headers、check-backend-f11-cors、desktop-session、desktop、http）：6 个文件 55 条全过 |

### 会话存储（N1：`src/platform/desktop.ts` + Rust）

| 核对项 | 结果 |
|---|---|
| 凭据名是否限制在固定前缀 | ✓。Rust 端 `check_key` 按 env.rs 的 `session_keys` 精确比对（正式 `sb-lemomemo-auth-token`、`-user`；预览 `sb-preview-…`），凭据名只由 `lemomemo.session.` + 白名单键 + 固定的 `~a0..b31` 段后缀拼成，页面传不进任意名字 |
| auth 小窗口能不能读会话 | ✓ 读不了（两道）。`capabilities/auth.json` 只给 `allow-session-set`、`allow-auth-done`、`allow-auth-open-signup`；`session_get`、`session_remove` 在命令里还要 `require(&[Win::Main])`。注意：如果 auth 页不换存储，会通过共享的 localStorage 绕开这层隔离（F5-2 ③） |
| peek 内存副本是否经 window 暴露 | ✓ 不暴露（闭包变量），见建议 6 |
| 退出登录能否全删 | ✗。见 F5-1（signOut 抛错、`-user` 留下）和 F5-2（兜底只清 localStorage）。Rust 端 `remove` 先删头部、再删两套 0..31 段和旧格式段，本身是全删的 |
| onAuthDone | ✓。收到 `auth:done` 后先重读 `preloaded` 里的键，再调回调；重读失败也调回调；事件只由 Rust 在 `auth_done`（只许 auth 窗口调）里发给 main |
| 同一个键的读写排队 | ✓。`queue` 按键串行，慢回来的旧读不会覆盖镜像 |
| X-5 `closeAllLocalReminders` 防竞态 | ✓。epoch 在等权限之后比对；权限已经给过时 `showLocalReminder` 中间没有 await，会在 `closeAll` 之前同步做完，不会漏关 |

### session.rs（N3 收窄）

| 核对项 | 结果 |
|---|---|
| 收窄后会不会留下能拼回旧会话的段 | ✓ 不会。头部只在新一套段全部写好后才写；读取按头部取齐 n 段，先核总字节数、SHA-256，再核 UTF-8，任何一项不对返回 None。残留的段没有对得上的头部，用不上（孤段见建议 4） |
| 头部校验是否先于使用 | ✓。`Header::parse` 先查 tag、代号只能是 a/b、`1 ≤ n ≤ 32`、`len ≤ CHUNK·n`、sha 是 64 位；`get` 在返回之前完成长度和 SHA 比对 |
| 头部损坏时 | ✓。`header()` 返回 None，按 a 写、b 从 0 探删；单测“写入收尾清掉中途失败留下的段”覆盖 |
| 删除只碰本键 | ✓。单测“写入收尾只删旧头部记的段”断言删除的名字都以 `<前缀><本键>~` 开头，另一个键的值不受影响 |

### lib.rs、policy.rs、Cargo.toml

| 核对项 | 结果 |
|---|---|
| RateLimit 改 Instant（X-S9） | ✓。签名上只收 `Instant`；`saturating_duration_since` 遇到更早的时刻按 0 算、不放行；单测还断言源码里没有 `SystemTime`，并且 lib.rs 调用处传的是 `Instant::now()`。`now_ms()` 只剩写启动失败日志一处用 |
| ComGuard（N3） | ✓。`CoInitializeEx(STA \| DISABLE_OLE1DDE)` 只在成功（含 S_FALSE）时配对 `CoUninitialize`，`RPC_E_CHANGED_MODE` 不配对；只在 `shell_open` 的栈帧内使用，不跨线程。新增的只有 `Win32_System_Com` 这一个 feature |

### env.rs

| 核对项 | 结果 |
|---|---|
| 预览、正式两套地址和公钥分开 | ✓。预览 `update_url` = `https://desktop.lemomemo-preview.pages.dev/latest.json`，和环境清单第 16、56 行的 Pages 项目 `lemomemo-preview`（负责人 10-28 已建）一致；正式 `https://lemomemo.com/desktop/latest.json`；单测两边各断言一次，并断言不留 `PREVIEW-PAGES-PROJECT` 占位。updater 公钥还没配，`desktop_scan.mjs` 已规定：正式配了公钥而预览没写或写成同一把，就失败 |
| 反向搜对方环境的检查是否仍然生效 | ✓。`desktop_scan.mjs` 直接从 env.rs 解析两个 `#[cfg]` 块，把对方的 `update_url` 列进 forbidden；新地址不是正式任何一个值的子串，反过来也不是，计数法不会误判。不一致风险见建议 3 |
| cargo test | 正式、`--features preview` 各 36 条通过，1 条 ignored（写真实凭据管理器的用例，按要求没跑） |

### stage-web.mjs（X-S7）

| 核对项 | 结果 |
|---|---|
| 类 HTML 后缀过 PAGES 名单 | 部分 ✓。列出的 11 个后缀都会失败；但 Tauri 对任何不认识的后缀都按 HTML 返回，黑名单列不全，见 F5-3 ② |
| svg 检查 | ✗。见 F5-3 ① |
| 现有产物 | 3 个 svg 图标都是纯 `<svg><rect>…`，没有脚本 |
| 回归测试 | `node --test desktop/src-tauri/scripts/stage-web.test.mjs`：16 条全过 |

### ci-guard.mjs（X-S8）

| 核对项 | 结果 |
|---|---|
| 扫 `.github/actions/**` | ✓。递归扫所有文件（现在 0 个） |
| 扫 `package.json` scripts | ✓（只扫根目录的）。JSON 解析失败时直接抛错，宁可失败 |
| 范围是否完整 | 基本够用，补充见建议 2 |
| 本机运行 | `ci-guard.mjs workflows`：通过（workflows 5 个、actions 0 个、package.json scripts）；`ci-guard.mjs permissions`：通过 |

### 其他

- `python -I build/check_backend.py`：0 个错误。
- `src/platform/http.ts`：fetch 失败、status 0 统一抛 `NetworkUnreadableError`（继承 `TypeError`，消息以 `Failed to fetch` 开头，supabase-js 各部分照旧认成网络错误）；`AbortError`、`TimeoutError` 原样抛。和架构 5.10“Cloudflare 超额错误页不带 CORS 头，按同步失败处理”一致 ✓。

## 四、验证记录（全部在本机，不连真实服务、不读密钥、不读真实凭据）

- `cargo test`、`cargo test --features preview`（desktop/src-tauri）：都是 36 通过、1 ignored。
- `node --test desktop/src-tauri/scripts/stage-web.test.mjs`：16 通过。
- `node desktop/src-tauri/scripts/ci-guard.mjs workflows`、`permissions`：都通过。
- `npx vitest run`（上面 6 个文件）：55 通过。
- `python -I build/check_backend.py`：0 个错误。
- 绕过验证（草稿目录 `C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\sec-feb-f5\`）：
  - `svg-probe.mjs` 的输出（“放过！”是 `checkSvg` 没拦住的写法）：
    - 命名空间前缀 script：放过！
    - XHTML 命名空间 script：放过！
    - 前缀 foreignObject：放过！
    - 前缀 iframe：放过！
    - 字符引用 `javascript:`：放过！
    - 首字母字符引用：放过！
    - 中间插 tab：放过！
    - SMIL set href：放过！
    - 外部 DOCTYPE：放过！
    - UTF-16LE 编码（带 BOM）：放过！
    - 大写 SCRIPT、CDATA 包 script、换行后的 onload：拦住。
  - `f11\`：`_shared/tests/`、`_shared/dist/` 里的常量，以及字符串拼接、模板串、join 写法，F11 都没报（只有 F7 报了 `\u` 转义那一行）。
  - `signout-probe.mts`：`signOut` 抛出 `key_not_allowed`，`-user` 留下，没有 `SIGNED_OUT`。

## 修订记录

- 2026-11-03：首次审查，结论为有条件签。必改 F5-1～F5-4，建议 8 条。

## 采纳情况（主持人，11-03）

- F5-1、F5-3、F5-4：交前端 B 必改，本批提交前改完，由本审查员复核。
  - F5-1：`removeItem` 遇到白名单外的键当成功，补单测；用真 supabase-js 加假白名单的 signOut 走一遍，作为回归测试。
  - F5-3：stage-web 的后缀检查改成白名单；svg 检查按本报告列的 13 种写法逐条补测试，9 种都要拦下；`.webmanifest` 这类会被 Tauri 当成 text/html 的后缀单独处理。
  - F5-4：和后端 BE1-S3 用同一口径，supabase/functions/ 下不跳过 tests/、`__tests__/`、dist/ 目录。
- F5-2：归前端 A。N1 的接口已转给前端 A，接入时一并处理 client.ts、readSessionId、clearLocalSessionIf，以及 auth 小窗口换存储。A8 验收前、CI 第一次打 exe 前必须完成，完成后由本审查员复核。前端 B 本批按审查意见改任务单第五节时，要把这一条加进冲突表（任务单正在审，主持人这次不改）。
- 建议：等代码审查的结论回来后合在一起，交前端 B 一并处理。预览更新地址两处写死的问题，交运维在 desktop.yml 加一步一致性核对，并入 W 系列一起复核。
- 等代码审查结论回来后，和这几条一起交给前端 B。

## 复核（11-03，安全审查，主持人照回报落盘）

### 结论：有条件通过，8 / 10

上一轮的必改里，F5-1、F5-3、F5-4 已改好；F5-2 按约定在 A8 验收前做，现在还没接。建议 1～8 能落地的都落地了。新增必改两条：F5-5、F5-6。

| 编号 | 复核结果 |
|---|---|
| F5-1 | 已解决：名单外的键读回 null、删除直接算成功，都不调 Rust；用真 createClient 调 signOut(local)，不抛错、两个键都删掉、PKCE 键不去 Rust |
| F5-2 | 未完成，按约定挂着：client.ts 仍用 authStorage()；卡 A8 验收和 CI 第一次打 exe，完成后复核 |
| F5-3 | 已解决：后缀白名单、文件头核对、svg 白名单分词器；上一轮 13 种绕过写法全部拦住 |
| F5-4 | 已解决：supabase/functions/ 下只跳过 node_modules，匹配放宽到 allow-origin；模板串、join 拼接拦不住，注释写明，靠 applyCors 兜底，可以接受 |
| 建议 1～8 | 2、3、4 已落地；1 部分落地，可以接受；5、7、8 不用改；6 已写进注释，F5-2 接线时核对 |

**外链（和 X-S2 冲突）：按现在的写法不能接受，列为必改 F5-5。** on_new_window 这条新窗口路径仍然只放 https；mailto、tel 只走顶层导航和 open_external。理由是新窗口路径不要求用户点过，第三方 iframe（view.officeapps.live.com）调 window.open('mailto:…') 能每秒拉起一次邮件程序，标题和正文预先填好；跨源 iframe 没有用户手势时，不能导航顶层窗口。替代做法：LocationText 遇到 mailto、tel 时不带 target=_blank，或在点击时调 open_external。不放 http，同意。另外建议：以后 officeapps 的 iframe 加 sandbox、不给 allow-popups；两条路径各用一个限速器。

**F5-6（低，第一次打 tag 前改）**：Tauri 先按内容嗅探 MIME，.js、.css 去掉开头空白后以 `<!--`、`<script` 等开头时，会被当成 html 或 xml 返回，而且不带 CSP。stage-web 要断言这两类文件的第一个字符不是 `<`，加两条测试。

### 通过条件
- F5-5 在本批提交前改好；
- F5-6 在第一次打 tag 前改好；
- F5-2 在 A8 验收前、CI 第一次打 exe 前完成，完成后复核。

### 跑过的测试
- cargo test 正式、预览两套，各 38 条通过、1 条忽略（写真实凭据管理器的那条）；
- stage-web 24 条通过；ci-guard 通过；相关 vitest 7 个文件 68 条通过；
- svg-probe 13 种写法、f11 样例 3 处都复跑过。

没有跑 gen-tauri-key 的测试。

### 采纳情况（主持人，11-03）
F5-5、F5-6 交前端 B，本批一起改。外链的替代做法交前端 A：LocationText 遇到 mailto、tel 时去掉 target=_blank。F5-2 交前端 A，现在开工。代码审查 R3 提出“http 链接在 exe 里点了没反应”，这一条问负责人。
