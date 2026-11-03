# B2 安全审查 · 前端 A 的 FA-2 第一段与推送重订

- 审查人：安全审查员（只读，没有改仓库里的任何文件，只写了本文件）
- 日期：2026-11-03
- 审查对象：前端 A 这一批工作区里的改动（都没有 git add，以 `git diff`、`git status` 为准）：
  - `src/platform/push-claim.ts`（新文件）、`src/platform/supabase/sync-transport.ts` 的 `claimEndpoint`、`src/app/main.tsx` 里的调用
  - `src/platform/push.ts` 的 `disconnectBrowserPush`（X-5 用 `withinMs` 包住 `closeAllLocalReminders`）、`src/platform/sign-out.ts`
  - `src/sw/push.ts` 的 M3（remind 可以不带标题）
  - `src/kit/components/LocationText.tsx`（新文件）、`src/kit/components/__tests__/safe-link.test.tsx`
  - `src/kit/hooks/useEditRecord.ts`、`src/core/edit-save.ts`（新文件），以及两个编辑页里用到它们的地方
- 参照的材料：`B2-安全审查-S-B2签字.md` 中的 D1、D2、六之三（FE-1～FE-4）和六之四；架构 5.3、1.5、4.1 的清空范围、0.29 续第 109 条；`supabase/migrations/20261103110000_core_claim_endpoint.sql`；`supabase/functions/_shared/push/payload.ts`
- 跑过的测试：`npx vitest run`，只跑了这几个相关文件：push-claim、push、sign-out-push、account-push、safe-link、useEditRecord、tests/build/sw-push，以及 calendar、todos 下的 `__tests__`。结果是 11 个文件、154 条全部通过。另外用 node 现场核对了 `new URL()` 对各种边界写法的处理（见第四节）。没有连接真实服务，也没有读任何密钥。

---

## 结论：有条件签

浏览器推送的“换账号不会发错人”这件事，主要靠三层兜住，而且都已经到位：

1. 服务器一侧：`claim_endpoint` 的第 d 步会删掉其他账号名下、同一个 endpoint 的行（M9）。
2. 客户端退出时：退出流程会先关掉已显示的通知，再退订（FE-2）。
3. SW 一侧：显示通知前先核对 owner（FE-1），不是同一个账号就只显示 App 名。

本批没有引入能让 A 的推送内容显示给 B 看的路径。`claim_endpoint` 的入参、错误码、日志都合格；M3 也没有渲染出 HTML 的可能；`LocationText` 对危险协议的处理也合格。

不签字的理由有三条：

- 本机记下的认领结果是明文，内容是账号 id 加 endpoint 全串，而且退出时不清，这不符合 4.1 的清空范围（FA2-1）。
- 记录的键里没有会话。同一个账号重新登录后，如果浏览器里的订阅还留着，就会跳过认领，这台设备从此收不到提醒（FA2-2）。
- 在 exe 里，退出后主窗口不会整页卸载，编辑页保留下来的输入（以及整棵界面树）会一直显示，直到下一个人登录（FA2-3）。

FA2-1、FA2-2 改完、复核通过，网页这一侧就可以签。FA2-3 必须在 exe 的 A8 验收之前、第一次用 CI 打 exe 之前做完。它和 B6-exe 安全审查的 F5-2（N1 接线）是同一处改动，可以一起改。

| 范围 | 结论 |
|---|---|
| 1. 推送重订与认领（push-claim、claimEndpoint、main.tsx） | 有条件通过：FA2-1、FA2-2 |
| 2. 退出时 X-5（exe 关本机通知） | 通过 |
| 3. SW 的 M3（标题可省略） | 通过 |
| 4. LocationText / safe-link 测试 | 通过（建议 S4、S5） |
| 5. 写入被拒时只读提示、保留输入 | 网页通过；exe 有条件，见 FA2-3 |

---

## 一、必改项

