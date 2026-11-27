// Gemini 适配（架构第 7 节、5.11；R-55 只实现这一个；B3 任务单 BE-1）。
// • 地址 generativelanguage.googleapis.com/v1beta/models/<model>:generateContent；模型名从 app_config.ai.model 读，由调用方传进来，不写死；
// • 密钥只放 x-goog-api-key 请求头，不进 URL（S-B3 低 6，TC-B3-24）；
// • 文字和 inlineData 音频（base64）两种内容；生成参数、responseMimeType、responseSchema 由调用方给（params.ts 一处）；
// • 发请求经 compat.ts 的 post（四家同一个：timedFetch 超时、读正文也算在内、redirect: 'error'），到点中止、不重试；失败归类用这里的 geminiFail：
// • 429 且 status 是 RESOURCE_EXHAUSTED 当 quota（调用方写 ai_state.exhausted_until，按服务商分行）；其他错误、返回不是 JSON、被拦下当 error；
//   quota 时另读回复体 error.details[]（google.rpc 标准错误详情，见 quotaInfo）分出每天 / 每分钟，只带出固定词和毫秒数；
//   400 时密钥不对（ErrorInfo.reason = API_KEY_INVALID）errName 记 API_KEY_INVALID，别的 400（请求体不对等）照旧记 INVALID_ARGUMENT（试调据此分“密钥不对”和“其他”）；
// • 不打印请求体、返回正文和密钥（15.3 第 6 条、A23）；出错只回 HTTP 状态码和谷歌的固定错误名。
// fetch 注入：单测和回放桩（BE-6）传假的，函数传全局 fetch。
import { isObj } from '../obj.ts';
import { MODEL_RE, post, type Fail, type Fetch } from './compat.ts';
import {
  PROVIDER_CAPS, type AiPart, type AiRequest, type AiResult, type AIProvider, type ChatImage, type ChatProvider, type ChatRequest, type ChatResult,
  type ProviderCaps, type QuotaKind, type ToolCall, type ToolResult,
} from './provider.ts';

export type { Fetch } from './compat.ts';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

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

/** google.rpc.Code 的固定名字（googleapis code.proto）：只认这几个，别的一律不带 */
const RPC_CODES = new Set([
  'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED',
]);

/**
 * 非 429 的失败：读回复体里 error.status（如 503 的 UNAVAILABLE），只认 RPC_CODES 里的固定名字，别的（message、details、正文）一律不带。
 * 11-13 ai-eval #3：32 句 503，日志只有状态码，分不出是谷歌过载还是别的。读不出回 undefined。
 */
export function rpcCodeOf(body: unknown): string | undefined {
  const err = isObj(body) ? body['error'] : null;
  const code = isObj(err) ? err['status'] : null;
  return typeof code === 'string' && RPC_CODES.has(code) ? code : undefined;
}

const ERROR_INFO = 'type.googleapis.com/google.rpc.ErrorInfo';
/** 400 里密钥不对的那一种：error.details 里 ErrorInfo 的 reason 是 API_KEY_INVALID（谷歌固定词） */
function keyInvalid(body: unknown): boolean {
  const err = isObj(body) ? body['error'] : null;
  const details = isObj(err) && Array.isArray(err['details']) ? err['details'].filter(isObj) : [];
  return details.some((d) => d['@type'] === ERROR_INFO && d['reason'] === 'API_KEY_INVALID');
}

/** Gemini 的失败归类（compat.ts 的 post 用；generate、chat、embed 共用） */
export function geminiFail(status: number, body: unknown): Fail {
  if (status === 429) {
    const quota = quotaInfo(body);
    return quota ? { ok: false, reason: 'quota', status, ...quota } : { ok: false, reason: 'error', status };
  }
  const code = status === 400 && keyInvalid(body) ? 'API_KEY_INVALID' : rpcCodeOf(body);
  return code ? { ok: false, reason: 'error', status, errName: code } : { ok: false, reason: 'error', status };
}

// ===== 多轮对话和工具调用（R-492；provider.ts 的 ChatProvider）=====
// • 历史 user → role user、assistant → role model，只有文字；
// • 工具说明放 tools[0].functionDeclarations，parameters 由 JSON Schema 子集转成 Gemini 的 OpenAPI 子集（type 大写）；toolConfig 用 AUTO；
// • 同一轮里的往返：模型回的那段 content 原样（带 thoughtSignature、functionCall.id）记进 turn.state.extra，下一次接在历史后面原样发回去
//   （Gemini 3 要求“所有部分原样回传”，缺签名直接报错），再跟一段 role user 的 functionResponse；
// • functionCall 没给 id 的由这里编 call_<序号>，交回 functionResponse 时只带谷歌自己给的 id；
// • 文字只取不是 thought 的部分；失败的归类和 generate() 同一套（post：quotaOf、rpcCodeOf、超时）。

/** 我们的 JSON Schema 子集 → Gemini 的 OpenAPI 子集（type 转大写，其余键照抄，递归处理 properties、items） */
export function toGeminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!isObj(s)) return s;
  return Object.fromEntries(Object.entries(s).map(([k, v]): [string, unknown] => {
    if (k === 'type' && typeof v === 'string') return [k, v.toUpperCase()];
    if (k === 'properties' && isObj(v)) return [k, Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]))];
    return [k, k === 'items' ? toGeminiSchema(v) : v];
  }));
}

export type GContent = { role: 'user' | 'model'; parts: Record<string, unknown>[] };
/** turn.state：这一轮里接在历史后面的几段（模型的原样回复和我们交回的工具结果）；ids：我们给的 id → 谷歌给的 id（谷歌没给为 null） */
interface GeminiTurn {
  extra: GContent[];
  ids: ReadonlyMap<string, string | null>;
  /** 这一轮已经编到第几个 id（跨几次往返不重号） */
  seq: number;
}

