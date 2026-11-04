# B2 安全审查：FA-6 首屏减重 ①（告知页关口 noticeState 改成 REST 快读）

- 审查日期：2026-11-04
- 审查人：独立安全审查员（只读，默认不通过）
- 范围（工作区未提交）：
  - `src/features/onboarding/data/consent-api.ts`（`tokenExpMs`、`getOne`、`createRestNoticeRead`、`judgeNotice`、`noticeState` 的 `fastRead` / `envReady`）
  - `src/features/onboarding/hooks/useConsentWiring.ts`（接线：`buildInfo`、`appFetch`、`readSessionAccessToken`、`REFRESH_MARGIN_MS`）
  - `src/features/onboarding/ui/ConsentGate.tsx`（ConsentPage 改懒加载）
  - `src/features/onboarding/__tests__/consent-notice-rest.test.ts`（新）
  - `tests/e2e/b2-first-screen-supabase.spec.ts`（新）
  - 顺带看了相关的 `src/platform/session.ts`（`onAuthUser` 改成等 `afterAppPainted`）、`src/platform/first-paint.ts`、`src/platform/http.ts`、`functions/sb/[[path]].ts`、`src/_headers`、RLS（`prof_sel`、`cfg_sel`）

## 总分：8.5 / 10 —— 通过

没有高、中问题。快读的成功结果只在“两张表都 2xx、都是长度不超过 1 的数组、字段类型对”时才采用，判定函数 `judgeNotice` 和 supabase-js 那条路共用，结果一致。所有失败分支都退回原来的路径，或者按读失败放行（这是原来就定好的设计：服务器端没有同意记录就不送 AI）。令牌只放在请求头里，不进 URL、日志或错误信息。CSP 不用改。下面几条低问题属于加固和补测试，不挡合入。

---

## 逐项结论

### 1. 令牌怎么读

- 来源：`readSessionAccessToken()`（`src/platform/session.ts:111-122`）经 `sessionStore()` 读。网页版读 localStorage，exe 读凭据管理器的同步覆盖层；还没装上时是 `EMPTY`，读出 null，于是退回 supabase-js。键名由 `sessionStorageKey(buildInfo.supabaseUrl)` 算出，固定是 `sb-<主机名第一段>-auth-token`（正式版是 `https://lemomemo.com/sb`，算出 `sb-lemomemo-auth-token`）。只有地址解析不出时才按格式扫键（`findKey`，`session.ts:38-46`）。正式版、预览版、exe 配的都是绝对地址，不会走到扫键那一支。
- 只取 `access_token` 这个字符串，和 supabase-js 下一次请求带的是同一份。
- 别的账号：令牌属于谁，由服务器验签以后的 `auth.uid()` 决定，RLS 只给那个人的行。本机存的是谁，supabase-js 那条路用的也是谁，两边一样。
- 过期：`tokenExpMs` 只解 payload 里的 `exp`，离过期不到 `REFRESH_MARGIN_MS`（60 秒）、已经过期或解不出来，都不发请求，直接退回（`consent-api.ts:178-179`）。
- 被篡改：改 payload 里的 exp 会让签名失效，服务器回 401，代码回 null，退回 supabase-js。客户端不校验签名，也只拿 exp 来决定“发不发”，篡改值本身不会变成放行的依据。
- 日志、错误、URL：令牌只出现在 `Authorization` 头（`consent-api.ts:163`）；URL 里只有固定的 path 和 query。`createRestNoticeRead` 里所有异常都被 `catch` 吞掉、回 null（`:189-191`），不打印、不往外抛。`appFetch` 包出的 `NetworkUnreadableError` 只在 `cause` 里留原错误，这里也被吞掉了。

### 2. 请求本身

- URL：`${supabaseUrl 去掉末尾斜杠}/rest/v1/` 加两条写死的 path（`consent-api.ts:162`、`:182-183`）。`supabaseUrl` 是构建时的常量（`VITE_PUBLIC_SUPABASE_URL`），没有任何运行时输入拼进 URL，不能注入。
- 目的地：只发往配置的 supabase 地址。正式版走同源的 `/sb` 转发层，它的白名单里有 `/rest/v1/`（`functions/sb/[[path]].ts:28`）。
- 只拿本人那一行：`profiles?select=consent_policy_ver` 没带 `user_id` 过滤，靠 RLS `prof_sel`（`user_id = auth.uid() and private.not_password_session()`，`supabase/migrations/20261029191000_auth_password_session.sql:185`）收窄到本人。这和 supabase-js 原来那条 `.from('profiles').select('consent_policy_ver').maybeSingle()` 完全相同。返回多于一行时代码回 null（`:168`），不会挑其中一行来用。
- 字段：`select=consent_policy_ver`、`select=notice`，只拿这两列。`app_config` 的 `cfg_sel` 本来对 anon 也开放，不是敏感数据。
- apikey：用的是 `buildInfo.anonKey`（`VITE_PUBLIC_ANON_KEY`），也就是 supabase-js 本来就打进包里的那个公开 anon key，没有带进新的密钥。（`.env` 的真实值按规矩没读。）

