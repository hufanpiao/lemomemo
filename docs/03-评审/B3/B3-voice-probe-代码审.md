# B3 voice-probe（BE-0）代码审

- 审查人：独立代码审查员（只读，默认不通过）
- 日期：2026-11-09
- 范围：
  - `supabase/functions/_preview/voice-probe/handler.ts`、`index.ts`
  - `tests/edge/voice-probe.test.ts`、`tests/edge/voice-probe-guard.test.ts`
  - `build/check_backend.py` 中 `PREVIEW_FUNCS` 的改动（git diff：+3 −1）
  - `docs/09-路线图/B3-voice-probe探测函数.md`
- 安全面由安全审负责（通过 9 分），本审不重复。
- 实跑：`npx vitest run tests/edge/voice-probe.test.ts tests/edge/voice-probe-guard.test.ts`，2 个文件、31 条测试全部通过。

## 结论：通过，8.5 分（无必改项）

## 逐项核对

| 重点 | 结论 | 依据 |
|---|---|---|
| 各道门的顺序和状态码与文档是否一致 | 一致 | 处理顺序：预览地址不对 404 → 过期 410 → 非 POST 404 → 白名单改坏 404 → 令牌：鉴权服务出错 503，无效或不在名单 404 → 模型不对 400 `bad_model` → 类型不对 415 → 读正文：超大 413，空 400 → 扣次数：出错 503，超额 429 → 没配密钥 500 → 正常 200。与文档第二节所列状态码一一对上；每一道门都有对应用例。 |
| take_rate 30 天窗口的推算和单测 | 靠得住 | 窗口取 `floor(epoch / 2592000) * 2592000`，当前窗口是 2026-11-03 00:00 UTC 至 12-03，完整覆盖 11-09～11-17 的探测期。若用 31 天窗口，边界会落在 11-13，切开一个太平洋日。守门测试从 11-06 到 `EXPIRES_AT` 后 1 天，每 15 分钟检查一次“同一太平洋日落在同一窗口”，并且直接绑定 `EXPIRES_AT`，以后延期也会自动跟着测。 |
| 边读边计数到 600 KB 中断 | 正确 | 用的是与 ai-voice 相同的 `_shared/body.ts` `readCapped`：先看 Content-Length，再按块累计字节数，超限立即 `reader.cancel()`；只缓存累计不超过上限的块，不会整包读进内存，也没有漏计。测试覆盖：正好 600 KB 通过；多 1 字节 413 且不扣次数；不带 Content-Length 的分块流超限后中断，拉取次数 < 200（共 400 块）；空正文 400。 |
| fetch 外包一层取 HTTP 状态码会不会吞错 | 不会 | `index.ts` 的写法是 `await fetch` → `seen(status)` → 原样返回。网络异常照样抛出，由 `GeminiProvider` 的 catch 判成 error 或 timeout；用例中 `TypeError('network')` 得到 `error`、`gemini_http: null`。小瑕疵见建议 S2。 |
| 常量一致性测试是否引用同一份常量 | 比较的是两边的真实导出，比对成立 | handler 和 `ai-voice/core.ts` 各自导出 `AUDIO_TYPES`、`MAX_AUDIO`，守门测试从两边 import 后比较。但 handler 是另写了一份，不是复用同一来源，见建议 S3。 |
| 测试是不是只测了替身 | 不是 | `setup()` 里的 provider 是真的 `GeminiProvider`，只把最底层的 fetch 换成假的。请求头里的密钥、地址里不带密钥和 `?`、429 RESOURCE_EXHAUSTED 判 quota、400/500 判 error、非 JSON、坏输出、15 秒超时，走的都是真实的解析和超时代码。`verify`、`take` 用替身是合理边界：真实 `takeRate` 和 `verify` 在别处有测试，不属于本函数。 |
| check_backend 的改动 | 正确 | `PREVIEW_FUNCS` 加入 `voice-probe`；注释写明不进 `PREVIEW_AI_FUNCS` 和 `PREVIEW_R2_FUNCS`、只计数、下线时要删。F6 照常守门。 |

## 必改

无。

## 建议（不卡通过）

- **S1 `PROBE_SCHEMA` 大小写与正式代码统一。**
  - 现状：探测用小写 `object` / `string`，正式的 `parse-core.responseSchema` 用大写 `OBJECT` / `STRING` / `ARRAY`。
  - 这次探测要回答的是“正式请求能不能接受这种音频”，所以请求最好和正式请求长得一样。
  - Gemini REST 目前大概率两种写法都接受（旧版 JS SDK 发的就是小写），所以不列为必改。但万一被拒，回来的是 400，会和“音频格式被拒”混在一起，没法区分。
  - 改成大写成本为零。本审没有联网验证。
- **S2 读正文时超时，结果显示成“http 200 + timeout”。**
  - 原因：`seen` 在拿到响应头时已经记了 200；之后读正文超时，catch 判成 timeout，`outcome` 又用 `seen ?? r.status` 填 http，于是回 `gemini_http: 200, result: 'timeout'`。
  - 这不算错，但看结果的人容易误读。可以在 timeout 时把 http 置为 null，或者在文档里写一句说明。
- **S3 `AUDIO_TYPES`、`MAX_AUDIO` 改成直接从 `ai-voice/core.ts` import。**
  - 现在靠测试保证两边一致，能用；直接 import 则是从源头保证一致。
  - 如果是故意不让预览函数依赖正式函数目录，在注释里写明原因即可。
- **S4 没配密钥（provider 为 null）的检查放到扣次数之前。**
  - 现在是先扣一次额度，再回 500 `misconfigured`。
  - 影响很小，因为配置错了本来就会全部失败。但顺序调过来更干净，也和“白名单改坏不扣次数”的做法一致。
- **S5 空正文（`empty`）补一条日志。** 其他 4xx 都有事件码，只有这一条没有。排查时，“探测页发了空录音”会看不到。
- **S6 超时用例补一条“到点前不会提前中止”的断言。** 可以先推进 `VOICE_TIMEOUT_MS - 1`，断言此时还没有返回，再推进到 15 秒。现在只证明了“到点会中止”。

## 评分

正确性 9 / 测试真实度 8.5 / 与文档一致 9 / 可维护性 8（常量另写一份，schema 写法与正式不一致），综合 8.5，通过。
