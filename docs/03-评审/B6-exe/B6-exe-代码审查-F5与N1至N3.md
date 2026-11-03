# B6-exe 代码审查：F5（转发层 CORS、超额错误页）、X-5、N1～N3、X-S7～S9

日期：2026-11-03　审查：代码审查员（只读）　被审：前端 B　版本：工作区 11-03 晚（都没 `git add`，以 `git diff` / `git status` 的实际改动为准；`src/platform/desktop.ts` 整个文件还未入库，只审其中 X-5、N1 两部分）

被审文件：
- F5：`functions/_lib/cors.ts`、`build/check_backend.py`（F11）、`tests/arch-fixtures/check_backend/f11-edge-cors*/`、`tests/build/check-backend-f11-cors.test.ts`、`tests/functions/cors-exe-426.test.ts`、`tests/functions/cors-supabase-js-headers.test.ts`、`src/platform/http.ts`、`src/platform/__tests__/http.test.ts`
- X-5、N1：`src/platform/desktop.ts`（`closeAllLocalReminders`、`desktopSessionStorage`、`createDesktopSessionStorage`、`onAuthDone`）、`src/platform/__tests__/desktop-session.test.ts`、`desktop.test.ts` 的 X-5 三条
- N2：`desktop/src-tauri/scripts/stage-web.mjs` 注释、`docs/09-路线图/B6-exe-任务单.md` 第五节冲突表
- N3：`desktop/src-tauri/src/lib.rs`（`ComGuard`）、`Cargo.toml`（`Win32_System_Com`）、`src/session.rs`（收尾收窄）
- X-S7：`stage-web.mjs`（`PAGE_EXT`、`checkSvg`）及测试；X-S8：`scripts/ci-guard.mjs`；X-S9：`src/policy.rs` 的 `RateLimit`
- `src/env.rs` 预览更新地址；`vitest.config.ts` 的 `SLOW_NODE_TESTS`

规矩依据：`docs/09-路线图/B6-exe-任务单.md` F5 ①～⑤、第五节；`docs/10-架构/架构设计-v4.md` 5.10“跨域”、0.54；本目录《B6-exe-代码审查-F1至F4F8》复核的 N1～N3；《B6-exe-安全审查-外壳》X-5、X-S7～X-S9；`docs/08-发布/环境清单-v4.md` 第一节（预览 Pages 项目 `lemomemo-preview`）。

## 结论

| 部分 | 结论 | 分数 |
|---|---|---|
| F5（cors.ts、F11、抓包、426 核对、http.ts 超额错误页） | **有条件签**：M2、M3 改完由本审查员复核 | 7.5 / 10 |
| N1（exe 会话存储、auth:done） | **不签**：M1 改完复核（退出登录在 exe 里会抛错） | 6 / 10 |
| X-5、N2、N3、X-S8、X-S9、env.rs | **签** | 9 / 10 |
| X-S7（svg 检查） | **有条件签**：M4 改完复核 | 6.5 / 10 |

做得好的：`NetworkUnreadableError` 继承 `TypeError`、消息以 `Failed to fetch` 开头，逐个核对过各处断网判断都认得出来，取消和超时原样抛出，`postgrest` 经 `appFetch` 的真实路径有测试；N1 的排队写法简洁，不会死锁，也不吞写入异常；`ComGuard` 对 `RPC_E_CHANGED_MODE` 的处理正确；X-S9 改得彻底，签名上就拿不到系统时间；`env.rs` 两套都加了断言，不许留占位；抓包测试真的不联网，请求头清单钉死了，换版本会报出来。

本批之外的说明：任务里提到的 `settings-jump-css.test.ts` 和 `tsconfig.functions.json` 里 `auth.ts` 的报错，本次复跑时都已经没有了（前者 7 条通过，`tsc -p tsconfig.functions.json` 0 错误）；两个文件都不在本批改动里（`git status` 里没有 `settings-jump-css.test.ts`，`supabase/functions/_shared/auth.ts` 未改动），与本批无关。`vitest.config.ts` 的 diff 实际加了三行：`check-backend-f11-cors.test.ts` 是本批的，`check-backend-f9-server.test.ts`、`set-vapid-keys.test.ts` 是 B2 其他人的，不在本次审查范围内。

## 必改