### 3. 判定是否安全（会不会让本该看告知页的人跳过）

- 采用快读结果的条件（`consent-api.ts:185-188`）：
  - 两张表都是 `res.ok`；
  - 返回体都是数组，而且长度不超过 1；
  - 行要么是 null，要么是对象；
  - `consent_policy_ver` 是 null 或字符串；
  - `app_config` 的行里有 `notice` 这个键。
- 不满足其中任何一条（缺字段 undefined、版本是数字、2xx 却不是 JSON 让 `res.json()` 抛错等），都回 null，退回 supabase-js。不会出现“形状不对却当成已同意”。
- 两边归类对照：

  | 读到的情况 | supabase-js 原路径 | 快读 |
  |---|---|---|
  | 没有 profile 行（含密码会话被 RLS 挡掉） | `data: null`，判 `first` | `[]`，判 `first` |
  | `consent_policy_ver` 是 null 或 `""` | `first` | `first` |
  | 本人版本低于 `min_consent_ver` | `updated` | `updated` |
  | 没有 `app_config` 行或 `notice` 是 null | `none` | `none` |
  | 版本不是字符串 | 进 `policyVerAtLeast` 后判 `updated` | 回 null，退回原路径，同样得 `updated` |

  两边都走同一个 `judgeNotice`（`:207-213`），结果一致。
- 401、403：快读不认错误码，一律回 null 退回（`:166`）。不会在这里被当成“账号被移除”。另外，`useNoticeState` 把 noticeState 的所有失败都收成 `'error'`，然后放行（`useConsentWiring.ts:72-75`）。关口这一处本来就不会因为 revoked 去调用 leave，所以 401 的归类不会把人踢出登录。
- 吊销了但还没过期的 JWT：PostgREST 照样认，`prof_sel` 也不查会话是否还活着。这和原路径一样（supabase-js 在令牌没快过期时不会刷新），不是这次引入的。

### 4. 超时不退回

- `noticeState` 的超时是 `slowMs`（8 秒）。到点时 `ctl.abort()`（不带参数，按 `http.ts` 的约定，抛出的是 AbortError，不会被当成网络错误），中断快读。快读抛错后回 null，接着 `if (ctl.signal.aborted) return ERR('offline')`，不再加载 supabase-js（`consent-api.ts:271-273`、`:282-285`）。
- 实际上关口自己的上限 `CONSENT_GATE_MS` 是 5 秒，比它更早：到点按 `'error'` 放行，后来的结果丢掉。
- 不会卡住：两个计时器都会触发，`useNoticeState` 一定会落到某个结果。
- 会不会放行：超时放行是原有设计（CONSENT-sugg ①），不是这次新增的。这次的变化是：快读失败再退回，比原来多一次往返，在“401 后退回”“一张表很慢”这类情况下，碰到 5 秒上限的概率略高（见低问题 L2）。被放行的人在服务器上仍然没有同意记录，AI 不会送；下次打开还会再问。

### 5. CSP、connect-src

- 网页版 `/app/*`：`src/_headers:9` 是 `connect-src 'self' {{WSS}}`，正式版的 supabase 地址是同源 `/sb`，`'self'` 已经覆盖。
- exe：`desktop/src-tauri/tauri.conf.json:15` 已含 `https://lemomemo.com`；预览版 `tauri.preview.conf.json:8` 已含 `https://preview.lemomemo.com`。
- 快读和 supabase-js 发往同一个源、同一批 path，**CSP 不用改**。`src/index.html` 没有 CSP meta，CSP 由 `_headers` 和构建脚本 `build/assemble_web.mjs` 管。
- SW：`src/sw/routes.ts:28` 规定 `/sb/*` 一律直连、不缓存，快读同样适用。

### 6. 测试覆盖

单元测试（`consent-notice-rest.test.ts`）已覆盖：

- 请求的 URL 和请求头；
- 空数组、null；
- 形状不对的 5 种情况；
- 401、403、500（每张表各一次）；
- 网络错；
- 令牌快过期、已过期、不是 JWT、payload 解不出、没有令牌；
- 没有地址或 anon key；
- 快读成功时不碰 supabase-js；
- 快读回 null 时退回原路径；
- 超时会中断请求，而且不退回；
- `envReady` 为假时回 unknown，和原来的 `supabase_env_missing` 归类一样。

