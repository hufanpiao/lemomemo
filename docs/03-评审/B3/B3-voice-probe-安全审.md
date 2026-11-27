# B3 预览专用探测函数 voice-probe（BE-0）安全审查

- 审查员：独立安全审查员（只读，默认不通过）
- 日期：2026-11-09
- 对象（未提交）：supabase/functions/_preview/voice-probe/handler.ts、index.ts；tests/edge/voice-probe.test.ts、voice-probe-guard.test.ts；build/check_backend.py 的 PREVIEW_FUNCS；.github/workflows/deploy-preview.yml 的注释；docs/09-路线图/B3-voice-probe探测函数.md；架构 6.2 预览专用函数那半句。顺带看了它依赖的 _shared/body.ts、_shared/ai/gemini.ts、store.ts、gate.ts。
- 依据：B3 任务单 Q1 ①～⑨、R-68。只读；唯一跑过的是一段本机 Python，用来算 take_rate 窗口的边界。

## 结论

**有条件通过，8.5 / 10，没有必改项。**

条件是：现在白名单还是占位值，函数在线上一律回 500，什么都做不了。填上真实 user_id 以后要再送一次复核，复核通过前不能当作已经开放。

## 后端自述逐条核实

| 自述 | 核实结果 |
|---|---|
| 白名单是占位值时一律回 500 misconfigured | **属实。** `ALLOWED_UIDS = ['00000000-…']`，`allowedReady` 要求名单不空、每一项都是小写 UUID、不是占位值，不满足就在第 ④ 道回 500：不验 JWT、不计数、不调 Gemini。`deps.allowed` 只有单测会传，index.ts 不传。 |
| 令牌无效、不在白名单都回 404 | **属实。** Bearer 格式不对、`getUser` 回 4xx、uid 不在名单里，都回同一个 `404 not_found`，只在日志里分成 `auth_rejected`、`not_allowed`；auth 服务连不上回 503。 |
| EXPIRES_AT = 2026-11-17T15:00:00Z，到期回 410 | **属实。** 第 ② 道 `now < EXPIRES_AT` 不成立就回 410，在鉴权之前判断，用的是服务器时钟。 |
| 每天 ≤ 100 次，窗口 30 天避开切半 | **属实，算法正确。** 键是 `voice_probe:global:<太平洋日期>`，限额 100；在鉴权通过、读完请求体之后才计数，没登录的人刷不掉额度；Gemini 失败也不退回（保守），读不到计数回 503（出错就关上）。我按“从 1970 年起整数倍对齐”算了窗口：30 天窗口是 2026-11-03 00:00 UTC 到 12-03 00:00 UTC，部署日到 EXPIRES_AT 之间的每个太平洋日期都完整落在同一个窗口里，所以每天确实只有 100 次；31 天窗口的边界在 11-13，确实会把一天切成两半。守门单测也核对了这一点。 |
| X-Model 只认两个、没有默认值 | **属实。** 不在 MODELS 里回 400；模型名在拼进地址前，GeminiProvider 还会再按 MODEL_RE 查一遍。 |
| mime 只认 4 种、600 KB 回 413，与 ai-voice 一致 | **属实。** `audioType` 和 ai-voice 写法一样；用 `_shared/body.ts` 的 `readCapped` 边读边按字节计数，Content-Length 声明超了也提前拒；单测核对两边常量一致。 |
| 密钥只在请求头，15 秒超时、不重试 | **属实。** 走 `_shared/ai/gemini.ts`：密钥放 `x-goog-api-key`，不进 URL；用 `VOICE_TIMEOUT_MS` 15 秒中止，没有重试。 |
| fetch 包一层，只取状态码 | **属实。** 包的那一层只调 `seen(res.status)`，原样返回响应，不读正文、不看响应头。 |
| 日志不记敏感内容；响应一律 no-store | **属实。** handler 里没有 console；index.ts 只有一处 `console.log`，逐个取 code、mime（4 个常量之一）、bytes、http、ms 五个字段；code 只来自写死的值和 `gemini_<reason>`。转写、音频、令牌、raw_type、Gemini 正文都不进日志。所有响应都经 `json()` 带 `cache-control: no-store`、`nosniff`。 |
| 不碰数据库（take_rate 除外），不在 AI、R2 名单里 | **属实。** 只 import `_shared/ai/store.ts` 的 `takeRate`，不引 `_shared/db.ts`；PREVIEW_FUNCS 加了 voice-probe，PREVIEW_AI_FUNCS、PREVIEW_R2_FUNCS 没加；守门单测核对了这几条。 |

