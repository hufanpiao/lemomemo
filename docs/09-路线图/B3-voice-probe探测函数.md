# B3 voice-probe 录音格式探测函数（预览专用、一次性）

- 依据：[B3 任务单](B3-任务单.md) BE-0、第二节 Q1 ①～⑨；R-68；架构 5.11 第 1 点、6.2 末尾“预览专用函数”一行；先例 [db-probe](B0-P6数据库探测函数.md)。
- 作者：后端（B3），2026-11-09 起草。**状态：写完，待安全审查；未部署。**
- 要回答的问题：iPhone 录出来的 AAC、电脑 Edge 录出来的 WebM，不转 MP3 能不能直接交给 Gemini 转写。结论由后端写进架构 5.11 第 1 点，架构师确认。

## 一、代码和守门

| 项 | 位置 / 做法 |
|---|---|
| 源码 | `supabase/functions/_preview/voice-probe/handler.ts`（逻辑，可单测）、`index.ts`（接 Deno、supabase-js、Gemini） |
| 只在预览部署 | 名字只进 `build/check_backend.py` 的 `PREVIEW_FUNCS`；`config.toml` 不声明；入口只由 deploy-preview 在产物里生成，`verify_jwt = false`；publish.ps1 部署前按同一份名单另查一遍（F6） |
| 只认预览项目 | `SUPABASE_URL` 必须一字不差等于 `https://yoeqwhygehbaftkppati.supabase.co`（ref 和 db-probe 同一个，单测核对），否则 404 |
| 失效时间 | `EXPIRES_AT` = 2026-11-17T15:00:00Z（首尔 11-17 24:00；B3 开工日按 11-07 算 + 10 天，主持人 11-09 定）。到点起一律 410。延期只改 handler.ts 这一个常量，并重新过安全审查 |
| 鉴权 | 函数自己验 JWT（service role 的 `auth.getUser`），user_id 必须在 handler.ts 的 `ALLOWED_UIDS` 里。令牌无效、不在名单一律 404 |
| 白名单 | 两个账号（11-09 主持人在预览控制台只读核对，预览项目一共就这两个）：负责人的预览验收账号（即 db-probe 的测试账号 A）、QA 的 `.test` 账号。按 user_id 写死在 `ALLOWED_UIDS`；名单为空或有格式不对的项时回 404（日志记 `misconfigured`，防改坏） |
| 每天额度 | 经 service role 调 `private.take_rate`，键 `voice_probe:global:<太平洋日期>`，每天 ≤ 100 次，超了回 429，不重试。窗口取 30 天（2026-11-03～12-03），整个有效期都在同一个窗口里，每天真的只有 100 次（单测核对） |
| 不碰数据库 | 除上面那个计数，不读写任何表；不进 `PREVIEW_AI_FUNCS`、`PREVIEW_R2_FUNCS`，不用 `fn_ai`、`fn_vault` |
| 录音 | 只在内存里：不写 Storage、不写库、不写日志 |
| 日志 | 每次一行 `{fn, code, mime, bytes, http, ms}`，code 是固定事件码（`gemini_ok`、`gemini_error`、`gemini_timeout`、`gemini_quota`、`gemini_bad_output`、`not_allowed`、`auth_rejected`、`daily_limit`、`too_large`、`unsupported_type`、`misconfigured` 等）；不记转写、音频、请求头、Gemini 出错时的返回正文 |
| Gemini | 预览那把 `GEMINI_API_KEY`，只放 `x-goog-api-key` 请求头（`_shared/ai/gemini.ts`）；15 秒超时、不重试；生成参数用 `_shared/ai/params.ts` 的 voice 那组；提示词只要求转写（不用正式的 voice 提示词，免得把格式问题和解析问题混在一起） |

## 二、调用（给前端 A 的探测页）

`POST https://<预览项目>/functions/v1/voice-probe`