| # | 问题 | 位置 | 改法 |
|---|---|---|---|
| M1 | **exe 里退出登录会抛错，`SIGNED_OUT` 不发**（N1）。auth-js 2.118 的 `_removeSession`（`GoTrueClient.js:4418-4436`）删完会话键以后，**不管用不用 PKCE**，都会调 `removeAllPKCEVerifiers`：先读、再删 `sb-lemomemo-auth-token-flows-code-verifier`，接着删 `…-code-verifier`、`…-user`。前两个键不在 Rust 白名单里（`env.rs` 的 `session_keys` 只有 `…-auth-token` 和 `…-auth-token-user`），`session_remove` 回 `key_not_allowed`；`desktopSessionStorage.removeItem` 按设计“删失败照样抛”，于是 `signOut` 直接抛出一个裸字符串，后面的 `-user` 删除和 `SIGNED_OUT` 通知都没走。草稿探针（`cr-feb-f5/n1-signout-probe.mjs`，照抄 `desktop.ts:200-247` 的实现，用真的 supabase-js 2.118、假的白名单 invoke，全局 fetch 换成抛错）复现：`signOut({scope:'local'})` 抛出 `key_not_allowed`，事件只有 `SIGNED_IN,INITIAL_SESSION`，被拒的调用是 `session_get/session_remove …-flows-code-verifier`。App 里 `auth-api.ts:256`、`account-gate.ts:158`、`settings-api.ts:217` 都按 `{ error }` 解构，没料到会抛；刷新令牌被判失效、auth-js 自己清会话时走的也是 `_removeSession`，同样会断在这里。现有用例 `读失败…写、删失败照样抛` 恰好把这个行为钉成了“对的” | `src/platform/desktop.ts:200-247`；`src/platform/__tests__/desktop-session.test.ts:46-54` | `desktopSessionStorage(invoke, allowedKeys)` 接收和 Rust 同一份键名单（或由 `preload` 的键推出）：名单外的键 `getItem` 回 null、`removeItem` 直接成功（本来就不会有）、`setItem` 照样抛（写不进去要让 auth-js 知道，将来改 PKCE 时能马上发现）。不要改成放宽 Rust 白名单。补一条用例：用真的 `createClient` + 本存储 + 白名单假 invoke，`signOut({scope:'local'})` 返回 `{ error: null }`、收到 `SIGNED_OUT`、凭据里两个键都没了 |
| M2 | **F11 漏掉了最常见的加 CORS 写法**：supabase-js 2.118 自带 `@supabase/supabase-js/cors`（`package.json` exports 有 `./cors`，`dist/cors.mjs` 注释里就是官方推荐的 `import { corsHeaders } from '@supabase/supabase-js/cors'`），里面带 `Access-Control-Allow-Origin: *`。函数里这样写，源码里没有那串字，F11 不报。草稿探针（`cr-feb-f5/f11-probe`，在对照样例的副本里改成 `import { corsHeaders } from 'npm:@supabase/supabase-js@2.118.0/cors'` 并展开进响应头）跑 `check_backend.py --root`：`{"errors": []}`。`/sb` 转发时 `applyCors` 会删掉上游的 `Access-Control-*`，exe 本身不受影响；但直连 `<ref>.supabase.co/functions/v1/*` 的浏览器会拿到 `*`，这正是 Q-A3 要防的“多开一道口子” | `build/check_backend.py:1179-1206` | 在 F11 里加一条：`supabase/functions/` 下 import 了 `@supabase/supabase-js/cors`（含 `npm:@supabase/supabase-js@x/cors`、`jsr:`、esm.sh 等写法，`parse_sources` 已经给出 import 边）或 `hono/cors` 一律报；补一个违规样例。字符串拼接（`'Access-Control-' + 'Allow-Origin'`，探针里同样不报）属于有意绕过，可以不管，但在规则说明里写明“只防无意写入” |
| M3 | **抓包测试没有抓响应头，和架构 5.10 的说法对不上**。架构第 3313 行写“请求头或响应头一有变化，这个测试就会报出来”，但 `cors-supabase-js-headers.test.ts:106-109` 的第二条只是拿写死的 4 个名字查 `EXPOSE_HEADERS`，supabase-js 升级后开始读一个新的响应头（比如 0.54 记的 `x-relay-error` 这类），测试照样通过 | `tests/functions/cors-supabase-js-headers.test.ts:28-43`、`:106-109` | 在 `fakeFetch` 返回的 `Response` 上包一层：`headers.get` / `has` 记下被读的名字（可用 `Proxy`，或返回自定义 `Headers` 子类），按步骤汇总；去掉 CORS 安全响应头（`cache-control`、`content-language`、`content-length`、`content-type`、`expires`、`last-modified`、`pragma`）后钉成清单，并断言“清单 ⊆ `EXPOSE_HEADERS` ∪ 0.54 里写明不暴露的那几个”。做不到就把架构那句改成只说请求头（改架构要请架构师） |
| M4 | **svg 检查很容易绕过**（X-S7）。`checkSvg` 只按固定写法做正则：带命名空间前缀的元素、字符引用、非 UTF-8 编码都漏。草稿探针（`cr-feb-f5/svg-probe.mjs`）7 种写法全部返回 `[]`：`<s:script>`（`xmlns:s` 指 SVG 命名空间）、`<h:script xmlns:h="http://www.w3.org/1999/xhtml">`、`<s:foreignObject>`、`x:href="javascript&#58;…"`、`href="java&#x09;script:…"`、`<animate attributeName="href" to="javascript&#x3a;…">`、UTF-16 编码带 BOM 的 `<script>`（`readFileSync(p,'utf8')` 读出来是乱码）。main 现在只能导航到入口页，`<img>` 里的 svg 不跑脚本，实际风险低；但注释写的是“里面不许有 <script>…”，现在这个保证不成立 | `desktop/src-tauri/scripts/stage-web.mjs:69-81`、`:218-221` | ① 元素名允许任意前缀：`/<([\w.-]+:)?(script|foreignObject|iframe|embed|object|handler|listener)\b/i`；② 出现任何 `&#`（数字字符引用）就拒——图标里用不到；③ 用 `new TextDecoder('utf-8', { fatal: true })` 解码，失败、带 UTF-16 BOM、含 `\0` 都拒；④ 上面 7 种写法补进用例。也可以改成白名单（只许 `svg`、`g`、`path`、`rect`、`circle`、`ellipse`、`line`、`polyline`、`polygon`、`defs`、`linearGradient`、`radialGradient`、`stop`、`clipPath`、`mask`、`title`、`desc`，属性只许不带 `on`、不带 `href` 的），更稳 |

