// Gemini 适配（架构第 7 节、5.11；R-55 只实现这一个；B3 任务单 BE-1）。
// • 地址 generativelanguage.googleapis.com/v1beta/models/<model>:generateContent；模型名从 app_config.ai.model 读，由调用方传进来，不写死；
// • 密钥只放 x-goog-api-key 请求头，不进 URL（S-B3 低 6，TC-B3-24）；
// • 文字和 inlineData 音频（base64）两种内容；生成参数、responseMimeType、responseSchema 由调用方给（params.ts 一处）；
// • 超时由 AbortController 中止，不重试；
// • 429 且 status 是 RESOURCE_EXHAUSTED 当 quota（调用方写 ai_state.exhausted_until）；其他错误、返回不是 JSON、被拦下当 error；
// • 不打印请求体、返回正文和密钥（15.3 第 6 条、A23）；出错只回 HTTP 状态码。
// fetch 注入：单测和回放桩（BE-6）传假的，函数传全局 fetch。
import { errNameOf, type AiPart, type AiRequest, type AiResult, type AIProvider } from './provider.ts';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
/** 模型名只许字母数字和 . _ -（防拼进路径） */
const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Uint8Array → base64（分块，避免 60 秒音频一次展开参数过多） */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

function partJson(p: AiPart): Record<string, unknown> {
  return 'text' in p ? { text: p.text } : { inlineData: { mimeType: p.inlineData.mimeType, data: toBase64(p.inlineData.data) } };
}

/** 请求体（单测核对键名和参数） */
export function geminiBody(req: AiRequest): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: req.parts.map(partJson) }],
    generationConfig: {
      temperature: req.params.temperature,
      candidateCount: req.params.candidateCount,
      responseMimeType: 'application/json',
      responseSchema: req.schema,
      // 只有调用方写了思考档位才带（录音；11-11）。没写的照旧不带，用模型默认
      ...(req.params.thinkingLevel ? { thinkingConfig: { thinkingLevel: req.params.thinkingLevel } } : {}),
    },
  };
}

/** 从 generateContent 的返回里取出模型给的文字（第一个候选的各段拼起来） */
function textOf(body: unknown): string | null {
  const c = (body as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] } | null)?.candidates?.[0];
  const parts = c?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const t = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
  return t === '' ? null : t;
}

async function isExhausted(res: Response): Promise<boolean> {
  try {
    const b = (await res.json()) as { error?: { status?: unknown } } | null;
    return b?.error?.status === 'RESOURCE_EXHAUSTED';
  } catch {
    return false;
  }
}

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchFn: Fetch;
  constructor(model: string, apiKey: string, fetchFn: Fetch) {
    if (!MODEL_RE.test(model)) throw new Error('bad_model');
    if (!apiKey) throw new Error('no_key');
    this.model = model;
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
  }

  async generate(req: AiRequest): Promise<AiResult> {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, req.timeoutMs);
    try {
      const res = await this.fetchFn(`${GEMINI_BASE}${this.model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(geminiBody(req)),
        signal: ac.signal,
      });
      if (!res.ok) {
        const quota = res.status === 429 && (await isExhausted(res));
        if (!quota) await res.body?.cancel().catch(() => {});
        return { ok: false, reason: quota ? 'quota' : 'error', status: res.status };
      }
      const text = textOf(await res.json());
      if (text === null) return { ok: false, reason: 'error', status: res.status };
      try {
        return { ok: true, json: JSON.parse(text), raw: text };
      } catch {
        return { ok: false, reason: 'error', status: res.status };
      }
    } catch (e) {
      return { ok: false, reason: timedOut ? 'timeout' : 'error', errName: errNameOf(e) };
    } finally {
      clearTimeout(timer);
    }
  }
}