缺口见低问题 L4、L5。

---

## 问题清单

### 高

无。

### 中

无。

### 低

**L1 `src/features/onboarding/data/consent-api.ts:162-165`：请求没写 `cache: 'no-store'`，也没写 `redirect: 'error'`**

- 场景：浏览器 HTTP 缓存按 URL 存，不按 Authorization 分。两个账号的这对请求 URL 完全一样。如果哪天转发层或上游给这对 GET 回了可缓存的头（比如加了 `Cache-Control: max-age`、`Last-Modified`），同一个浏览器换账号后，B 可能读到 A 那一行的 `consent_policy_ver`，于是跳过告知页。
- 现状：转发层透传的响应没有强制写 `no-store`（只有本地错误回的是 `no-store`，`functions/sb/[[path]].ts:106`）；PostgREST 默认不发验证器，现在实际不会被缓存。原来 supabase-js 那条路也有同样的前提，所以不是这次新增的风险。
- 建议：在 `getOne` 的 init 里加 `cache: 'no-store'`；同时加 `redirect: 'error'`，不跟随 3xx 把带 Bearer 的请求转到别处。这个函数是新写的，加这两项成本很低。

**L2 `src/features/onboarding/data/consent-api.ts:181-185`：一张表先失败，仍要等另一张表回来，才退回 supabase-js**

- 场景：`profiles` 很快回 401（比如本机时钟慢、令牌其实已过期），`app_config` 却很慢。`Promise.all` 要等两边都完成，退回 supabase-js 的时间被推迟。再加上加载 supabase-js、重新请求，更容易碰到 5 秒关口上限，结果本该看到 `first` 的新用户被按读失败放行（服务器端仍不送 AI，下次打开再问）。
- 建议：任何一张表回 null 时立刻中断另一张、马上退回。比如用一个内部 AbortController 把它和外面传进来的 signal 连起来，`getOne` 回 null 时 abort 另一张；或者把 `getOne` 的 null 改成 reject，让 `Promise.all` 立刻落地。

**L3 `src/features/onboarding/hooks/useConsentWiring.ts:38`：新鲜度用 `Date.now()`，没用经过服务器校正的 `clock.now()`**

- 场景：本机时钟比服务器慢时，已经过期的令牌会被当成“还新鲜”，白发一对请求、拿到 401，再退回（多一次往返，和 L2 叠加）。本机时钟快时，新鲜的令牌被当成过期，直接退回，只是少省了一次加载，不影响安全。
- 现状：和同步层 `sync-transport.ts:171`、`:213` 的口径一致，也和 supabase-js 自己的判断一致，所以不会出现两边判断不一的情况。
- 建议：可以不改。要改就把 `now` 换成 `clock.now()`，但同步层要一起改，保持同一口径。

**L4 `src/features/onboarding/__tests__/consent-notice-rest.test.ts`：几条失败分支没有单测**

- 缺 2xx 但返回体不是 JSON（`res.json()` 抛错）的用例。代码在 `:189` 已经兜住，没有测试锁定。
- 缺“快读回 null 之后 supabase-js 那边报错”的用例（例如 401 应得 `revoked`、网络错应得 `offline`），用来证明退回以后错误归类和原来一样。目前只测了退回以后成功的情况。
- 缺“一张表 2xx、另一张挂住，到超时”的用例。现在的超时用例是两张都挂住。
- 缺令牌里有非法头字符（`new Headers` 抛 TypeError）的用例。代码会兜住、回 null，同样没有测试锁定。
- 建议：补上这四条，每条一两行。

**L5 `tests/e2e/b2-first-screen-supabase.spec.ts:73-79`：默认的假后端 e2e 构建里，快读分支根本没跑**

- 场景：默认 e2e 构建没配 supabase 地址，`envReady` 为假，第一条用例走 `else` 分支，只断言“没发 notice 请求”。所以 CI 里快读的请求头、目的地、计数，在 e2e 层面一次都没验证过。另外 `bearer` 只查了 `startsWith('Bearer ')`，没查 `apikey` 头，也没查请求是不是只发往同源 `/sb`。
- 第二条用例是 `fixme`。文件头写明了原因：等 main.tsx 推迟 wireSync。这一点交付时应写进待办，不能当成已经验证过。
- 建议：
  - 在一个配了 `VITE_PUBLIC_SUPABASE_URL=<同源>/sb` 的 e2e 构建里跑这条用例（e2e-real 或单独一个模式），用 annotation 确认走的是 `fast-read`；
  - 断言里补上 `apikey` 头，以及请求的 origin 等于 `baseURL`。