## 建议

- **S1 session.rs：删旧段中途失败会留下“中间断开”的孤段，注释的前提不成立**（`src/session.rs:188-192`，文件头第 9～10 行）。写入失败留下的段确实从 0 连着排，`trim` 能清干净（用例 `写入收尾清掉中途失败留下的段` 覆盖了，推演也成立：下一次写同一套代号会覆盖 0..n-1，`trim(gen, n)` 往后探到第一个空位）。但收尾里 `for i in 0..old_n` 是**从小到大、失败也继续**删的：比如旧那套有 5 段，删到第 2 段失败、其余成功，就剩下孤立的 `~x2`。之后写这套代号如果只有 1 段，`trim(x, 1)` 读 `~x1` 不存在就停，`~x2` 留下；轮到另一套时 `trim(x, old_n=1)` 同样探不到。它会一直留到退出登录（`remove` 仍全删，这点没变），里面是旧会话 JSON 的一段。不多删：`trim` 只碰本键、指定代号的段，碰不到头部和另一个键（用例已核）；少删只在上面这种删除失败时出现。建议改成**从大到小删、第一次失败就停**，这样残留总是 `0..k` 连续的前缀，后面的 `trim` 一定清得到；同时把注释改成“写入失败和删除失败留下的段都从 0 连着排”。
- **S2 N1：读失败时镜像记成 null，`peek` 分不出“没有会话”和“没读到”**（`desktop.ts:215-225`）。`preload` 时凭据管理器偶尔出错，`peek` 返回 null，前端 A 的同步 `readSessionUserId` 会当成没登录、去开登录窗口，虽然凭据里会话还在。建议读出错时不写镜像（保持 `undefined` 或上一次的值），只在 Rust 确实回了“没有”时记 null；`getItem` 对 auth-js 照旧回 null。另外 invoke 一直不返回时同一个键后面的操作都会排着等，可以给每次 invoke 加一个较长的超时（如 10 秒），超时按失败处理。
- **S3 N1 语义能支撑前端 A 的同步读，但要按这个顺序接**：`createDesktopSessionStorage()` → `await preload(ENV 的两个键)` → 再建 supabase 客户端、再调 `readSessionUserId`。`readSessionUserId(storage?)`（`session.ts:56`）要的是 `Storage`（会用 `length`、`key(i)` 找键），前端 A 需要用 `preloaded` + `peek` 拼一个只读的 `Storage` 形状，不要直接把本存储传进去。键名推导核过：`https://lemomemo.com/sb` → `sb-lemomemo-auth-token`，预览 `https://preview.lemomemo.com/sb` → `sb-preview-auth-token`，和 `env.rs` 一致。auth-js 2.118 默认 `flowType: 'implicit'`，本 App 也没改，不会写 PKCE 键；以后要改 PKCE，Rust 白名单和 M1 的名单要一起加。
- **S4 抓包测试**：① 建客户端用的是手抄的选项（`cors-supabase-js-headers.test.ts:45-58`），不是 App 的 `clientOptions()`，以后 App 改了选项（`flowType`、`userStorage`、`db.schema` 等）这里看不到。建议用 `clientOptions()` 再把 `global.fetch` 换成 `fakeFetch`。② “不联网”现在靠三个子库都用传进去的 fetch；建议在 `beforeAll` 里把 `globalThis.fetch` 换成直接抛错，万一哪个库绕过去会立刻失败（本次探针这样做过，没有触发）。
- **S5 http.ts**：逐个核对过，没有漏判、误判——postgrest 抛 TypeError 后回 status 0（`toFailure` → network，outbox transient 退避；GET 先自己重试 3 次约 7 秒）；auth-js 包成 `AuthRetryableFetchError`；functions-js 包成 `FunctionsFetchError`（`account-gate.ts:62` 认）；直接调 `appFetch` 的 `auth-api.ts:89` 按 `name === 'TypeError'`、`settings-api.ts`、`consent-api.ts`、`sync-transport.ts` 按 `FETCH_FAILED` 认成 offline / network；`account-api.ts` 的超时用 `ac.abort()`（没有自定义 reason，仓库里 grep 不到 `.abort(x)`），`AbortError` 原样抛出，仍按超时处理；`sign-out.ts:261` 吞掉所有异常。唯一的副作用：非网络原因的 TypeError（非法请求头值、非法 URL）也被归成网络错误、进退避，不会再被当成永久失败。现在 postgrest 本来就把它们当 status 0，影响很小；如果以后要区分，可以在 `cause` 里看原错误的消息。另外 `if (isAbort(e))` 只认 `name`，将来谁用 `abort(reason)` 传自定义原因，会被改成网络错误——建议在 `http.ts` 注释里写一句“取消请用不带参数的 `abort()`”。
- **S6 F11 其他小处**：读不出 UTF-8 的文件直接跳过（`check_backend.py:1195`），建议改成报一条“读不了，检查不了”；`DOCKER_HOST_SKIP_DIRS` 会跳过函数目录里名为 `dist`、`docs` 的子目录，函数要是 import 了 `./dist/x.js` 就查不到，可以只对 F11 去掉 `dist`。`.json`、`.toml` 按原文查，注释里提到这个头也会报，偏严，可接受。
- **S7 ComGuard**：`RPC_E_CHANGED_MODE` 时 `hr.is_ok()` 为假、不配对 `CoUninitialize`，照样调 `ShellExecuteW`，正确；`S_FALSE`（主线程已由 tao/wry `OleInitialize`）时配对释放，也正确。小点：注释说“ComGuard 不跨线程”，但 `struct ComGuard(bool)` 自动是 `Send`，建议加 `PhantomData<*const ()>` 让编译器保证。
- **S8 ci-guard**：`walkFiles` 用 `withFileTypes`，符号链接既不是目录也不是文件，会被跳过；`tools/deploy/package.json` 的 scripts 没扫。都是小口子，真正的防线是 `stage-web.mjs` 在 CI 里拒绝跳过参数（X-4），可以不改，或在注释里写明范围。
- **S9 X-5 的配合**：`epoch` 只拦得住“退出前已经开始、还在等权限”的那一次弹出；退出以后上一个账号的提醒计时器如果还在跑，照样会调 `showLocalReminder`。这要由前端 A 的提醒调度在退出时停掉，请在 `native-bridge.ts` 的说明里点一句。

