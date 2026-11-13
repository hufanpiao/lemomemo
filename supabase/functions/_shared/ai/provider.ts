// AI 服务商接口（架构第 7 节、R-55）：保留 AIProvider 接口和 router.ts，结构上仍然可以换服务商；按 R-55 只实现 gemini.ts 一个。
// 纯类型，不 import 任何东西，单测、评测（tests/ai/run.ts）和函数共用。

/** 送给模型的一段内容：文字，或内联的音频（mimeType 取请求的 Content-Type，去掉参数以后，5.11 第 2 点） */
export type AiPart = { text: string } | { inlineData: { mimeType: string; data: Uint8Array } };

export interface AiRequest {
  /** 系统提示（提示词全文，已填好今天、时区等） */
  system: string;
  /** 用户内容：<data> 包起来的原话，或音频 */
  parts: AiPart[];
  /** Gemini responseSchema（OpenAPI 子集） */
  schema: Record<string, unknown>;
  /** 生成参数（只准传 _shared/ai/params.ts 里的）；thinkingLevel 现在只有探测页写（11-11，Gemini 3 的思考档位；正式 ai-voice 等实测后再加） */
  params: Readonly<{ temperature: number; candidateCount: number; thinkingLevel?: 'minimal' }>;
  /** 超时（毫秒），到点中止、不重试 */
  timeoutMs: number;
}

/**
 * 撞的是哪种额度（11-13 ai-eval #2：每 5 秒一句撞了每分钟限额，被当成“当天用完”整遍停下）：
 * day：每天的（太平洋午夜重置）；minute：每分钟的（等 retryDelay 就好）；unknown：回复体里认不出，调用方按 day 保守处理。
 */
export type QuotaKind = 'day' | 'minute' | 'unknown';

/**
 * ok：拿到了 JSON（json 是解析后的值，raw 是模型原样返回的文字，评测两份都存）；
 * quota：服务商说额度用完（Gemini 429 RESOURCE_EXHAUSTED），调用方写 ai_state.exhausted_until；
 *   quotaKind、retryMs（服务商建议的重试等待，毫秒，没有或不合法为 null）只在 quota 时带，只是固定词和数字；
 * timeout：到点中止；error：其他一切（HTTP 错、返回不是 JSON、被安全过滤拦下等）。
 * 失败时只带 HTTP 状态码（不带服务商返回的正文，15.3 第 6 条）；errName 是异常类型名，或 HTTP 失败时谷歌 error.status 的固定名字（gemini.ts 的 rpcCodeOf，如 UNAVAILABLE）。
 */
export type AiResult =
  | { ok: true; json: unknown; raw: string }
  | { ok: false; reason: 'quota' | 'timeout' | 'error'; status?: number; errName?: string; quotaKind?: QuotaKind; retryMs?: number | null };

/** 额度类型的日志片段 kind=day|minute|unknown（固定词，不带服务商原文）；没带类型记 unknown */
export const quotaKindField = (k: QuotaKind | undefined): string => `kind=${k ?? 'unknown'}`;

/**
 * 失败的日志码：ai_<原因>；额度用完另带一段 quotaKindField（空格隔开）。ai-parse、ai-voice、ai-classify、claude-intake 共用；
 * ai-voice 写 logs 表时按空格拆成 code（ai_quota）和 fields 里的 kind=…
 */
export const aiFailCode = (r: { reason: string; quotaKind?: QuotaKind | undefined }): string =>
  r.reason === 'quota' ? `ai_quota ${quotaKindField(r.quotaKind)}` : `ai_${r.reason}`;

/** 异常的类型名（TypeError、AbortError…）：只认 1～40 个英文字母，别的一律 'unknown'（不带 message，免得把正文带进日志） */
export const errNameOf = (e: unknown): string => {
  const n = e instanceof Error ? e.name : '';
  return /^[A-Za-z]{1,40}$/.test(n) ? n : 'unknown';
};

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generate(req: AiRequest): Promise<AiResult>;
}
