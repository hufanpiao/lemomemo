# B3 前端接 ai-parse 安全复查

- 审查员：独立安全审查员（只读，默认不通过）
- 日期：2026-11-09
- 对象：src/features/plus/data/ai-parse-api.ts、src/features/plus/hooks/useTypeBar.ts、tests/e2e/b3-ai-parse.real.spec.ts。为了核对，还读了同一条链上的 data/type-flow.ts、data/ai-outcome.ts、platform/env.ts、tools/e2e/real-backend.mjs，以及后端的 _shared/consent.ts。后端已提交（91876d6、885778c）。

## 结论

**通过，9 / 10，没有必改项。**

## 逐项核对

1. **凭据只发往自家函数地址：是。** 请求地址固定为 `${buildInfo.supabaseUrl}/functions/v1/ai-parse`，取自构建时的 `VITE_PUBLIC_SUPABASE_URL`；没配时是同源相对路径。请求头只有 Bearer JWT（取自本次会话的 access_token）、公开的 anon key（apikey）和 content-type；X-App-Version 由 appFetch 自动加。`url`、`fetch`、`token` 三个注入口只在测试里用，正式的 `callAiParse = createCallAi()` 不带参数。拿不到会话时直接抛 SendError、不发请求。请求带 `cache: 'no-store'`。
2. **错误信息和原话不进日志、不进 URL：是。** 上面几个文件里没有 console 或日志上报；原话只在 POST 请求体里，URL 上没有查询参数；出错只抛 `SendError('http' | 'bad_response')` 这类代码，不带服务器返回的内容。收起时原话存成草稿，放在本机库的 drafts 仓里，按账号分开，不出这台设备。
3. **未同意时不发原话：基本是。** 客户端只在设置 `ai.enabled === true` 时才调 ai-parse（type-flow 第 141 行），本机规则有把握、离线、额度用完、选中的日子不合格时也都不调。剩下一个边界：`ai.enabled` 是开的，但服务器认为同意已经失效（比如政策版本升了，`consent_ai_at` 或 `consent_policy_ver` 不够新）。这时原话会发到自家的 ai-parse，服务器在第一道门就回 `consent_required`：不调 Gemini、不扣次数、不记录请求体，客户端改用本机规则记下。原话只到了自家服务器（本来就要同步上去），没有到 AI 服务商，可以接受。见建议 1。
4. **回包先校验再写库：是。** `outcomeOf` 先把不认识的 intent 当成 ai_failed，再用 shared/schema/ai.ts 的 `aiResponse.safeParse` 严格校验（各层都是 strictObject，有 kind 枚举、日期和时刻格式、items 不超过 10 条），不合格当 ai_failed、退回本机规则，没有用 `as` 硬转。校验过的条目经 capture-save（captureRow、outbox）写库，服务器那边照常有 RLS 和行的约束。客户端这一层只校验结构，不重做 checkParseOutput 的取值范围；这部分 ai-parse 在服务器上已经做过了，见建议 2。
5. **e2e 不会误调真 AI 花钱：是，有两道保险。** ① lemo-e2e 的函数环境由 tools/e2e/real-backend.mjs 的 `E2E_FUNCTIONS_ENV` 生成：键的清单写死，`functionsEnvProblems` 核对“一个不多一个不少”，里面没有 GEMINI_API_KEY，所以 `pickProvider` 返回 null，函数回 `{fallback, reason: 'error'}`，根本不发出站请求。② 就算有密钥，HTTPS_PROXY 指向一个没人监听的 127.0.0.1:9，NO_PROXY 里没有 googleapis，出站也连不上。用例本身还断言回包里没有 intent，一旦拿到 record 就失败，作为第三道提示。另外，仓库根目录的 .env* 不会拷进 .e2e-sb。

## 建议（不阻塞）

1. **同意的前置判断可以收紧一点。** 客户端如果能拿到“同意版本是否够新”（启动时告知页关口已经在算），可以在 `aiOn` 里一起判断，这样同意失效的边界情况里原话连自家的 ai-parse 也不会发。
2. **自动重试可能扣两次。** askAi 遇到网络错误（TypeError）会自动重试 1 次。如果第一次其实已经到了服务器、只是回包丢了，服务器那边可能已经调过一次 Gemini、扣过一次额度。影响只是本人多扣一次，可以接受；如果想避免，可以在请求里带一个幂等键。
3. **客户端校验可以再严一层。** aiResponse 的 itemOut 对 title、short 没有长度上限。服务器已经校验过，写库时也有行约束，问题不大；如果 outbox 入队前没有过 rows.ts 的 eventsWrite、todosWrite，建议在入队处补上。

## 复审 S1（2026-11-09）：知道同意已过期时不发原话

复审对象（未 git add）：src/kit/state/consent-fresh.ts（新）、src/features/onboarding/hooks/useConsentWiring.ts、src/features/plus/hooks/useTypeBar.ts，测试 consent-fresh.test.tsx、TypeBar.test.tsx 新加的 2 条。另核对了服务器的 decideAi（_shared/consent.ts）、record_consent_impl（20261029192000 迁移），以及登录、换账号时页面怎么跳。只读。

S1 对应上一轮的“建议 1”（同意的前置判断收紧），按主持人定的方案：只有明确知道已过期才不发，读失败或不知道时照常发，由服务器把关。

**结论：通过，9 / 10，没有必改项。**