## 逐项核对

| 项 | 结果 | 依据 |
|---|---|---|
| F5 ① 抓包 | 有条件通过（M3、S4） | `capture()` 拦截 fetch，覆盖 App 实际用到的全部 supabase-js 调用（grep `src`：`signInWithOtp`、`verifyOtp`、`getSession`、`refreshSession`、`updateUser`、`signOut`、`rpc`、`functions.invoke`，外加 REST 增删改查、计数、503 重试）；请求头清单用 `toEqual` 钉死，升级时多一个、少一个都会报；抓到 `x-retry-count`，并核对只在重试那步出现。不联网：三个子库都用传入的 fetch，本次探针把全局 fetch 换成抛错也没触发。响应头没有抓（M3） |
| F5 ② 删 `x-upsert`、`cache-control` | 通过 | `cors.ts:27-30`；`cors-exe-426.test.ts` 核对 `/sb`、`/files` 两张表和真实预检响应里都没有 |
| F5 补 `x-retry-count`、`Retry-After` | 通过 | 和 postgrest-js 2.118 源码一致（`index.mjs:201` 带 `X-Retry-Count`，`:224` 读 `Retry-After`）；架构 5.10 第 3310、3313 行和 0.54 已同步 |
| F5 ③ 426 带 exe 的 CORS 头 | 通过 | `cors-exe-426.test.ts`：`/sb`、`/files` 各三种来源，exe 来源精确回写、暴露头齐全、不带 Credentials、`Vary: Origin`；别的来源和无来源不带任何 `Access-Control-*` |
| F5 ④ F11 | 有条件通过（M2、S6） | 注释用 AST 去掉后再查，测试源码、转发层不查，行号正确；样例和对照样例各一。漏报见 M2 |
| F5 ⑤ http.ts | 通过（S5） | 见 S5 的逐个核对；`status 0` 在 `observeClock`、426 判断之前拦下；5xx、429 照旧返回给 outbox 退避；`cause` 只留原错误，不读响应体 |
| X-5 | 通过（S9） | `closeAllLocalReminders` 先加 `epoch` 再清 `shown`，逐个 `close` 并吞单条异常；`showLocalReminder` 在等权限之后核对 `epoch`，之后没有 `await`，不会再插进来；有三条用例 |
| N1 | 不通过（M1、S2、S3） | 形状和 auth-js `SupportedStorage` 兼容（`PromisifyMethods` 允许返回 Promise，多出的 `peek`、`preload` 不影响赋值；`tsc -p tsconfig.app.json` 0 错误）。排队：`prev.then(run, run)` 的 `prev` 是吞掉异常的尾巴，前一个失败不卡后一个、异常仍交给本次调用方，没有死锁（除非 invoke 永远不返回，S2）。`peek` / `preload` 能支撑同步读（S3）。问题在名单外键的删除（M1） |
| N2 | 通过 | `stage-web.mjs:13-14` 注释改对；任务单第五节第 231 行加了 `preview.html` 一行（B4b-1 时挪进 `PAGES`、单独定 CSP） |
| N3 ComGuard | 通过（S7） | `Cargo.toml` 加 `Win32_System_Com`；`shell_open` 开头建 guard，三种返回值处理正确；`open_external`、注册页、新窗口外链三个调用点都经过 `shell_open` |
| N3 session 收窄 | 通过（S1） | 每次写的删除次数从最多 95 降到“旧段数 + 探测”；不多删（只碰本键、指定代号）；写入失败的残留能清干净；删除失败的残留可能清不到，见 S1；`remove` 仍全删 |
| X-S7 | 有条件通过（M4） | `PAGE_EXT` 覆盖 `.htm`、`.xhtml`、`.xht`、`.shtml`、`.xml`、`.xsl(t)`、`.mht(ml)`、`.svgz`，都要过 `PAGES`（名单里只有 `.html`，出现就失败），有用例；现有产物三个图标 svg 不误伤。svg 内容检查可绕过（M4） |
| X-S8 | 通过（S8） | 扫 `.github/actions/**` 全部文件和根 `package.json` 的 scripts，JSON 坏了直接抛错；有用例和“仓库现状为零”的用例 |
| X-S9 | 通过 | `RateLimit` 只收 `Instant`，`saturating_duration_since` 防倒序；用例还核对 `lib.rs` 调用处用 `Instant::now()`、`RateLimit` 段里没有 `SystemTime` |
| env.rs | 通过 | `https://desktop.lemomemo-preview.pages.dev/latest.json` 和环境清单第一节的预览 Pages 项目 `lemomemo-preview`、`desktop.yml:354` 的 `https://desktop.${PREVIEW_PAGES_PROJECT}.pages.dev` 一致；正式、预览各一条断言，两套都不许留占位 |
| vitest.config.ts | 通过 | `check-backend-f11-cors.test.ts` 进 `SLOW_NODE_TESTS`，本次跑在 `node-slow` 项目里 |

