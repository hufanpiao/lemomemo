// Gemini 适配（架构第 7 节、5.11；R-55 只实现这一个；B3 任务单 BE-1）。
// • 地址 generativelanguage.googleapis.com/v1beta/models/<model>:generateContent；模型名从 app_config.ai.model 读，由调用方传进来，不写死；
// • 密钥只放 x-goog-api-key 请求头，不进 URL（S-B3 低 6，TC-B3-24）；
// • 文字和 inlineData 音频（base64）两种内容；生成参数、responseMimeType、responseSchema 由调用方给（params.ts 一处）；
// • 超时经 _shared/net.ts 的 timedFetch（读正文也算在内），到点中止、不重试；
// • 429 且 status 是 RESOURCE_EXHAUSTED 当 quota（调用方写 ai_state.exhausted_until）；其他错误、返回不是 JSON、被拦下当 error；
//   quota 时另读回复体 error.details[]（google.rpc 标准错误详情，见 quotaInfo）分出每天 / 每分钟，只带出固定词和毫秒数；
// • 不打印请求体、返回正文和密钥（15.3 第 6 条、A23）；出错只回 HTTP 状态码。
// fetch 注入：单测和回放桩（BE-6）传假的，函数传全局 fetch。
import { timedFetch } from '../net.ts';
import { isObj } from '../obj.ts';
import { errNameOf, type AiPart, type AiRequest, type AiResult, type AIProvider, type QuotaKind } from './provider.ts';

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

// 429 回复体（google.rpc.Status 的 JSON；googleapis 的 google/rpc/error_details.proto）：
//   { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message, details: [
//       { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric, quotaId, quotaDimensions, quotaValue }] },
//       { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' } ] } }
// quotaId 是谷歌固定的限额名，如 GenerateRequestsPerDayPerProjectPerModel-FreeTier、GenerateRequestsPerMinutePerProjectPerModel-FreeTier、
// GenerateContentInputTokensPerModelPerMinute-FreeTier。只认里面的 PerDay / PerMinute 两个词，原文不带出去。
// 每天限额用完时 RetryInfo 也可能给一个很短的数（论坛实例：PerDay 配 retryDelay "1s"），所以 day 不看 retryDelay。
const QUOTA_FAILURE = 'type.googleapis.com/google.rpc.QuotaFailure';
const RETRY_INFO = 'type.googleapis.com/google.rpc.RetryInfo';
const PER_DAY = /PerDay(?![a-z])/;
const PER_MINUTE = /PerMinute(?![a-z])/;
/** google.protobuf.Duration 的 JSON 写法：秒数 + 可选小数（最多 9 位）+ s，如 "12s"、"0.5s"、"1.000340012s"；不认负数和别的写法 */
const DURATION = /^(\d{1,9})(?:\.(\d{1,9}))?s$/;


/** retryDelay → 毫秒（小数部分向上取整：文档说“至少等这么久”）；不合法 null */
export function retryDelayMs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = DURATION.exec(v);
  if (!m) return null;
  const nanos = Number((m[2] ?? '').padEnd(9, '0'));
  return Number(m[1]) * 1000 + Math.ceil(nanos / 1_000_000);
}

/**
 * 429 回复体 → 额度类型和建议等待；不是 RESOURCE_EXHAUSTED 回 null（当 error）。
 * 有一条 quotaId 带 PerDay 就是 day；全部带 PerMinute 才是 minute；没有 QuotaFailure、认不出、混着别的一律 unknown（调用方按 day）。
 */
export function quotaInfo(body: unknown): { quotaKind: QuotaKind; retryMs: number | null } | null {
  const err = isObj(body) ? body['error'] : null;
  if (!isObj(err) || err['status'] !== 'RESOURCE_EXHAUSTED') return null;
  const details = Array.isArray(err['details']) ? err['details'].filter(isObj) : [];
  const ids = details
    .filter((d) => d['@type'] === QUOTA_FAILURE)
    .flatMap((d) => (Array.isArray(d['violations']) ? d['violations'] : []))
    .map((v) => (isObj(v) ? v['quotaId'] : null));
  const strs = ids.filter((x): x is string => typeof x === 'string');
  const quotaKind: QuotaKind = strs.some((x) => PER_DAY.test(x))
    ? 'day'
    : ids.length > 0 && strs.length === ids.length && strs.every((x) => PER_MINUTE.test(x)) ? 'minute' : 'unknown';
  const retry = details.find((d) => d['@type'] === RETRY_INFO);
  return { quotaKind, retryMs: retry ? retryDelayMs(retry['retryDelay']) : null };
}

async function quotaOf(res: Response): Promise<{ quotaKind: QuotaKind; retryMs: number | null } | null> {
  try {
    return quotaInfo(await res.json());
  } catch {
    return null;
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
    try {
      const res = await timedFetch(this.fetchFn, req.timeoutMs)(`${GEMINI_BASE}${this.model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(geminiBody(req)),
      });
      if (!res.ok) {
        if (res.status !== 429) {
          await res.body?.cancel().catch(() => {});
          return { ok: false, reason: 'error', status: res.status };
        }
        // 429：quotaOf 已经 res.json() 把正文读完（读失败也算读过），不用再 cancel
        const quota = await quotaOf(res);
        return quota ? { ok: false, reason: 'quota', status: res.status, ...quota } : { ok: false, reason: 'error', status: res.status };
      }
      const text = textOf(await res.json());
      if (text === null) return { ok: false, reason: 'error', status: res.status };
      try {
        return { ok: true, json: JSON.parse(text), raw: text };
      } catch {
        return { ok: false, reason: 'error', status: res.status };
      }
    } catch (e) {
      // 这里没有别的中止来源：被中止（真 fetch 抛 TimeoutError，替身多抛 AbortError）就是到点了
      const name = errNameOf(e);
      return { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error', errName: name };
    }
  }
}