---

## 我跑了哪些命令、结果如何

| 命令 | 结果 |
|---|---|
| `$env:TZ='Asia/Seoul'; npx vitest run src/features/onboarding`（PowerShell） | 8 个文件、104 条全部通过（2.21 s） |
| `$env:TZ='Asia/Seoul'; npx vitest run src/platform/__tests__/session src/platform/__tests__/http src/platform/__tests__/first-paint` | 8 个文件、81 条全部通过（3.63 s） |
| `git diff -- src/features/onboarding src/platform/session.ts`、`git status --short` | 确认改动范围：上面 5 个文件，加上 `session.ts`、`first-paint.ts`（新） |
| 用 grep 查看 `src/_headers`、`desktop/src-tauri/tauri*.conf.json`、`functions/sb/[[path]].ts`、`supabase/migrations`（`prof_sel`、`cfg_sel`）、`.github/workflows/*`（`VITE_PUBLIC_SUPABASE_URL` 的取值）、`src/sw/routes.ts` | 结论见上面第 2、5 节 |

审查期间没有改动任何代码文件，没有 git add，没有连库，没有构建，没有跑 e2e，没有读 `.env` 的值。本文件是唯一新建的文件。

---

## 复审（2026-11-04，第二轮）

- 审查人：同一位安全审查员（只读，默认不通过）
- 本轮改动：
  - `consent-api.ts`：改了 `getOne` 和 `createRestNoticeRead`；
  - 单测补了 L1、L2、L4 对应的用例；
  - `main.tsx`：`await appPainted()` 之后紧跟 `if (boot.switching) return;`；
  - `session.ts`：改成 `afterAppPainted → whenIdle → getSupabase`；
  - `sync-wiring.ts`：频道建好以后补读一次本机库；
  - 新增 `playwright.fastread.config.ts`，`ci.yml` 加了 `npm run e2e:fastread`，e2e 补了 apikey 和同源断言。
- `push-claim-run.ts`（上下文没就绪时最多等 10 秒、换账号时设 null）前端 A 还在改，这一轮不审，等改完再看。

### 复审总分：9 / 10 —— 通过

没有高、中问题。上一轮 5 条里，L1、L2、L4 已解决，L3 按原建议保留，L5 大部分解决（还剩一处缺口）。新改动带出 3 条低问题（L6–L8）。

### 上一轮意见逐条复查

| 编号 | 上一轮意见 | 本轮状态 | 依据 |
|---|---|---|---|
| L1 | 没有 `cache: 'no-store'`、`redirect: 'error'` | **已解决** | `getOne` 的 init 两项都加了（`consent-api.ts`，`getOne` 内）；单测断言 `c.init.cache === 'no-store'`、`c.init.redirect === 'error'`。变异 M3、M4（各删一项）都被测试抓住 |
| L2 | 一张表失败还要等另一张 | **已解决** | 改成 `NoticeReadMiss` 抛错，加上内部的 `own` AbortController：任何一张失败就 `stop()` 中断另一张；外面传进来的 signal 也接到 `own` 上，`finally` 里解除监听。新单测“一张表读不了：立刻中断另一张”。变异 M1（去掉 `stop()`）被抓住 |
| L3 | 用 `Date.now()`，没用 `clock.now()` | **保留**（上一轮写的就是“可以不改”） | 和同步层、supabase-js 的口径一致，不影响安全 |
| L4 | 4 个失败分支没有单测 | **已解决** | 新增 4 条：2xx 但不是 JSON；令牌里有非法头字符；快读回 null 以后 supabase-js 报错的归类（401 → revoked 带 sid、网络错 → offline、account_disabled → disabled）；一张表 2xx、另一张挂到超时 |
| L5 | e2e 在 CI 里没跑到快读分支，也没断言 apikey 和目的地 | **大部分解决** | 新增快读组：构建带同源 `/sb` 地址和假 anon key，CI 跑 `e2e:fastread`；每个请求都断言 Bearer、apikey 等于构建里的值、只发往同源 `/sb/rest/v1/`。还剩一处缺口，见新 L8 |

### 新改动的安全检查

**① 换账号窗口里会不会用旧账号的令牌**（`src/app/main.tsx:208-211`）