| # | 问题 | 证据 | 改法 | 期限 |
|---|---|---|---|---|
| **FA2-1** | **本机认领记录存的是明文的账号 id 和 endpoint 全串，退出时也不清。** 键 `lemo.push.claimed` 的值是 `ok\n<user_id>\n<endpoint>`。退出、被移除、换账号这几条路径都不删它。文件头注释写着“退出、换账号整个 localStorage 键会被换掉”，这和实际不符：只有下一次认领成功时才会覆盖。所以 A 退出以后，这台设备的 localStorage 里还留着 A 的 user_id 和 A 曾经用过的推送地址。架构 4.1 的清空范围里，退出时不清的例外只有 `install_id` 一个（“只是随机数，不含账号信息”），这个键含账号信息，不能算例外。D1-S5 也把 endpoint 定为“不公开的地址”。另外，同源页面（`site/`、Turnstile 等）都能读到这个键。危害不大：这个订阅已经退订，推送要用 VAPID 私钥签名，正文用 auth 加密，拿到地址也发不了推送、读不到内容。但这确实是账号标识的残留，也违反了已经定下的清空口径 | `src/platform/push-claim.ts:122`（`mark`）、`:136`（`write`）；`grep CLAIM_STORAGE_KEY` 只在 push-claim.ts 和它的测试里出现；架构 4.1“退出登录或换账号”一段的“例外” | 两件事都要做：<br>① **不存明文**。存 `<state>\n<摘要>`，摘要用 `crypto.subtle.digest('SHA-256', user_id + '\n' + session_id + '\n' + endpoint)`，取 base64url 的前 22 个字符。比较时对当前值算出同样的摘要（ensure 本来就是异步的）。digest 不可用时就当作没认领，照常去认领。<br>② **退出时清掉**。在 `disconnectBrowserPush` 里，网页和 exe 两个分支都要对 `lemo.push.claimed` 做 `removeItem`（包 try/catch）。这样四条退出路径（wipeThisDevice、ensureAccount 换账号、watchAccount、wipeOnRemoved）都会经过它，不用另外接线。<br>③ 补测试：a. 存进去的值里不含 `https://`，也不含 user_id 原文；b. `disconnectBrowserPush` 之后这个键不在了；c. 把文件头注释改成和实际一致 | 网页签字前 |
| **FA2-2** | **记录的键只有“账号 + endpoint”，没有会话，同一个账号换了会话会跳过认领。** 服务器把订阅绑在“本会话那一行 devices”上（claim 的第 c、f 步），客户端的记录却只看账号和 endpoint。<br>以 A 退出时退订没成功为例：`withinMs` 2 秒超时、`getRegistration` 返回 null、退出中途关了页面，都会这样。退出第 ① 步已经把 A 的旧 devices 行删掉了。之后 A 再登录，会建一条新的 devices 行。这时 `subscribePush` 返回的还是原来那个订阅（`changed = false`），本机记录也和 `ok\nA\nE` 一致，于是直接返回 `already`，不再认领。结果是新那一行的 `push_endpoint` 一直是空的，这台设备再也收不到 A 的提醒，而且没有任何地方提示。<br>如果退出第 ① 步也失败了（比如离线），旧会话那一行还带着 E。因为没有认领，第 e 步“会话失效的同账号行直接删掉”也不会执行，这一行就一直留在表里。<br>换成另一个账号的情况，测试已经覆盖（第 70 行那条），没问题 | `src/platform/push-claim.ts:155`；`20261103110000_core_claim_endpoint.sql` 的第 c、e、f 步；`push.ts` 的 `DISCONNECT_PUSH_MS = 2000` | 记录的内容里加上会话：用 `readSessionId()` 取会话，按 FA2-1 ① 的摘要写法把它算进去；取不到会话就不跳过，照常认领。“不支持”（unsupported）的记录可以继续只按 endpoint 记，因为这个判断和会话无关，不重试的语义不变。补一条测试：同一个账号、换了 session_id、订阅没变，也要认领。<br>这条比用户的原话“按账号 + endpoint 记”多了一项会话，是**收严**，不改变“换账号就重新认领”的行为。请主持人或前端 A 确认 | 网页签字前 |
| **FA2-3** | **exe 里退出以后，主窗口不会整页卸载，编辑页保留下来的输入还显示着。** 在网页版里，`goToAuth` 走 `location.replace('/app/auth/')`，换账号走 `location.reload()`，React 状态（包括 `useEditRecord` 里的 `local`）会跟着整页卸载，不会显示给下一个人看。网页这一侧我核过，没问题。<br>exe 版的 `openAuth` 只是 `invoke('auth_window_open')` 打开登录小窗口（`desktop.ts:84`），主窗口既不导航也不隐藏（`lib.rs:94`）。`auth:done` 目前也没有调用方（B6-exe 的 F5-2 已经记了）。所以在 exe 里，A 退出（或者被移除）以后，主窗口还停在原来的页面：编辑页里被拒、保留着的输入，内存里集合的内容，都还看得见，一直到有人在小窗口登录、而且主窗口被重新载入为止。本机库清掉了，但内存里的界面没清。这一条不是本批引起的，但本批的“写入被拒时保留输入”把留在界面上的内容又多加了一类，所以在这里记为必改 | `src/platform/native-bridge.ts:67`（网页版的 replace）、`src/platform/desktop.ts:84`；`desktop/src-tauri/src/lib.rs:94-97`；`grep onAuthDone src` 没有调用方 | 在 exe 里，退出、被移除、换账号时，主窗口要先离开当前界面，可以二选一：a. 在 `openAuth` 之前（或者在 `auth_window_open` 里）把主窗口导航到一个不含账号内容的空白页或启动页，然后 `hide`；b. 在 `wipeThisDevice` 结束以后、打开小窗口之前，`location.reload()` 一次（重新启动时没有会话，就会只开登录小窗口）。`auth:done` 回调统一做 `reloadPage()`，不在原来的树上“刷新界面”。补一条测试：exe 分支在退出后会调用导航或重新载入 | exe A8 验收之前、第一次用 CI 打 exe 之前；和 F5-2 一起改 |

