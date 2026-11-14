// Gemini 嵌入（架构 5.13 第 6 点“嵌入模型 gemini-embedding-2、取 768 维”；B4b-2）：note-search 算查询的向量、ai-embed 算条目的向量共用这一份。
// • 地址 GEMINI_BASE<model>:batchEmbedContents（一条也走 batch，回复形状只有一种）；模型名从 app_config.ai.embed_model 读、调用方传进来；
// • 密钥只放 x-goog-api-key 请求头（同 gemini.ts）；超时经 _shared/net.ts 的 timedFetch，到点中止、不重试；
// • gemini-embedding-2 不收 taskType（官方文档 2026-11 核对：只有 gemini-embedding-001 收），任务写在文字前缀里：
//   查询 “task: search result | query: …”，条目 “title: … | text: …”（没有标题写 title: none）；768 维模型自己归一化，这里不再除模长；
// • 429 RESOURCE_EXHAUSTED 当 quota（按 gemini.ts 的 quotaInfo 分出每天 / 每分钟），其他失败当 error，只带状态码和谷歌固定错误名；
// • 不打印请求体、返回、密钥（15.3 第 6 条、A23）。纯逻辑，fetch 注入，Vitest 直接测（tests/edge/embed.test.ts）。
import { timedFetch } from '../net.ts';
import { isObj } from '../obj.ts';
import { GEMINI_BASE, quotaInfo, rpcCodeOf, type Fetch } from './gemini.ts';
import { errNameOf, type QuotaKind } from './provider.ts';

export const EMBED_DIM = 768;
/** 一次最多送几条（batchEmbedContents 官方上限 100；ai-embed 每人一批用不到这么多） */
export const EMBED_BATCH_MAX = 100;
const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

export type EmbedResult =
  | { ok: true; vectors: number[][] }
  | { ok: false; reason: 'quota' | 'timeout' | 'error'; status?: number; errName?: string; quotaKind?: QuotaKind; retryMs?: number | null };

/** 查询那一边的文字（非对称检索） */
export const queryText = (q: string): string => `task: search result | query: ${q}`;
/** 条目那一边的文字 */
export const docText = (title: string, text: string): string => `title: ${title.trim() === '' ? 'none' : title.trim()} | text: ${text}`;

export function embedBody(model: string, texts: readonly string[]): Record<string, unknown> {
  return {
    requests: texts.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] }, outputDimensionality: EMBED_DIM })),
  };
}

/** 回复里的向量：条数要对、每条都是 768 个有限数，否则 null */
export function vectorsOf(body: unknown, n: number): number[][] | null {
  const list = isObj(body) ? body['embeddings'] : null;
  if (!Array.isArray(list) || list.length !== n) return null;
  const out: number[][] = [];
  for (const e of list) {
    const v = isObj(e) ? e['values'] : null;
    if (!Array.isArray(v) || v.length !== EMBED_DIM || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
    out.push(v as number[]);
  }
  return out;
}

/** 造一个嵌入函数；模型名不合法、没有密钥回 null（调用方当“AI 没配好”） */
export function geminiEmbed(model: string | null, apiKey: string | undefined, fetchFn: Fetch): ((texts: readonly string[], timeoutMs: number) => Promise<EmbedResult>) | null {
  if (!model || !MODEL_RE.test(model) || !apiKey) return null;
  return async (texts, timeoutMs) => {
    if (texts.length === 0 || texts.length > EMBED_BATCH_MAX) return { ok: false, reason: 'error' };
    try {
      const res = await timedFetch(fetchFn, timeoutMs)(`${GEMINI_BASE}${model}:batchEmbedContents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(embedBody(model, texts)),
      });
      if (res.status === 429) {
        let q: ReturnType<typeof quotaInfo> = null;
        try {
          q = quotaInfo(await res.json());
        } catch {
          q = null;
        }
        return q ? { ok: false, reason: 'quota', status: 429, ...q } : { ok: false, reason: 'error', status: 429 };
      }
      if (!res.ok) {
        const code = await rpcCodeOf(res);
        return code ? { ok: false, reason: 'error', status: res.status, errName: code } : { ok: false, reason: 'error', status: res.status };
      }
      const vectors = vectorsOf(await res.json(), texts.length);
      return vectors ? { ok: true, vectors } : { ok: false, reason: 'error', status: res.status };
    } catch (e) {
      const name = errNameOf(e);
      return { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error', errName: name };
    }
  };
}

/** halfvec 的文字写法 '[0.1,0.2,…]'：SQL 里 ${vecLiteral(v)}::extensions.halfvec */
export const vecLiteral = (v: readonly number[]): string => `[${v.join(',')}]`;