- `await appPainted()` 之后马上检查 `boot.switching`。之后的 `createSupabaseTransport`、`createDeviceRegistrar`、`wireSync`、`setPushClaimContext`、`registerServiceWorker` 都在这道检查之后同步创建，中间没有别的 await。
- 令牌和 sid 都是用到时才读（`readSessionId()`、`readSessionAccessToken()`），不会在等待之前先缓存下来。
- `watchAccount` 在 render 之前就挂好了（`main.tsx:171-185`），等待期间换账号会同步调 `closeGate`，设上闸。
- 所以，凡是 storage 事件已经送到的情况，后面的步骤都不会用旧的 userId 去配新会话，也不会用旧会话去配新库。剩下的一个小窗口见新 L6。
- 推送认领（`runPushClaim`）在 SW 注册的 `.then` 里，是异步的。它拿到的上下文怎么处理“换账号时设 null”，等 `push-claim-run.ts` 改完再审。

**② `session.ts`：首屏画完以后才加载 supabase-js**

- 只推迟了“没人用时主动加载”这一次。谁先建出客户端，`onClientReady` 就在那一刻同步挂上 `onAuthStateChange`，SIGNED_OUT 不会漏掉。
- 首屏有兜底时限：`watchAppPainted` 的长兜底，加上 `startAppPaintLimit(GATE_LIMIT_MS + 1000)`，所以订阅不会一直不挂。
- 这一处没有新的安全问题。

**③ `sync-wiring.ts`：频道建好以后补读一次**

- 只是重读本机库（`outbox.refresh`、`reloadCollections`），再给主页发一条提醒。前后都检查 `boot.switching`，不联网，不碰令牌。
- 没有新的安全问题。

**④ CI 里的假密钥会不会被当真**

- `FAKE_ANON_KEY = 'fake-anon-key'`（`tests/e2e/fake-values.ts:12`），地址是 `http://127.0.0.1:8791/sb`。请求只发到本机的 wrangler，转发层再转给假后端（假后端的 `SUPABASE_ANON_KEY` 也是这个假值），碰不到真服务器。
- 快读组用 `--mode e2e` 构建，产物放在 `dist/web-fastread`。
- 正式版、预览版构建不许设 `LEMO_WEB_OUT`（`build/assemble_web.mjs` 的 `buildEnvErrors`）；正式版的 `VITE_PUBLIC_SUPABASE_URL` 指向本机会直接报错。发布流程只上传 `dist/web`。
- 失败时上传的报告目录里只有假值。
- 所以假值进不了正式产物，也不会被当成真密钥。正式版构建没有专门拦 `fake-anon-key`；不过它总是和本机地址一起出现，而本机地址已经被拦住了。我把这一点记作信息项，不单独算问题。

**⑤ 快读产物有没有带出真实地址**

- CI 的 e2e job 没设 `VITE_PUBLIC_*`；仓库根目录和 `src/` 下都没有 `.env*` 文件。所以 CI 产物里只有本机地址和假 key。
- 但配置用的是 `??=`：本机 shell 里已经 export 了真实值的话，会沿用真实值，见新 L7。

### 新问题

#### 高

无。

#### 中

无。

#### 低

**L6 `src/app/main.tsx:211`：等首屏的这段时间，只看 `boot.switching`，没有同步再比一次会话**

- 场景：别的标签页在这几秒里登录了 B。localStorage 已经同步改了，但 storage 事件要排一个任务才送到本页。如果 `appPainted` 恰好在事件送到之前落地，`boot.switching` 还是 false，后面就会照常创建：
  - `createDeviceRegistrar`（锁名用 A 的 userId，`sessionId()` 读到的却是 B 的会话）；
  - `wireSync`；
  - `setPushClaimContext`（userId 是 A，令牌是 B）。
- 下一个任务里 `watchAccount` 收到事件，设闸、重新载入。sync-wiring 各处也都看 `boot.switching`，所以影响有限。最可能出现的是一次设备登记或认领发出去以后才被拦下。服务器按令牌认人，不会把数据写进 A 的账号。
- 建议：照 render 之前那道检查的写法，在这里再同步比一次。

  ```ts
  if (boot.switching || readSessionUserId() !== userId) return;
  ```

  也可以直接调用 `watchAccount` 暴露的同步 check。补一条单测：等待期间改 storage，但不派发事件。

**L7 `playwright.fastread.config.ts:17-20`：环境变量用 `??=`，本机 shell 里有真实值时会被沿用**

- 场景：开发者本机 export 过 `VITE_PUBLIC_SUPABASE_URL` / `VITE_PUBLIC_ANON_KEY`（比如刚跑完 `e2e:real` 或发布脚本）。快读组构建会带进那个地址（公开 anon key 本身不算机密）。页面画完以后，同步、auth 等没被 `page.route` 拦下的请求，会带着假会话令牌发往那个地址：
  - 真后端组的本机地址，会打乱那一组的状态；
  - 正式地址的话，会在真服务器上留下 401 日志。