1. **有没有过期用户的原话被服务器放行：没有。**
   - 服务器这道门不依赖客户端：decideAi 按 `consent_ai_at` 不为空、`consent_policy_ver` 不低于 `min_consent_ver`、`ai.enabled` 为真三项判断，任何一项不过就回 consent_required，不调 Gemini、不扣次数、不记请求体。所以无论客户端怎么判断，过期用户的原话都到不了 Gemini。
   - 客户端会发原话的只有打字条一处：`useTypeBar` 的 `aiOn` 现在是 `ai.enabled 为真 && !consentStale()`。语音（ai-voice）还没有接前端；claude-intake 不经过网页。
   - 还会让原话发到自家 ai-parse 的只剩“不知道”的窗口：页面刚打开、关口结果还没回来，关口超时先放行了；或者读同意版本失败。这正是主持人定的“不知道就照常发”，原话只到自家服务器，服务器会挡住，可以接受。
   - 关口超时放行以后才回来的结果也会记下来（第 76 行），所以窗口只到结果回来为止。读失败（`r.ok` 为假）不改值，符合方案。
2. **告知页“不同意”也记成够新，对不对：结果是安全的，但理由要更正。**
   - 不同意时调的是 `record_consent(revoke = true)`。服务器会把 `consent_ai_at` 置空、记下当前版本，并在服务器的 settings 里把 `ai.enabled` 写成 false。之后 decideAi 第 ① 条就不放行，Gemini 一定调不到。
   - 所以对“过期”这个判断来说，记成够新没错：版本确实已经是当前的。
   - 但前端 A 说的“之后由服务器按 ai.enabled 把关”不准确。真正挡住的是 `consent_ai_at` 被清空，而且客户端本机的 `ai.enabled` 要等同步拉回来才会变成 false。这期间，如果这个人以前开过 AI（比如“隐私说明更新了”那一屏点了不同意），打字条仍会把原话发到自家 ai-parse，拿到 consent_required 以后退回本机规则。原话没有到 Gemini，所以不算必改。
   - **建议**：`onDone(false)` 时顺手把本机的 `ai.enabled` 也写成 false（和服务器一致），或者记成“不发”（`setConsentStale(true)`，以后在设置里重新同意时再清掉），把这个同步窗口关上。
3. **模块级状态在退出登录、换账号以后会不会留着上一个人的值：不会。**
   - 登录只发生在单独的 /app/auth/ 页，登录完用 `location.replace('/app/')` 整页重新载入，模块级的值重新从默认的“没过期”开始，再由这次的关口结果覆盖。
   - 就算以后改成不整页重载，留下来的值最坏也只有两种情况：上一个人是“过期”，新的人暂时不调 AI，这是安全的方向；上一个人是“够新”，那就等于“不知道”的情况，由服务器把关。不会让原话到 Gemini。
   - 建议（不阻塞）：退出登录时顺手 `setConsentStale(false)` 复位，免得以后有人依赖“整页重载”这个前提而不自知。

## 复核 S1 两条建议（2026-11-09）

复核对象（未 git add）：src/kit/state/consent-fresh.ts、onboarding/hooks/useConsentWiring.ts、plus/hooks/useTypeBar.ts、consent-fresh.test.tsx；另看了 platform/session.ts 的 `readSessionId`、`sessionIdOfToken`，以及从设置页重新打开告知页的路径（ConsentRoute）。只读。

**结论：通过，9 / 10，没有必改项。** 两条建议都已落实；第 2 条换了做法（按会话 id 失效，不改首屏的退出流程），安全上等价，可以接受。

1. **告知页点“不同意”时记成“不发”：已落实。** `onDone` 里的 `setConsentStale(!agreed, readSessionId())`，同意记“可以发”，不同意记“不发”，本机 ai.enabled 同步回来之前那段空档也关上了。会不会把人卡在“不发”：设置页重新开 AI 走的是同一个告知页（ConsentRoute 用同一套接线），重新同意会经 `onDone(true)` 改回“可以发”，不会卡住。
2. **退出登录复位，改成按会话 id 失效。**
   - **同一个人重新登录，会话 id 会不会不变：不会。** `readSessionId` 取的是 access token 里的 `session_id`。Supabase 每次登录都会新建一条会话、给一个新 id，刷新 token 时 id 不变（那仍是同一次登录，沿用是对的）。所以退出再登录，即使是同一个人，旧记录也对不上，按“没记过”处理。
   - **沿用“够新”能不能让过期的原话发出去：不能。** `consentStale` 只有两个结果：“不发”和“当作不知道、照常发”。沿用“够新”最坏等于“不知道”：原话发到自家 ai-parse，服务器的 decideAi 独立判断同意时间和版本，过期就回 consent_required，不调 Gemini。所以只要服务器那一层在，任何一种对上或对不上都不会让过期的原话到 Gemini。
   - **`readSessionId` 读失败时：返回 null，可能误判成对得上，但只会往安全方向偏。** 读不到存储、token 不是 JWT、里面没有 `session_id`，都返回 null。`consentStale` 用的是 `mark.sid === sid`，所以记的时候和读的时候都是 null 时会算成对得上：
     - 当时记的是“可以发”：结果等于“不知道”，由服务器把关；
     - 当时记的是“不发”：这个页面里一直不调 AI，直到下一次关口结果覆盖它。这只是功能暂时用不了，不泄露任何东西。
     - 一边是 null、另一边有值，就算对不上，按“没记过”处理，也就是“不知道”。
     - **建议（不阻塞）**：读到 null 时一律当“没记过”（记的时候 sid 为 null 就不记，读的时候 sid 为 null 就回 false），语义更干净，也免得“不发”沿用到别人身上。现在登录必定整页重载，实际碰不到这种情况。
   - 首屏没有新增代码：consent-fresh.ts 只被告知页、打字条两个懒加载块引用，`readSessionId` 本来就在 platform/session.ts 里。
