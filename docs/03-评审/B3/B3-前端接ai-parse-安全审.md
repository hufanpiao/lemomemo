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