---

## 二、建议（不卡）

| # | 建议 |
|---|---|
| S1 | **认领要等 devices 行建好以后再发。** 现在 `ensurePushSubscription` 是在 `registerServiceWorker().then` 里发的，和 `createDeviceRegistrar` 抢主页锁、建 devices 行没有先后约束。第一次登录时很可能撞上 `device_not_found`，结果是 `claim_failed`，要等下次启动才会再认领。这不是安全问题，但第一次登录后的那段时间推送不通，而且这段时间里，旧账号的残留行（如果有）也没人去删。建议在认领之前先 `await device?.ensure()`；或者遇到 `device_not_found` 时，在本次会话里等设备登记完成后再试一次 |
| S2 | **几个标签页会同时认领。** 每个标签页启动时都会跑 ensure，服务器那边会撞上 23505，客户端下次再试，所以结果是安全的，只是请求多了。可以用 `withLock('lemo-push-claim:<user_id>')` 包一层，或者只在持锁的主页上跑 |
| S3 | **`claimEndpoint` 的入参要显式挑字段。** 现在写的是 `db.rpc('claim_endpoint', { ...args })`。TypeScript 的结构类型挡不住运行时多带的字段：调用方以后换成整个 `PushSubscription.toJSON()`，就会把 `expirationTime`、`keys` 一起发出去，PostgREST 会因为找不到函数签名而失败。建议改成 `{ endpoint: a.endpoint, p256dh: a.p256dh, auth: a.auth, label: a.label, platform: a.platform }`，再加一条单测，钉住只有这 5 个键 |
| S4 | **safe-link 测试补几个边界向量。** 这次的组件测试已经测的是真正的组件，这一点是对的。现在缺几类写法，建议补上：`//evil.com`、`https://user:pass@x/`、`https://lemomemo.com@evil.com/`、`\x00https://x/`、`https:\\evil.com`（这几条在 `tests/shared/link.test.ts` 的纯函数测试里有一部分，组件层没有）。另外断言一下：显示的文字是原文，`href` 是解析后的 href |
| S5 | **exe 里的 mailto、tel 打不开。** `LocationText` 加了 `target="_blank"`，exe 的 `new_window_external_url` 只放行 http 和 https，`mailto:`、`tel:` 在 exe 里点了没有反应（policy.rs 第 378、379 行的测试就是这样钉的）。这是功能问题，不是安全问题。可以在 exe 里对这两种链接不加 target，或者由 Rust 单独放行 |
| S6 | **认领结果的“不支持”可以定一个有效期。** 现在记成 unsupported 以后，同一个 endpoint 永远不再问。以后白名单扩大（比如加了新的推送服务主机），这台设备也不会再试。可以在记录里带上日期，30 天后重新问一次 |

---

## 三、逐项核对

### 1. 推送重订与认领