- 用例里的 `sameOrigin` 断言会让这一轮失败，所以不会悄悄通过。但请求已经发出去了。
- 建议：
  - 这 4 个变量改用 `=` 强制设置，至少地址这一项要强制；
  - 或者在配置里断言地址的主机是 `127.0.0.1`、key 等于 `FAKE_ANON_KEY`，不是就直接 throw。

**L8 `tests/e2e/b2-first-screen-supabase.spec.ts:88-94`、`:58-62`：快读组没断言“走的是快读”；4xx 成功判定没有测试锁住**

- e2e：快读组里如果构建意外没带上地址（`envReady` 为假），用例走 `else` 分支照样通过。另外，快读和退回以后 supabase-js 发的 URL 一模一样，只看计数分不出来走的是哪一条。
  - 建议：快读组里（用环境变量判断）强制要求 `hits.profiles > 0`。再断言请求没有 supabase-js 才带的 `x-client-info` 头，证明是快读发的。
  - 注释写的假值是 `fake-anon-key-e2e-only`，实际是 `fake-anon-key`，顺手改一下。
- 单测：变异 M5 把 `if (!res.ok)` 改成 `if (res.status >= 500)`（4xx 也当成功），17 条全过，没有一条抓住。原因是现有 401/403 用例的返回体都是对象，被“不是数组”那一关先拦下了。
  - 风险方向：4xx 却回一个数组体（比如转发层或网关的异常响应回了 `[]`），app_config 会被当成“没有 notice”，判成 `none`，本该看到的“隐私说明更新了”那一屏就被跳过。现实中很少见，但这正是要锁住的那条线。
  - 建议：补一条“401 / 403 + `[]` 返回体”的用例，期望回 null。

### 本轮跑的命令和结果

| 命令 | 结果 |
|---|---|
| `$env:TZ='Asia/Seoul'; npx vitest run src/features/onboarding src/platform/__tests__/session src/platform/__tests__/first-paint src/app/__tests__/first-paint-wiring.test.ts src/app/__tests__/sync-tabs.test.ts`（共享工作区，只读） | 19 个文件、200 条全部通过 |
| 独立副本（草稿目录 `scratchpad\mut`：复制 `src`、`shared`、配置文件，`node_modules` 用联接）里跑 `consent-notice-rest.test.ts` 作基线 | 17 条全部通过 |
| 同一副本里用 `python -I mut.py` 做 9 个变异，每个都跑一遍上面那份测试 | M1（失败时不中断另一张）、M2（多于一行也接受）、M3（去掉 no-store）、M4（去掉 redirect error）、M6（版本类型不查）、M7（超时后仍退回）、M8（不看过期余量）、M9（notice 键不查）都被抓住；**M5（4xx 当成功）存活**，见 L8 |
| `cmp` 对比副本还原后的文件和共享工作区的 `consent-api.ts` | 一致，共享工作区没被改动 |
| 用 grep 查看 `main.tsx`、`core/account.ts` 的 `watchAccount`、`sync-wiring.ts`、`playwright.fastread.config.ts`、`ci.yml`、`package.json`、`build/assemble_web.mjs` 的 `buildEnvErrors` 和 `webOutDir`、`tests/e2e/fake-values.ts`、e2e 用例 | 结论见上文 |

本轮除了在这份记录末尾追加这一节，没改任何文件；变异只在草稿目录的副本里做。没有 git add、连库、构建或跑 e2e，没读 `.env` 的值。

---

## 第二轮复审（2026-11-04）

- 审查人：同一位安全审查员（只读，默认不通过）
- 编号说明：主持人这一轮说的“L3”，是推迟启动审查里推送认领那一条（等上下文最多 10 秒），不是本记录第一轮的 L3（`Date.now()`）。本记录的 L3 已按“可以不改”保留，这一轮不再动。下面推送认领那一条写作“推迟启动 L3”。
- 本轮审查的改动：
  - `src/platform/push-claim-run.ts`：新增 `expectPushClaimContext`、`PUSH_CLAIM_WAIT_MS`，等上下文的逻辑在 `contextSoon`；
  - `src/app/main.tsx:187`、`:215-218`；
  - `playwright.fastread.config.ts:17-20`；
  - `tests/build/e2e-ports.test.ts:226`；
  - `tests/e2e/b2-first-screen-supabase.spec.ts:32`、`:67-68`、`:94`、`:129`；
  - `consent-notice-rest.test.ts:100-104`；
  - `src/app/sync-wiring.ts` 补读后再看换账号闸（N2）。
- `src/core/sync/reload.ts` 的并发写入修正属于代码审查范围，这里只确认它不碰令牌、不联网，没有细审。

