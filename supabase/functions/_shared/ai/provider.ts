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
 * ok：拿到了 JSON（json 是解析后的值，raw 是模型原样返回的文字，评测两份都存）；
 * quota：服务商说额度用完（Gemini 429 RESOURCE_EXHAUSTED），调用方写 ai_state.exhausted_until；
 * timeout：到点中止；error：其他一切（HTTP 错、返回不是 JSON、被安全过滤拦下等）。
 * 失败时只带 HTTP 状态码（不带服务商返回的正文，15.3 第 6 条）。
 */
export type AiResult =
  | { ok: true; json: unknown; raw: string }
  | { ok: false; reason: 'quota' | 'timeout' | 'error'; status?: number; errName?: string };

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
