// 四家适配器（gemini.ts、openai.ts、claude.ts）和向量（embed.ts）共用的小件（R-494 AI 助手第 4 段）：
// • MODEL_RE、Fetch：后端只此一份（前端那份是 shared/schema/ai-provider.ts 的 MODEL_NAME_RE、迁移里 ai_user_keys.model 的 check，tests/edge/ai-adapters.test.ts 钉住三处一致）。
// • jsonSchemaOf：我们给 Gemini 写的 responseSchema（OpenAPI 子集：type 大写、nullable）→ 标准 JSON Schema（type 小写、可空写成 [t, 'null']），
//   三家的结构化输出都认标准写法；提示词、schema 照旧只写一份（params.ts、parse-core.ts 不动）。
// • post：发一次请求（四家同一个：timedFetch 超时、redirect: 'error' 不跟跳转），失败按 HTTP 状态归成 AiResult 的 quota / timeout / error
//   （只带状态码和固定词，不带服务商返回的正文，15.3 第 6 条）。归类默认 compatFail（OpenAI、DeepSeek、Claude），Gemini 传自己的（gemini.ts 的 geminiFail）。
//   compatFail：429 一律当 quota，错误体里有 insufficient_quota / billing 一类固定词的当每天（余额用完），其余当每分钟（限速），读不出当 unknown；402 当每天。
// • 密钥只放请求头，不进 URL、不进日志。
import { timedFetch } from '../net.ts';
import { isObj } from '../obj.ts';
import { errNameOf, type AiResult, type QuotaKind } from './provider.ts';

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type Fail = Extract<AiResult, { ok: false }>;

/** 模型名：字母数字和 . _ - :（防拼进路径；OpenAI 微调模型名带冒号） */
export const MODEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** Gemini 的 OpenAPI 子集 → 标准 JSON Schema（递归处理 properties、items；去掉 nullable、propertyOrdering） */
export function jsonSchemaOf(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(jsonSchemaOf);
  if (!isObj(s)) return s;
  // 逐个键换成新的 [键, 值]，再 Object.fromEntries 拼回（不用 out[k] = …：check_backend F7 不准拿变量当方括号键）
  const nullable = s['nullable'] === true;
  const entries = Object.entries(s).flatMap(([k, v]): [string, unknown][] => {
    if (k === 'nullable' || k === 'propertyOrdering') return [];
    if (k === 'type' && typeof v === 'string') return [[k, nullable ? [v.toLowerCase(), 'null'] : v.toLowerCase()]];
    if (k === 'properties' && isObj(v)) return [[k, Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, jsonSchemaOf(pv)]))]];
    if (k === 'items') return [[k, jsonSchemaOf(v)]];
    return [[k, v]];
  });
  return Object.fromEntries(entries);
}

/** 429 的回复体 → 每天还是每分钟（只认固定词，原文不带出去） */
export function quotaKindOf(body: unknown): QuotaKind {
  const err = isObj(body) ? body['error'] : null;
  const words = isObj(err) ? [err['code'], err['type']].filter((x): x is string => typeof x === 'string').join(' ') : '';
  if (/insufficient_quota|billing|credit/i.test(words)) return 'day';
  if (/rate_limit/i.test(words)) return 'minute';
  return 'unknown';
}

/** HTTP 失败归类：status 和读出来的错误体（读不出为 null）→ AiResult 的失败 */
export type FailOf = (status: number, body: unknown) => Fail;

/** OpenAI、DeepSeek、Claude 的归类（见文件头） */
export const compatFail: FailOf = (status, body) => {
  if (status === 429) return { ok: false, reason: 'quota', status, quotaKind: quotaKindOf(body), retryMs: null };
  if (status === 402) return { ok: false, reason: 'quota', status, quotaKind: 'day', retryMs: null };
  return { ok: false, reason: 'error', status };
};

/** 发一次 POST：成功回解析好的 JSON；失败读一次错误体交给 failOf 归类（四家和联网的 Tavily 共用） */
export function post(
  fetchFn: Fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, failOf: FailOf = compatFail,
): Promise<{ ok: true; body: unknown; status: number } | Fail> {
  return send(fetchFn, url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, timeoutMs, failOf);
}

/** 发一次 GET（联网的 Brave；参数在 url 的查询串里，密钥照样只放请求头）：同 post */
export function getJson(
  fetchFn: Fetch, url: string, headers: Record<string, string>, timeoutMs: number, failOf: FailOf = compatFail,
): Promise<{ ok: true; body: unknown; status: number } | Fail> {
  return send(fetchFn, url, { method: 'GET', headers: { accept: 'application/json', ...headers } }, timeoutMs, failOf);
}

async function send(fetchFn: Fetch, url: string, init: RequestInit, timeoutMs: number, failOf: FailOf): Promise<{ ok: true; body: unknown; status: number } | Fail> {
  try {
    const res = await timedFetch(fetchFn, timeoutMs)(url, { ...init, redirect: 'error' });
    if (!res.ok) {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      return failOf(res.status, parsed);
    }
    return { ok: true, body: await res.json(), status: res.status };
  } catch (e) {
    const name = errNameOf(e);
    return { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error', errName: name };
  }
}

/** 模型回的文字里取 JSON：去掉 ```json 围栏再解析；解析不了 null */
export function parseJsonText(t: string): unknown {
  const s = t.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