## 跑过的测试

- `desktop/src-tauri` 下 `cargo test`（正式版）：36 条通过，1 条按 `#[ignore]` 跳过（真机凭据）。
- 同上加 `--features preview`：36 条通过，1 条跳过。
- `node --test desktop/src-tauri/scripts/stage-web.test.mjs`：16 条全过。
- `npx vitest run` 指定文件：`src/platform/__tests__/http.test.ts`、`desktop-session.test.ts`、`desktop.test.ts`、`sign-out-relogin.test.ts`、`tests/functions/cors-exe-426.test.ts`、`cors-supabase-js-headers.test.ts`、`tests/build/check-backend-f11-cors.test.ts`、`src/core/__tests__/outbox-boot.test.ts`，以及 `src/features/settings`、`src/features/onboarding`、`src/features/auth` 整个目录：57 个文件、639 条全过。另单跑 `settings-jump-css`：7 条通过。
- `tsc -p tsconfig.app.json`、`tsc -p tsconfig.functions.json`、`tsc -p tsconfig.node.json`：都是 0 错误。
- `eslint`（只查本批改过的 12 个文件）：0 错误、0 警告。
- `python -I build/check_backend.py`：0 个错误。
- 草稿探针（`C:\Users\hoobey\AppData\Local\Temp\claude\D--claude-code\377a2f6c-6055-4a6d-a7cc-507392afac21\scratchpad\cr-feb-f5\`）：`n1-signout-probe.mjs`（M1，复现 `signOut` 抛 `key_not_allowed`）、`f11-probe/`（M2，`check_backend.py --root` 回 0 个错误）、`svg-probe.mjs`（M4，7 种写法全部放行）。都不联网（全局 fetch 换成抛错），没有运行 exe，没有往凭据管理器写东西，没有改仓库文件。

## 采纳情况（主持人，11-03）

- M1：和安全审查 F5-1 合并。存储接收白名单：名单外的键读回 null，删除直接算成功，写入照样抛错。补一条用真 `createClient` 退出登录的用例，断言三件事：不抛错、`-user` 被删、`SIGNED_OUT` 照发。
- M2：和安全审查 F5-4 合并。F11 要拦住两种情况：
  - import `@supabase/supabase-js/cors` 这类自带 CORS 的子路径；
  - supabase/functions/ 下不再跳过 tests/、`__tests__/`、dist/。
  两种都要补违规样例。
- M3：补测试，不改架构那句话。在假 fetch 里记录 supabase-js 实际读过哪些响应头，把这份清单钉住。补完之后，架构 5.10 写的“请求头或响应头一有变化测试就会报”才成立；在此之前这句话不准确，由主持人负责盯住。
- M4：和安全审查 F5-3 合并，取两边里更严的做法：
  - 后缀改成白名单；
  - svg 检查：元素名允许任意前缀，出现 `&#` 就拒，按 UTF-8 严格解码、失败就拒，拒绝外部 DOCTYPE；
  - 两份审查列出的写法逐条写成测试；
  - `.webmanifest` 这类会被 Tauri 当成 text/html 的后缀单独处理。