### 第二轮复审总分：9 / 10 —— 通过

没有高、中问题。L6、L7、L8 已解决，推迟启动 L3 的等待逻辑正确。另有一条本轮之前就存在的低问题 L9（上下文设好以后才发生换账号）。“退出、换账号时设 null”只在 main 的启动这一处做到了，建议补上。

### 逐条复查

| 编号 | 本轮状态 | 依据 |
|---|---|---|
| L6 | **已解决** | `main.tsx:215` 改成 `if (boot.switching \|\| readSessionUserId() !== userId) { setPushClaimContext(null); return; }`。这次是同步读 storage，不用等 storage 事件送到本页，上一轮说的那个小窗口关上了。检查和后面的 `setPushClaimContext({...})`（`:250`）之间没有 await |
| L7 | **已解决** | 4 个环境变量都改成 `=` 强制设置。`e2e-ports.test.ts:226` 锁住了“shell 里预设真实值也会被覆盖成本机假值” |
| L8 ① | **已解决** | `EXPECT_FAST = Boolean(process.env.VITE_PUBLIC_SUPABASE_URL)`。快读组里强制 `hits.profiles > 0`（`:94`、`:129`），并且每个快读请求都断言没有 `x-client-info`（`:67-68`），能把快读和 supabase-js 退回分开。默认组的 `VITE_PUBLIC_SUPABASE_URL` 为空，走原来的分支 |
| L8 ② | **已解决** | 补了 401/403 加 `[]` 的用例：只有 profiles、只有 app_config、两张都是，各一条。上一轮存活的变异 M5（4xx 当成功），这一轮被抓住了 |
| 推迟启动 L3 | **逻辑正确**（另见下面的 L9） | 见“推送认领等上下文”一节 |

### 推送认领等上下文（主持人点名的两点）

**① 等待中的认领，会不会在换账号后用“新账号的令牌 + 旧账号的 userId”去认领**

- 等待中的认领只在两种情况下醒来：
  - `setPushClaimContext(...)`；
  - 10 秒到点（`contextSoon`）。
- main 只在两处调它，前面都紧挨着 L6 的同步检查（`:215`）：
  - 换账号、退出时传 null，等着的认领拿到 null，回 `claim_failed`，不订阅也不认领；
  - 账号没变时传 A 的上下文。那一刻 `readSessionUserId() === userId`，令牌也是 A 的，userId 和令牌一致。
- 到点醒来时拿到的是 null：上下文一设上就会立刻唤醒所有等待者，所以到点时上下文一定还没设。结果回 `claim_failed`，同样不订阅。变异 P2（到点回当前 ctx）存活，原因就是这两种写法等价，不算缺口。
- 拿到 A 的上下文以后，`ensurePushSubscription` 里还有几步异步：跨标签页锁、订阅、`ensureDevice`。令牌和 sid 都是用到时才读（`sessionId: () => readSessionId()`，`transport` 每次也是现取会话）。如果这几步当中别的标签页换成了 B：
  - 会出现“锁名和本地 ok 记录用 A 的 userId，sid 和令牌是 B 的”这种混合；
  - 服务器的 `claim_endpoint_impl` 按 JWT 认人（`auth.uid()`、JWT 里的会话），设备行和认领都落在 B 名下，同一 endpoint 在别的账号名下的行会被删掉（M9）；
  - 结果和本页随后重新载入成 B 一致，不会把推送发给错的人；
  - 本地 ok 记录的键带 A 的 userId，B 重新载入后对不上，会重新认领一次，没有坏处。
- 结论：这一轮的等待逻辑不会造成“新令牌加旧 userId、认领到旧账号”。还有一个更早就存在的情形，见 L9。

**② 10 秒等待里，订阅状态有没有泄漏**

- 等待期间不调 `ensurePushSubscription`，不调 `subscribePush`，也不请求通知权限：`runPushClaim` 先 `await contextSoon`，拿到上下文才调 `ensure`。单测“等的时候不碰推送订阅”“等满 10 秒”“等的时候设成 null”三条都断言了没调订阅；变异 P1（设 null 时不通知等待者）、P3（不等，直接用当前 ctx）被抓住。
- 计时器和等待者都会收拾掉：`finish` 先 `clearTimeout` 再 `waiters.delete`。变异 P4（到点不删等待者）存活，但后果只是 Set 里多留一个已经结束的回调，重复调用也没有作用，不影响安全。
- 推送状态：设 null 时先 `setPushOutcome(null)`（变异 P5 被抓住），然后等待者在微任务里写 `{result: 'claim_failed'}`。新账号会短暂看到一条通用的 `claim_failed`，里面没有上一个账号的信息（holder 之类），而且页面马上会重新载入。只记作信息项。
- `expecting` 会不会一直挂着：`expectPushClaimContext()` 在 `:185` 那道换账号检查之后才调（`:187`），之后的提前返回（`:215`）也会 `setPushClaimContext(null)` 把它复位。只有 `startRoot`、render 抛错走 `start().catch → goToAuth` 时不复位，这时等待者最多 10 秒后回 `claim_failed`，页面随即跳到登录页，不泄漏。变异 P7（设上下文时不复位 expecting）存活：后果只是设成 null 之后的点按要多等 10 秒才回 `claim_failed`，不影响安全，可以补一条单测。