| 核对点 | 结果 | 依据 |
|---|---|---|
| 只在通知权限已经是 granted 时才订阅，不弹权限框 | ✓ | `ensurePushSubscription` 先看 `permission() !== 'granted'`，不是就直接返回 `not_granted`，不调 `subscribePush`；`pushManager.subscribe` 只有在已授权时才会被调到。测试“通知权限没给”断言了不订阅、不认领。exe 直接返回 `tauri` |
| localStorage 按“账号 + endpoint”记 | ✓（但见 FA2-1、FA2-2） | `mark(userId, ep, state)` |
| 换了账号就重新认领 | ✓ | 记录里带 user_id，不一致就认领。测试第 61、70 行：换账号后重订；换账号但订阅还留着（退订失败）时，也照样认领到新账号，服务器的第 d 步删掉旧账号那一行 |
| A 的记录会不会让 B 跳过认领 | 不会 | 同上。但同一个账号换了会话会跳过，见 FA2-2 |
| 22023 记为“不支持” | ✓ | `toFailure` 在 message 符合 TOKEN 写法时，用 message 当 code；`endpoint_not_allowed`、`bad_push_keys` 会落进 `NOT_SUPPORTED_CODES`，记为 unsupported，不重试。断网、5xx、其他错误都不记 |
| endpoint_in_use | ✓ | 不记，把 holder 交出去；holder 只有 id、label、last_seen_at、install_id，没有 endpoint 和密钥 |
| localStorage 里有没有敏感信息 | p256dh、auth 都不存 ✓；**endpoint 全串和 user_id 是明文存的，退出时也不清** ✗ | FA2-1 |
| claim 的入参只有后端允许的字段 | ✓（建议 S3） | 实际传的是 `endpointOf()` 生成的三个字段，加上 label（截到 80 字）和 platform，和 `public.claim_endpoint(endpoint, p256dh, auth, label, platform)` 正好对上；label 只按 UA 粗分，不带版本号 |
| 失败时会不会把原串带进日志 | 不会 ✓ | 后端的 raise 不带 detail、hint，也不带原串（D1-S4，六之四已经核过）；`toFailure` 只留 status、code、5 位的 sqlstate，不带服务器原文；main.tsx 里是 `void ensurePushSubscription(...)`，结果不写日志；push-claim 也不写日志 |
| 换账号、退出以后，旧账号的订阅会不会继续推给新登录的人 | 显示层面不会 ✓ | ① 退出的四条路径都会经过 `disconnectBrowserPush`（关通知、退订，2 秒上限）；② 退订失败、B 登录以后，B 认领时第 d 步会删掉 A 那一行；③ 在 B 认领之前（或者 B 没给通知权限、一直没认领），A 那一行如果还在、推送到了这台设备，SW 的 FE-1 核对 owner 时发现是 B，只显示 App 名，不带标题、正文、按键、data。剩下的风险只有“锁屏上出现一条只写着 App 名的通知”，可以接受 |
| 并发、换账号的竞态 | 可以接受 | ensure 用的是当时的会话令牌。如果在途中换成了 B，就会认领给 B，但记录里写的是 A，下次启动会再认领一次，没有危害。A 的标签页在 A 退出后才发出 claim 的话，会回 session_revoked 或 device_not_found，同样没有危害 |

### 2. 退出时 closeAllLocalReminders（X-5）

| 核对点 | 结果 |
|---|---|
| exe 分支用 `withinMs` 包住 | ✓ `isTauri` 时 `return withinMs(() => closeLocal(), ms)`。`withinMs` 把同步抛错、reject、一直不返回都兜住了，2 秒后照样 resolve。测试 push.test.ts 第 206～225 行覆盖了“只关本机通知、不碰网页推送”和“出错、同步抛、卡住都不挡退出” |
| 在退出流程里的位置 | ✓ `wipeThisDevice` 在 ② 设闸清库之后、按库名删库之前调用。sign-out-push.test 钉住了先后顺序；account.ts 的三条路径也接上了 |
| `closeLocal` 的默认值 | ✓ 调用时才取 `closeAllLocalReminders`，用的是那一刻的桥（装好 exe 的桥之后就是 exe 版） |

### 3. SW 的 M3