- S1（删除从大到小、第一次失败就停）、S2（区分“没读到”和“没登录”）、S3（给前端 A 提供 Storage 形状的同步适配）、S5：本批一起改。S4 由前端 B 自定，不改的写明理由。
- 安全审查的建议一并交前端 B。预览更新地址在两处写死的一致性核对，交运维。
- N1 现在是“不签”。M1 改完，加上前端 A 接入（安全审查 F5-2）以后，本审查员和安全审查员一起复核。

## 复核（2026-11-03 晚，同一审查员，只看改动）

依据：`git diff HEAD` 看 `src/platform/http.ts`、`build/check_backend.py` 的 F11 段、`desktop/src-tauri/src/{policy.rs,lib.rs,session.rs}`、`desktop/src-tauri/scripts/{stage-web.mjs,stage-web.test.mjs,ci-guard.mjs}`、`docs/09-路线图/B6-exe-任务单.md`；新文件直接读：`src/platform/desktop.ts`、`desktop-session.test.ts`、`desktop-session-signout.test.ts`、`tests/functions/cors-supabase-js-headers.test.ts`、`tests/build/check-backend-f11-cors.test.ts`、`f11-edge-cors*/`。上一轮的三个探针原样复跑。没有跑 `tests/build/gen-tauri-key.test.ts`。

### 结论

| 部分 | 结论 | 分数 |
|---|---|---|
| F5（cors.ts、F11、抓包、http.ts） | **签** | 8.5 / 10 |
| N1（exe 会话存储） | **签** | 9 / 10 |
| X-S7（暂存文件类型、svg） | **签** | 9 / 10 |
| X-5、N2、N3、X-S8、X-S9、env.rs | **签**（维持） | 9 / 10 |
| 外链转交（新加的 `link_external_url`、`hand_link_to_system`） | 代码**签**；放不放 mailto、tel 由安全审查定，见 R3 | 8.5 / 10 |

M1～M4 全部改到位，S1～S9 中 S1 只改了一半、S9 没做，都不卡签字。新发现三条建议（R1～R3）。

### 逐条复核