const isGeminiTurn = (v: unknown): v is GeminiTurn => isObj(v) && Array.isArray(v['extra']) && v['ids'] instanceof Map && typeof v['seq'] === 'number';

/** 对话请求体（单测核对键名、往返时原样回传的部分）。extra：这一轮已有的往返（第一次为空） */
export function geminiChatBody(req: ChatRequest, extra: readonly GContent[]): Record<string, unknown> {
  const last = req.messages.length - 1;
  const contents: GContent[] = [
    ...req.messages.map((m, i): GContent => ({
      role: m.role === 'user' ? 'user' : 'model',
      // 用户这一句带的图接在这一句的文字后面（只在最后一条；历史里没有图）
      parts: [{ text: m.text }, ...(i === last && m.role === 'user' ? (req.images ?? []).map(imagePart) : [])],
    })),
    ...extra,
  ];
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents,
    ...(req.tools.length > 0 ? {
      tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }],
      toolConfig: { functionCallingConfig: { mode: req.toolChoice === 'none' ? 'NONE' : 'AUTO' } },
    } : {}),
    generationConfig: { temperature: req.params.temperature, candidateCount: req.params.candidateCount },
  };
}

/** 一张图 → inlineData 段 */
const imagePart = (im: ChatImage): Record<string, unknown> => ({ inlineData: { mimeType: im.mimeType, data: toBase64(im.data) } });

/**
 * 交回工具结果的那一段（role user）：每个结果一段 functionResponse，谷歌给过 id 的原样带上；
 * 结果带图的（看随手记的图），图按结果的顺序接在全部 functionResponse 后面（结果 JSON 里写了第几张是哪条记录的）
 */
function responsesOf(results: readonly ToolResult[], ids: ReadonlyMap<string, string | null>): GContent {
  return {
    role: 'user',
    parts: [
      ...results.map((r) => {
        const gid = ids.get(r.id);
        return { functionResponse: { name: r.name, response: { result: r.result }, ...(typeof gid === 'string' ? { id: gid } : {}) } };
      }),
      ...results.flatMap((r) => (r.images ?? []).map(imagePart)),
    ],
  };
}

/** 模型回的第一个候选 → 原样的 content、文字（不含 thought）、工具调用（编好 id）；什么都没有回 null */
function readChat(body: unknown, seq: number): { content: GContent; text: string; calls: ToolCall[]; ids: Map<string, string | null>; seq: number } | null {
  const c = (body as { candidates?: { content?: { parts?: unknown } }[] } | null)?.candidates?.[0];
  const parts = c?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const raw = parts.filter(isObj);
  let text = '';
  const calls: ToolCall[] = [];
  const ids = new Map<string, string | null>();
  let n = seq;
  for (const p of raw) {
    if (typeof p['text'] === 'string' && p['thought'] !== true) text += p['text'];
    const fc = p['functionCall'];
    if (isObj(fc) && typeof fc['name'] === 'string') {
      n += 1;
      const id = `call_${n}`;
      ids.set(id, typeof fc['id'] === 'string' ? fc['id'] : null);
      calls.push({ id, name: fc['name'], args: isObj(fc['args']) ? fc['args'] : {} });
    }
  }
  if (text === '' && calls.length === 0) return null;
  return { content: { role: 'model', parts: raw }, text, calls, ids, seq: n };
}

export class GeminiProvider implements AIProvider, ChatProvider {
  readonly name = 'gemini';
  /** Gemini：工具调用、图片、音频、向量都有（联网 11-23 起改用 Brave / Tavily，见 websearch.ts） */
  readonly caps: ProviderCaps = PROVIDER_CAPS.gemini;
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

  /** 发一次 generateContent（compat.ts 的 post + geminiFail；generate、chat 共用） */
  private post(body: Record<string, unknown>, timeoutMs: number): Promise<{ ok: true; body: unknown; status: number } | Fail> {
    return post(this.fetchFn, `${GEMINI_BASE}${this.model}:generateContent`, { 'x-goog-api-key': this.apiKey }, body, timeoutMs, geminiFail);
  }

  async generate(req: AiRequest): Promise<AiResult> {
    const r = await this.post(geminiBody(req), req.timeoutMs);
    if (!r.ok) return r;
    const text = textOf(r.body);
    if (text === null) return { ok: false, reason: 'error', status: r.status };
    try {
      return { ok: true, json: JSON.parse(text), raw: text };
    } catch {
      return { ok: false, reason: 'error', status: r.status };
    }
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    // 接着上一次：只认自己产生的 turn（别家的、形状不对的当出错，不发请求）
    let turn: GeminiTurn = { extra: [], ids: new Map(), seq: 0 };
    if (req.resume) {
      const st = req.resume.turn.state;
      if (req.resume.turn.provider !== this.name || !isGeminiTurn(st)) return { ok: false, reason: 'error', errName: 'bad_turn' };
      turn = { extra: [...st.extra, responsesOf(req.resume.results, st.ids)], ids: st.ids, seq: st.seq };
    }
    const r = await this.post(geminiChatBody(req, turn.extra), req.timeoutMs);
    if (!r.ok) return r;
    const got = readChat(r.body, turn.seq);
    if (got === null) return { ok: false, reason: 'error', status: r.status };
    const next: GeminiTurn = { extra: [...turn.extra, got.content], ids: new Map([...turn.ids, ...got.ids]), seq: got.seq };
    return { ok: true, text: got.text, toolCalls: got.calls, turn: { provider: this.name, state: next } };
  }
}