| 核对点 | 结果 |
|---|---|
| 不带标题时显示 App 名 | ✓ `title` 是 `undefined`、`null`、`''` 时都当作 null，`notificationOf` 用的是 `p.title ?? appName`；类型不对（不是字符串）时整条负载拒收，走兜底 |
| 会不会渲染出 HTML 或地址 | 不会 ✓。`showNotification` 的 title 和 body 都是纯文本，不解析 HTML；负载类型里本来就没有地址和图片字段，icon、badge 是固定的 `/app/icons/icon-192.png`，打开的地址只来自 `reminderUrl(...)` 或 `/app/`（FE-3、FE-4）。body 截到 300 字；服务器在 `payload.ts` 里已经把 C0 控制字符换成空格。`push_show_title` 关着的时候，服务器只写“15:00 有 1 项日程”这类通用正文（架构 5.3），SW 不会自己补出标题 |
| owner 不一致时 | ✓ 先过 FE-1 再决定显示什么，M3 没有改动这一段的顺序 |

### 4. LocationText

先用 node 现场核对 `safeHref`（和组件里用的是同一个函数）对各种写法的处理：

| 写法 | 结果 | 判断 |
|---|---|---|
| `javascript:`、`  JaVaScRiPt:`、`java\tscript:`、`\x01javascript:` | 拒，显示成文字 | ✓（组件测试已覆盖） |
| `data:`、`vbscript:`、`file:` | 拒 | ✓（组件测试已覆盖） |
| `//evil.com`（协议相对地址） | `new URL` 没有 base 会抛错，拒 | ✓（纯函数测试已覆盖，组件测试没有，见 S4） |
| `https://user:pass@x`、`https://lemomemo.com@evil.com/` | 拒 | ✓ |
| `https://@x.com`、`https://:@x.com` | 放行，href 是 `https://x.com/` | 可以接受：用户名、密码都是空的，实际去的主机和看上去的一样 |
| 前导空白、前导控制字符 `\x00https://x` | 放行，href 是去掉这些以后的规范地址 | 可以接受：协议照样按解析结果判断，去的主机和显示的一样 |
| `https:\\evil.com`、`https:evil.com`、`HTTPS://X.COM` | 放行，规范成 `https://evil.com/` 等 | 可以接受：显示的文字就是用户自己输入的内容，主机也没有变 |
| `tel:javascript:alert(1)` | 放行，协议是 tel | 可以接受：交给拨号程序处理，不会执行脚本 |
| 主机里带 bidi 控制字符 | 解析失败，拒 | ✓ |

| 核对点 | 结果 |
|---|---|
| 只有通过 safeHref 的才渲染成 `<a>` | ✓ `href={safeHref(text)}`，用的是解析后的 href，不是原文；不用 innerHTML |
| 在新窗口打开，带 noopener noreferrer | ✓ `target="_blank" rel="noopener noreferrer"`，测试也断言了 target |
| safe-link.test 测的是真正的组件（TC-B2-02、SAFE-link-real） | ✓ 去掉了原来测试里自己写的一个最小组件，改成 import `../LocationText.tsx` |
| 使用的地方 | 编辑页 `EventEditPage.tsx:177` 只把它当作输入框下面的 hint 显示；地点内容是用户自己的数据，不存在别人输入、在这里显示的情况。exe 里新窗口打开的链接会经 `new_window_external_url` 再过一次白名单 |

### 5. 写入被拒时只读提示、保留输入

| 核对点 | 结果 |
|---|---|
| 被拒时出只读提示 | ✓ `OutboxRejectError('readonly_row')` 转成 `readonly`，两个编辑页都会显示 `*.edit.st.readonly`，并且放进 BAD 集合，用红色状态显示 |
| 保留输入 | ✓ 只有保存结果是 `saved` 时才 `setLocal(null)`，其他结果都保留；序号 `seq` 保证只认最后一次写入，前一次回来的结果不会清掉后一次的输入 |
| 保留的输入存在哪里 | 只在 React 的内存状态里，不写 localStorage、sessionStorage、IndexedDB（grep `src/features`、`src/kit` 都没有新的存储写入）✓ |
| 换账号后会不会显示给下一个人 | 网页：不会 ✓（`goToAuth` 走 `location.replace`，换账号走 `location.reload`，整页卸载）。exe：**会**，见 FA2-3 |
| `edit-save.ts` 的错误处理 | ✓ 只把 `OutboxRejectError` 转成码，其他异常照原样抛出，不吞；不把原值写进日志 |