| # | 结果 | 依据 |
|---|---|---|
| M1 | 改到位 | `desktop.ts:239-302`：`desktopSessionStorage(invoke, allowedKeys)`，名单外 `getItem` 回 null、`removeItem` 直接成功、`setItem` 拒绝，都不调 Rust。`desktopSessionKeys()` 由接口地址推出，`desktop-session-signout.test.ts` 直接读 `env.rs` 核对正式、预览两套和 Rust 的 `session_keys` 相等，也和 `session.ts` 的 `sessionStorageKey` 一致。新用例用真的 `createClient` 调 `signOut({scope:'local'})`：`error` 为 null、两个键都删掉、收到 `SIGNED_OUT`、`code-verifier` 一次也没去 Rust、全局 fetch 没被调用 |
| M2 | 改到位，留一个口子（R1） | `check_backend.py:1180-1267`：拦 `@supabase/supabase-js/cors`、`hono/…/cors`、npm 的 `cors`，认 `npm:`、`jsr:`、esm.sh、jsdelivr、deno.land、带版本、百分号编码，`.json` / `.jsonc` 里的别名按字符串值查；只跳过 `node_modules`；读不出 UTF-8 改成报错。上一轮的探针现在报两条（import 一条、拼接出的 `allow-origin` 一条）。用 `is_cors_lib` 逐个试了 15 种写法，只有 `dist/cors.mjs` 那一类漏掉 |
| M3 | 改到位 | `TrackedHeaders` 记下 `get`、`has` 读过的名字，遍历记成 `*` 并断言没有；去掉安全响应头后钉成清单（`content-range`、`date`、`retry-after`、`x-relay-error`、`x-supabase-api-version`），断言每个都在 `EXPOSE_HEADERS` 里或在 0.54 的“不暴露”名单里，两张名单不重叠；补了 auth 出错、函数出错两步，`x-supabase-api-version`、`x-relay-error` 才会被读到。架构 5.10 那句话现在成立 |
| M4 | 改到位 | `stage-web.mjs`：后缀改白名单（`ASSET_EXT`），png、ico、woff2 核对文件头，json、webmanifest 必须能解析（webmanifest 另外不许有 `<`）；svg 用只认白名单写法的小分词器，元素白名单、不许前缀、不许 `&#`、实体只许 5 个、`href` 只许 `#id`、`url()` 只许 `#id`、属性值必须带引号、严格 UTF-8。上一轮 7 种写法复跑全部被拒；另外试了 `<svg/onload=…>`（属性写法不对，拒）、`<title><script>`（拒）。现有三个图标照样能过 |
| S1 | 改了一半（见 R2） | `session.rs:192-196`：删旧段改成从大到小、第一次失败就停，有用例 `删旧段中途失败_不留中间断开的孤段`。但 `trim` 仍是从小到大边探边删，见 R2 |
| S2 | 改到位 | 读出错、超时不动镜像（`ReadResult` 区分），`peek` 仍是 `undefined` 或上一次的值；每次 invoke 10 秒超时（`SESSION_INVOKE_TIMEOUT_MS`）。小点：超时只是不再等，Rust 那次调用还会做完；超时之后排在后面的操作可能和它在 Rust 里先后到达，这种情况下排队的顺序保证不成立。概率很低，可在注释里写一句 |
| S3 | 改到位 | 新增 `sessionStorageView`（只读 `Storage` 形状，有用例核对 `readSessionUserId(view)` 能读到），接线顺序写进注释；任务单第五节加了前端 A 接入的一行，写明 A8 和第一次 CI 打 exe 前必须完成 |
| S4 | 改到位 | 抓包改用 App 的 `clientOptions()`（动态 import，避免把 `env.ts` 带进 `tsconfig.functions.json`），全局 fetch 换成抓包替身，并断言每个请求都带 `X-App-Version`（只有经过 `appFetch` 才带），哪个库绕开传入的 fetch 都会失败 |
| S5 | 改到位 | `http.ts` 注释写明“取消请用不带参数的 `abort()`”和非网络 TypeError 的副作用 |
| S6 | 改到位 | 读不出 UTF-8 报错不跳过；`tests/`、`dist/` 照扫，只按文件名跳过测试源码 |
| S7 | 改到位 | `ComGuard(bool, PhantomData<*const ()>)`，编译器保证不跨线程 |
| S8 | 改到位，且加宽 | 扫仓库里所有 `package.json`（除 `node_modules` 等）、`tauri*.json`、`build/ci/`；工作流里把 `CI` / `GITHUB_ACTIONS` 清空、设 false 或 0 也失败。本机跑 `ci-guard.mjs workflows` 通过；现有工作流里没有名为 `ci` 的键，不会误报 |
| S9 | 没做 | `native-bridge.ts` 里没有“退出时提醒调度也要停”的说明。不卡，请转前端 A 记在提醒调度里 |

### 新问题（都是建议，不卡签字）