| 请求头 | 说明 |
|---|---|
| `Authorization: Bearer <登录后的 access_token>` | 必须是白名单里的账号 |
| `X-Model` | 必填，只认 `gemini-3.1-flash-lite`、`gemini-3.5-flash-lite`（Q6），没有默认值，不对回 400 `bad_model` |
| `Content-Type` | 录音的类型标注。只认 `audio/mpeg`、`audio/aac`、`audio/mp4`、`audio/webm`（带参数先去参数再比，和正式 ai-voice 一样）；不在里面回 415，带回 `raw_type` |

请求体：录音原始字节，≤ 600 KB（边读边计数，超了中断回 413），空的回 400。

成功（Gemini 那一步无论成败都回 200）：

```json
{ "model": "gemini-3.1-flash-lite", "mime": "audio/webm", "raw_type": "audio/webm;codecs=opus",
  "bytes": 182345, "gemini_http": 200, "gemini_ms": 2310, "total_ms": 2405,
  "result": "ok", "transcript": "明天下午三点和老王开会" }
```

- `result`：`ok`、`quota`（Gemini 额度用完）、`timeout`、`error`（被拒或出错，看 `gemini_http`）、`bad_output`（回了 JSON 但没有 transcript）。
- `gemini_http`：Gemini 实际回的 HTTP 状态；连不上为 null。**`result` 是 `timeout` 时一律为 null**：响应头已经回了 200、读正文时才超时的情况也算超时，不显示成“200 + 超时”。“格式被拒”通常是 400。
- `transcript`：最多 2000 字；失败时为 null。

其他：404（不是预览、不是 POST、白名单改坏了、令牌无效、不在白名单——鉴权前后的拒绝一律 404，安全审建议 1）、410（过期）、429（`daily_limit`，今天 100 次用完）、500（`misconfigured`：鉴权通过后发现没配 Gemini 密钥）、503（`try_later`：验令牌或计数连不上）。所有响应 `Cache-Control: no-store`。

## 三、部署前要做的（主持人）

1. ~~负责人给出两个账号的 user_id~~（11-09 已填，送安全审复核）。
2. 主持人确认 Q6 选定的模型（探测页让测的人选，函数两个都认）。
3. 照常经 deploy-preview 部署；不需要新的 secret（`GEMINI_API_KEY` 用预览现有那把）。
4. 测法和判定照 B3 任务单 Q1“测法”“判定”：录音用事先写好、不含真实隐私的句子（会进谷歌免费版）。

## 四、下线（Q1 ⑨，签字前做；探测页同一个 PR 删）

1. 删 `supabase/functions/_preview/voice-probe/`、`tests/edge/voice-probe.test.ts`、`tests/edge/voice-probe-guard.test.ts`、本文件改成“已下线”。
2. `build/check_backend.py` 的 `PREVIEW_FUNCS` 去掉 `voice-probe`（连同上面的注释）。
3. 架构 6.2 末尾“预览专用函数”一行里 voice-probe 那半句删掉。
4. `.github/workflows/deploy-preview.yml` 那段注释里 voice-probe 的两行删掉。
5. **等 deploy-preview 跑完**（`functions deploy` 不会删线上已有的函数，只删源码不等于下线）。
6. **在网页上删函数**（负责人）：Supabase › 预览项目 › Edge Functions › voice-probe › 删除（顺序同 db-probe：先删源码、等部署跑完，再在网页上删）。
7. **核对**：预览、正式两个项目的函数列表里都没有 voice-probe；再调一次应回 404，记下删除时间。预览项目 `private.counters` 里 `voice_probe:global:*` 那几行可以留着（30 天窗口自然作废），也可以由负责人在控制台删。
8. 文件登记册里相关几行改为“已删”。

## 修改记录

| 日期 | 改动 | 人 |
|---|---|---|
| 2026-11-09 | 起草；代码和单测写完，待安全审查 | 后端（B3） |
| 2026-11-09 | 白名单填入主持人核对的两个账号的 user_id，去掉占位值；按安全审建议 1，鉴权前的拒绝（不是 POST、名单改坏）一律 404 | 后端（B3） |
| 2026-11-09 | 按代码审 S1～S6：responseSchema 改大写；超时时 gemini_http 置空；类型和大小上限直接 import ai-voice；先查密钥再扣次数；空正文记日志 | 后端（B3） |