---

## 四、复核方法（给前端 A）

- FA2-1：`grep -n "lemo.push.claimed" src`，确认退出路径里有 removeItem；跑 push-claim 测试时打印存进去的值，确认里面不含 `https://`、不含 user_id 原文。
- FA2-2：新加的测试“同一个账号、换了 session_id、订阅没变也要认领”能跑通。
- FA2-3：exe 分支退出后有导航或重新载入的测试；接 F5-2 的时候，`auth:done` 的回调是 `reloadPage()`。

## 采纳情况（主持人，11-03）

- FA2-1：交前端 A 必改。本机只存 SHA-256 摘要（user_id + session_id + endpoint），`disconnectBrowserPush` 里删掉这个键，补测试，改正注释。
- FA2-2：采纳，记录里加上 session_id，取不到会话就照常认领。“按账号 + endpoint 记”是主持人派活时的写法，不是负责人的原话；加上会话是收严，主持人同意，不用再问负责人。
- FA2-3：和 B6-exe 安全审查 F5-2（N1 接线）一起改：退出时主窗口重新载入，或者先导航到空白页再隐藏；`auth:done` 的回调统一做 `reloadPage()`。期限同 F5-2：A8 验收前、CI 第一次打 exe 之前。
- S1：并进后端新增的 `device_not_found` 处理一起做，先建本会话的 devices 行再认领，遇到 `device_not_found` 记为“稍后重试”。
- S2、S3、S4、S6：交前端 A 本批一起改。
- S5（exe 里 mailto、tel 点了没反应）：属于功能问题，交前端 B 在 exe 外链处理里看。
- 等代码审查结论回来后，合在一起交给前端 A。

## 复核（11-03，同一审查员）：S7 与推送“完成”

**结论：S7 理解正确、实现无问题；`{type:'done', due_at}` 无越权或伪造路径。剩 1 条必改 FA2-4。**
- S7 出处：上一轮只写在给主持人的回报里，没有落盘。原意是 push-dispatch 每分钟跑一次，刚过一两分钟的提醒可能还没推出，撤销写入也要尽快送上服务器。前端 A 把“改之后”也按 now − 2 分钟算，更严，只多一种 [now − 2 分钟, now) 提前发的情况，可接受。`remindLive` 只在 `src/core/remind-flag.ts` 定义一次，四处页面共用。
- done 链路：只有 SW 在 notificationclick 里写，负载必须是待办且带 done 按钮；只写已存在且 owner 一致的库，6 个字段；页面 isValidPendingAction 只认 todos、UUID、正安全整数，keepPendingAction 限当前账号和 24 小时；上服务器经 outbox 和 RLS。
- 留给 FA-4：done 转写入前核对行存在、未删未完成、due_at 对上当前这次到点，对不上丢弃，并钉测试。
- **必改 FA2-4**：`tests/build/sw-no-user-data.test.ts` 掉 2 条——push.ts 单行写法让“只有 6 个字段”的正则一处都匹配不到；push-actions.ts 引了不在白名单的 notify-text.ts。改法见代码审查 N3，断言不许删。期限：这一批合并之前。
- FA2-3（exe 退出后主窗口仍显示）期限照旧，在 exe A8 验收前。

**采纳（主持人，11-03）**：FA2-4 交前端 A，与代码审查 N3 一起改。

## 复核二（11-03，同一审查员）：FA2-4

**结论：通过，FA2-4 关闭。** 本批 SW 推送部分没有剩余必改。
- `shared/logic/notify-actions.ts` 无任何 import（测试锁住），notify-text.ts 从它转出；后端生成目录已有副本。
- 白名单加 notify-actions.ts 和 ./push-actions.ts，没加 notify-text.ts 并注明原因；push-actions.ts 在白名单和 IndexedDB 次数检查范围里。
- push.ts 写 pending 改回多行，正好 6 个顶层字段，测试断言正好一处调用，补三个反例。
- `PendingDone` 的 TODO(FA-4) 写明 due_at 核对条件。
- 仍开着：FA2-3（期限 exe A8 验收前）、FA-4 接 toEnqueue 时的 due_at 核对。
- 跑过：sw-no-user-data、sw-push、sw-push-actions、sw-pending 79 条通过。只读。