## 重点核查

1. **白名单能不能绕过：不能。** uid 只来自 service role 的 `auth.getUser(jwt)`：auth 服务会验签名、查会话，拿不到就当无效。比对用的是 `includes` 精确相等，名单写死在源码里，没有环境变量或请求参数能改它。
2. **会不会误部署到正式环境（守门 ①）：有三道保险。**
   - `_preview/` 下划线开头的目录不当函数，正式发布脚本不带它；只有 deploy-preview.yml 在预览产物里生成入口。
   - F6 管着：不准有同名顶层目录、不准在 config.toml 里声明、别处不准引 `_preview/`。
   - 就算真部署到正式项目，第 ① 道 `isPreview` 要求 SUPABASE_URL 一字不差是预览 ref（只许末尾多一个斜杠），不是就回 404，什么都不做。
3. **额度和窗口算法：正确。** 见上表；计数放在鉴权之后，外人刷不掉，白名单里的人一天最多 100 次。
4. **日志泄漏：没有。** 见上表。
5. **回显 raw_type 有没有注入或泄漏：没有风险。**
   - 只有通过鉴权的白名单用户才能拿到回显（第 ⑦ 道在鉴权之后），回的是他自己发的 Content-Type。
   - 回显前去首尾空白，只许可打印 ASCII、最长 100 字，否则整个换成 `(invalid)`。
   - 放在 JSON 里，响应是 `application/json` 加 `nosniff`，浏览器不会当成 HTML 解析；也不写日志。
6. **正式产物会不会带上它：后端部分不会**，理由同第 2 条。工作区里还有前端的 `src/platform/voice-probe.ts` 和 `src/app/dev/VoiceProbe.tsx`（FA-0，不在这次范围内）：注释说正式构建时会被 rollup 删掉，`build/check_no_probe.mjs` 在 release-build.yml 里检查正式产物里搜不到它们。这部分建议另外派审。

## 建议（不阻塞）

1. **鉴权前就回了 405、500。** 不是 POST、或白名单没配好时，在鉴权前就回 405、500，外人能借此知道预览上有这个函数。白名单填好后 500 这条就不会出现；405 影响很小。想彻底些，可以把第 ③、④ 道挪到鉴权之后，或者鉴权前一律回 404。
2. **没查账号停用和应用自己的会话表。** 只靠 `getUser`，没查 `isUsable` 和 `private.session_alive`（应用自己记的会话是否有效）。白名单只有负责人和 QA 的测试账号，又只开 10 天，可以接受；复核白名单时请确认里面全是测试账号，没有真实用户。
3. **下线步骤要按期执行。** 文档第四节写全了（删源码 → 等预览部署跑完 → 负责人在网页上删函数 → 两个项目核对都回 404）。建议在 11-17 之前排进下线清单。过了 EXPIRES_AT 函数自己会回 410，但线上的函数不会因此消失。

## 复核白名单时要看的

- 名单里只有负责人的预览验收账号和 QA 的 .test 账号，都是小写 UUID，没有占位值；
- EXPIRES_AT 没有被顺手改晚（要延期就得重新安全审）；
- 守门单测“窗口不切半”那一条仍然通过。

## 复核：白名单版（2026-11-09）

复核对象（未提交）：supabase/functions/_preview/voice-probe/handler.ts、tests/edge/voice-probe.test.ts；另核对了 db-probe 的 `TEST_UID`，并在仓库里搜了两个 user_id 出现的地方。只读。

**结论：通过，9 / 10，没有必改项。** 白名单已经填好，上一轮的建议 1 也落实了，函数可以按 Q1 开放给这两个测试账号用。

