// AI 生成参数和超时：唯一出处（架构第 7 节“生成参数”，0.29 AI 句库 Q13 ④；TC-B3-48）。
// parse、voice、classify、media、intent、summarize 一律 temperature 0、candidateCount 1，输出 application/json 加 responseSchema；
// 评测（tests/ai/run.ts 经 parseWithAI）和正式用同一份，不许为测试单独调；改参数等同改提示词，要重跑测试集 ①。
// 超时分开写（任务单 S12、架构审第一节 S12）：ai-parse 调 Gemini 5 秒（第 7 节），不在服务器端重试；ai-voice 15 秒（5.11 第 4 点），
//   11-11 起 Gemini 回 503 时重试一次、两次合计仍不超过 15 秒（retry.ts；B3 iPhone 实测 40 次里 4 次 503）。重试不改生成参数，不算改提示词。

export const GEN_PARAMS = Object.freeze({ temperature: 0, candidateCount: 1 });

/**
 * 探测页（voice-probe）另外写明思考档位 minimal（11-11，负责人“语音识别感觉有点慢”）。
 * **正式 ai-voice 这次不带**（11-11 架构复审定）：thinkingConfig 还没实测过，万一 3.5-flash-lite 不接受，正式录音会全部 400；
 * 等负责人用探测页重录（3.5 和 3.1 都会打到）确认都回 200，再另出补丁加到 TASK_PARAMS.voice，并重跑测试集 ①。
 * 官方 API 参考（generateContent 的 ThinkingConfig）：Gemini 3 起用 thinkingLevel（MINIMAL = “Little to no thinking”，最低一档，
 * 不能完全关；thinkingBudget 是 2.5 的写法，3 代不推荐）。Gemini 3 开发者指南：3.5-flash-lite、3.1-flash-lite 的默认档位本来就是 minimal（未核实），
 * 所以这一项主要是钉死（默认值以后变了也不受影响），**不指望它明显变快**；耗时波动多半在 Gemini 服务端。上线后怎么验见架构 5.11 第 1 点。
 * parse、classify 等先不动（只给建议，见同一处）。
 */
export const VOICE_PROBE_PARAMS = Object.freeze({ ...GEN_PARAMS, thinkingLevel: 'minimal' as const });

/** 各用途的生成参数（以后某一项要改，改这里并重跑对应测试集） */
export const TASK_PARAMS = Object.freeze({
  parse: GEN_PARAMS,
  voice: GEN_PARAMS,
  classify: GEN_PARAMS,
  media: GEN_PARAMS,
  intent: GEN_PARAMS,
  summarize: GEN_PARAMS,
});

/** ai-parse、claude-intake 的文字解析：调 Gemini 的超时（毫秒） */
export const PARSE_TIMEOUT_MS = 5_000;
/** ai-voice：转写和解析一次完成的超时（毫秒）。前端按 shared/schema/ai.ts 的同名常量定上传超时，两边必须相等（tests/shared/ai-schema.test.ts 钉住） */
export const VOICE_TIMEOUT_MS = 15_000;

/** ai-classify：一批（每人最多 20 条）分一次的超时（毫秒）。cron 调用，不重试，失败的这批记 rule、下一轮重新排队（架构 5.2） */
export const CLASSIFY_TIMEOUT_MS = 10_000;

/** ai-media：一批（最多 6 张缩略图）识别一次的超时（毫秒）。cron 调用，不重试，失败的按 10 分钟、1 小时退避，第 3 次还失败记 failed（架构 5.13 第 5 点） */
export const MEDIA_TIMEOUT_MS = 20_000;

/** 提示词版本（写进 ai_meta.prompt；改提示词就升版本并重跑测试集） */
export const PROMPT_VERSION = Object.freeze({ parse: 'parse.v3', voice: 'voice.v3', classify: 'classify.v2', media: 'media.v1' });   // 11-07 由 v1 升到 v2（B3 任务单补充 R5、R6、R8）；11-10 升到 v3（R-374 中文相对时刻）；classify 11-13 升 v2（R-413 加相似分类对）；media 11-14 B4b-2 识图新加 v1
