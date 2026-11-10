// AI 生成参数和超时：唯一出处（架构第 7 节“生成参数”，0.29 AI 句库 Q13 ④；TC-B3-48）。
// parse、voice、classify、media、intent、summarize 一律 temperature 0、candidateCount 1，输出 application/json 加 responseSchema；
// 评测（tests/ai/run.ts 经 parseWithAI）和正式用同一份，不许为测试单独调；改参数等同改提示词，要重跑测试集 ①。
// 超时分开写（任务单 S12、架构审第一节 S12）：ai-parse 调 Gemini 5 秒（第 7 节），ai-voice 15 秒（5.11 第 4 点），都不在服务器端重试。

export const GEN_PARAMS = Object.freeze({ temperature: 0, candidateCount: 1 });

/** 各用途的生成参数（现在都一样；以后某一项要改，改这里并重跑对应测试集） */
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
/** ai-voice：转写和解析一次完成的超时（毫秒） */
export const VOICE_TIMEOUT_MS = 15_000;

/** ai-classify：一批（每人最多 20 条）分一次的超时（毫秒）。cron 调用，不重试，失败的这批记 rule、下一轮重新排队（架构 5.2） */
export const CLASSIFY_TIMEOUT_MS = 10_000;

/** 提示词版本（写进 ai_meta.prompt；改提示词就升版本并重跑测试集） */
export const PROMPT_VERSION = Object.freeze({ parse: 'parse.v3', voice: 'voice.v3', classify: 'classify.v1' });   // 11-07 由 v1 升到 v2（B3 任务单补充 R5、R6、R8）；11-10 升到 v3（R-374 中文相对时刻）