### 新问题

#### 高

无。

#### 中

无。

#### 低

**L9（本轮之前就存在）`src/platform/push-claim-run.ts:5` 的说法和实现不一致：上下文设好以后发生换账号，没有人设 null**

- 文件头说“退出、换账号时 setPushClaimContext(null)”。但在 `src` 里（不算测试），除了 `main.tsx:216` 启动时那一处，没有别的调用：`core/account.ts` 的 `watchAccount` 和退出流程都不调它。
- 场景：
  1. A 的页面已经过了首屏、设好了上下文；
  2. 别的标签页登录了 B，本页的 `watchAccount` 收到事件，设闸，开始 `claimCache → disconnectPush（退订浏览器的推送订阅）→ 重新载入`；
  3. 在本页重新载入之前，SW 注册的 `.then` 里的 `runPushClaim()` 晚到，或者用户刚好在设置页点了“打开通知”；
  4. 这次认领拿的还是 A 的上下文。`ensurePushSubscription` 会重新订阅（订阅是同一个 SW 作用域、各标签页共用的），然后认领；
  5. 认领用的令牌如果仍是 A 的（本页 supabase-js 内存里还是 A 的会话，A 的会话在服务器上也还活着），服务器按 M9 会把这个 endpoint 从 B 名下移到 A 名下。
- 后果：从这一刻到本页重新载入、B 的启动认领把 endpoint 拿回来之前，A 的提醒推送会发到这个已经属于 B 的浏览器上。窗口很短（重新载入以后会自愈），但内容是 A 的提醒，属于隐私。
- 这不是本轮引入的：以前上下文在 render 之后马上设，同样存在。本轮推迟设置，反而让窗口变小了一点。
- 建议（任选其一，最好两条都做）：
  - 在 `watchAccount` 的 `check` 一进来设闸（`closeGate`）的地方、以及本页 SIGNED_OUT 和自己退出的流程里，调 `setPushClaimContext(null)`，让文件头的说法成真；
  - 在 `claimOnce` 订阅之前、`deps.claim` 之前，各同步比一次 `readSessionUserId() === deps.userId`，对不上就回 `claim_failed`，不订阅、不认领。
- 补单测：上下文设好以后，在 `ensure` 的异步步骤之间改 storage 里的账号，期望不调 `subscribe`、不调 `claim`。

### 本轮跑的命令和结果

| 命令 | 结果 |
|---|---|
| `$env:TZ='Asia/Seoul'; npx vitest run src/features/onboarding src/platform/__tests__/push-claim-run.test.ts src/platform/__tests__/push-claim.test.ts src/platform/__tests__/session src/platform/__tests__/first-paint src/app/__tests__ tests/build/e2e-ports.test.ts`（共享工作区，只读） | 493 条全部通过，0 失败 |
| 把共享工作区的 `src`、`shared`、配置文件同步到草稿副本 `scratchpad\mut`，再 `diff -rq` 比对 | 同步后和工作区一致 |
| 副本里用 `python -I mut2.py` 做 8 个变异（consent-api 1 个、push-claim-run 7 个），每个都跑对应的测试文件 | 被抓住：M5（4xx 当成功）、P1（设 null 不通知等待者）、P3（不等直接用当前 ctx）、P5（换账号不清 push-status）。存活：P2、P6（都和原写法等价）、P4（只多留一个回调）、P7（只多等 10 秒）。都不影响安全；P7 可以补一条测试 |
| 用 grep 和阅读核对 `main.tsx`、`push-claim-run.ts`、`push-claim.ts`、`core/account.ts`、`sync-transport.ts`、`supabase/migrations/20261103110000_core_claim_endpoint.sql`（M9、endpoint_in_use 的顺序）、`playwright.fastread.config.ts`、e2e 和单测 | 结论见上文 |

本轮只在这份记录末尾追加了这一节；变异只在草稿目录的副本里做，每个变异跑完都还原。没有 git add、连库、构建或跑 e2e，没读 `.env` 的值。