- **R1 F11：`@supabase/supabase-js` 的 `dist/cors.mjs` 路径漏报**。supabase-js 2.118 的 `exports` 有 `./dist/*`，`npm:@supabase/supabase-js@2.118.0/dist/cors.mjs`、`https://esm.sh/@supabase/supabase-js@2/dist/cors.mjs`、jsdelivr 的同名路径在 Deno 里都能 import。`is_cors_lib` 对这 4 种写法都回 False；草稿副本里改成这种写法，`check_backend.py --root` 回 0 个错误。这种写法比 `/cors` 少见，但也是照着包目录抄就能写出来的。改法：supabase-js 那一支允许 `(?:/dist)?/cors(?:\.[cm]?js)?`，补一个样例。
- **R2 session.rs：`trim` 删除失败仍会留下中间断开的孤段，文件头注释的前提还不成立**（`session.rs:137-149`、第 11～12 行）。`trim` 从 `from` 往上**边探边删**，删到第 j 段失败就停：from..j-1 已删、j..m 还在，中间断开了。之后 `trim(gen, n)` 探 n 不存在就停，j..m 一直留到退出登录。例子：上一次写 b 失败留下 b0..b5，这次写 b（1 段）收尾时 `trim(b, 1)` 删 b1 成功、删 b2 失败 → b2..b5 留下；下次写 a，`trim(b, 1)` 探 b1 不存在就停。注释说“trim 本身遇到读、删失败也停，留下的同样连着”，不对。改法：`trim` 先往上读到第一个不存在的位置（只读不删），再从最高的一段往下删、第一次失败就停；补一条“trim 中途删失败”的用例。只在删除失败时出现，`remove` 仍全删，风险低。
- **R3 外链转交（代码这一侧）**：
  - 实现正确：`on_navigation` 只有在 `navigation_allowed` 拒绝、且是 main 时才转交，入口页照常加载；`location.replace('/app/auth/')` 这类本地地址被 `link_external_url` 拒掉（http、本机都不放），不会被交给系统；`on_new_window` 一律 `Deny`。两条路径共用一个 `LINK_LIMIT`，先查地址再限速再起线程开，结构用例钉住了顺序。`shell_open` 在新线程里自己建 `ComGuard`，没有占界面线程。wry 0.57.1 只挂了 `NavigationStarting`（没挂 `FrameNavigationStarting`），所以只管顶层导航；iframe 里的导航不经过这里，仍由 WebView2 自己处理。
  - 给安全审查的一点事实：把新窗口路径收回到只放 https，**并不能**挡住无点击拉起邮件、电话程序——main 里的脚本写 `location.href = 'mailto:…'` 走的是 `on_navigation`，同样没有“用户点过”的信息（wry 的导航回调也拿不到 `IsUserInitiated`）。两条路径在这一点上等价，真正的前提是 main 不被注入脚本（严格 CSP），兜底是 1 秒 1 次和 mailto 参数白名单。如果要“必须点过”，只能让页面在点击处理里调 `open_external`，并在壳子里把被拦下的 mailto、tel 一律丢掉。放不放由安全审查定。
  - 行为变化：http 链接两条路径都**静默丢掉**。用户在笔记、地点里写的 `http://` 网址在 exe 里点了没反应，网页版能打开。建议和协调员确认是否接受；不接受的话可以改成换成 https 再交出去，或者给页面回一个“打不开”的提示。
  - 真机验收要加一条：main 里点 `mailto:`、`tel:` 链接时，只拉起一次系统程序，不会再弹 WebView2 自带的“要打开外部程序吗”对话框（`NavigationStarting` 里取消以后应当不弹，离线核实不了）。

### 复核时跑的测试

- `cargo test`（正式版）、`cargo test --features preview`：各 38 条通过，1 条按 `#[ignore]` 跳过。
- `node --test desktop/src-tauri/scripts/stage-web.test.mjs`：24 条全过；`node desktop/src-tauri/scripts/ci-guard.mjs workflows`：通过。
- `npx vitest run`：`http.test.ts`、`desktop-session.test.ts`、`desktop-session-signout.test.ts`、`desktop.test.ts`、`cors-exe-426.test.ts`、`cors-supabase-js-headers.test.ts`、`check-backend-f11-cors.test.ts`、`outbox-boot.test.ts`，以及 `src/features/settings`、`onboarding`、`auth` 整个目录：57 个文件、642 条全过。
- `tsc`：`tsconfig.app.json`、`shared`、`sw` 0 错误；`tsconfig.functions.json` 7 个错误，全在 `supabase/functions/_shared/push/ece.ts`、`send.ts`（B2 推送，后端的）；`tsconfig.node.json` 4 个错误，在 `tests/build/gen-tauri-key.test.ts`、`tests/edge/push-dispatch.test.ts`。都不在本批改动里。
- `eslint`（本批改过的 9 个文件）：0 错误、0 警告。
- `python -I build/check_backend.py`：7 个错误，全是 F7，在 `supabase/functions/push-dispatch/round.ts`、`store.ts`（B2 推送，未入库的新文件）；F11 没有报错。不在本批范围。
- 草稿探针（`cr-feb-f5/`，结果在 `cr-feb-f5/r2/`）：`svg-probe.mjs` 7 种写法全部被拒；`f11-probe/` 原写法现在报 2 条，改成 `dist/cors.mjs` 写法报 0 条（R1）；`is_cors_lib` 逐个试 15 种写法。不联网，没有运行 exe，没有写凭据管理器，没有改仓库文件（除本记录）。