| 后端说法 | 核实结果 |
|---|---|
| 删掉占位值，名单只有两个测试账号 | **属实。** `UID_PLACEHOLDER` 已删；`ALLOWED_UIDS` 正好是 `7aa8c4cb-11ba-4e9e-aa6f-72196dfe3f8b`（和 db-probe/probe.ts 的 `TEST_UID` 一字不差）、`8380dfe1-44e2-4eca-b8d2-7fef8f719305`。单测用 `toEqual` 钉住了整个名单，还断言包含 db-probe 的 TEST_UID。user_id 本身不是凭据，写进公开仓库可以接受；这两个账号的登录凭据我在仓库里没搜到。 |
| allowedReady 只查不空、每项都是小写 UUID | **属实。** 去掉了“不是占位值”这一条。就算有人把全 0 的 UUID 写回来，也不对应任何账号，`getUser` 永远拿不到这个 id，不会因此放进外人。 |
| 非 POST、名单改坏都回 404，名单改坏时日志记 misconfigured；过期 410 排在它们前面 | **属实。** 顺序是：① 不是预览 404 → ② 过期 410 → ③ 不是 POST 404 → ④ 名单改坏 404（只在日志里记 misconfigured）→ ⑤ 验令牌、白名单 404。所以鉴权前已经不会回 405、500 了。 |
| 鉴权通过后发现没配 Gemini 密钥仍回 500 | **属实。** 只有白名单账号才可能看到这个 500，不算对外暴露。 |
| 单测 | **属实。** GET、PUT、DELETE、OPTIONS 都回 404，并断言没有验令牌；名单改坏的四种输入（空、不是 UUID、大写、带空格）都回 404，断言没有验令牌、没有计数、日志只有一条 misconfigured；用仓库里的真名单时这两个账号回 200，别的账号回 404。 |

**410 排在鉴权前面会不会泄露函数存在：不构成实际泄露，可以按 Q1 ③ 保留。**
- 这是公开仓库，函数的名字、源码、有效期本来就公开，“预览上有过 voice-probe”谈不上秘密。
- 410 只在 EXPIRES_AT 以后出现，那时函数什么都做不了：不验令牌、不计数、不调 Gemini、不读请求体，外人拿到 410 也没有任何可利用的东西。
- 410 本来就是 Q1 ③ 明文要求的，好处是让测试的人一眼看出“过期了”，而不是以为自己的账号被拒。
- 真正要防的是过期以后函数还挂在线上。请按文档第四节，在 11-17 前删源码、等预览部署跑完，再由负责人在网页上删掉函数。

**提醒（不阻塞）：** 白名单的前提是“预览项目一共就这两个账号”。以后预览如果再开放注册或者加新的测试账号，不会自动进白名单，这是对的；但 QA 账号的登录方式（魔法链接、密码或 CI 里生成会话的密钥）要确认只在 CI secrets 或负责人手里，不在仓库里。我这一轮在仓库里没搜到它的凭据。

## 复核：代码审后的改动（2026-11-09）

**结论：通过，9 / 10，没有必改项。**

- **第 3 条：AUDIO_TYPES、MAX_AUDIO 改为从 ai-voice/core.ts 直接 import。** 核实属实，没有把副作用或读密钥带进预览函数。
  - ai-voice/core.ts 只 import `_shared/ai/gate.ts`、`provider.ts`（只有类型）、`parse-core.ts`、`_shared/body.ts`；parse-core 又只引 `params.ts`、两份提示词常量。
  - 这几个文件里都没有 `Deno.env`、`Deno.*`、`console.*`、`fetch(`、`createClient`（在 ai-voice/core.ts 里唯一搜到的一处是注释），模块顶层只有常量和函数定义，加载时不执行任何东西。
  - 读密钥、建数据库客户端都在 ai-voice/index.ts 里，这次没有被引进来。
  - 建议（不阻塞）：以后如果有人在 ai-voice/core.ts 顶层加了读环境变量或建客户端的代码，会悄悄带进预览函数。可以在 voice-probe-guard 单测里加一条：ai-voice/core.ts 及它 import 的模块里不准出现 `Deno.env`、`createClient`。
- **第 4 条：查有没有配 Gemini 密钥挪到扣次数之前。** 属实。`deps.provider(...)` 拿不到（没配密钥）就记 misconfigured、回 500，不调 `take`，不白占当天的额度。这一步在鉴权之后，外人看不到这个 500。
- **第 5 条：空正文回 400 前加日志 `{code: 'empty'}`。** 属实。日志只有事件码，不带别的字段。
- **超时时 gemini_http 一律为 null、PROBE_SCHEMA 改成大写：** 都只影响探测结果怎么显示，跟安全无关，没有新问题。
