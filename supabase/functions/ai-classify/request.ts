// ai-classify 送 AI 的请求和读回（代码审查 11-10 必改 3：从 core.ts 拆出来）。纯函数，不碰库、不联网。
// 用户写的东西（随手记的标题和正文、用户起的分类名）只放在 <data> 里（安全审 11-10 建议 4）。
import { CLASSIFY_TIMEOUT_MS, TASK_PARAMS } from '../_shared/ai/params.ts';
import { CLASSIFY_CAN_CREATE, CLASSIFY_CANNOT_CREATE, CLASSIFY_RULES } from '../_shared/ai/prompts/classify.v2.ts';
import type { AiRequest } from '../_shared/ai/provider.ts';

/** 架构 5.2：分类名最多 12 个字（数据库 check 也是 1～12） */
export const CATEGORY_NAME_MAX = 12;
/** 每条随手记送 AI 的文字最多几个字（标题 + 正文开头） */
export const NOTE_TEXT_MAX = 600;

export interface PendingNote {
  id: string;
  user_id: string;
  title: string | null;
  body: string | null;
  tags: readonly string[] | null;
  category_source: string;
  ai_meta: unknown;
}

const CONTROL = /[\p{Cc}\p{Cf}]/u;
const TRIM = /^[\s\p{P}]+|[\s\p{P}]+$/gu;

/** 模型给的分类名：去头尾空白和标点，不许有控制字符，1～12 个字（按码点，和数据库 char_length 一致） */
export function cleanCategoryName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFC').replace(TRIM, '');
  const n = [...s].length;
  if (n < 1 || n > CATEGORY_NAME_MAX || CONTROL.test(s)) return null;
  return s;
}

/** 送 AI 的一条：标题 + 正文，最多 NOTE_TEXT_MAX 个字 */
export function noteText(n: Pick<PendingNote, 'title' | 'body'>): string {
  const s = [n.title ?? '', n.body ?? ''].filter((x) => x.trim() !== '').join('\n');
  return [...s].slice(0, NOTE_TEXT_MAX).join('');
}

/** responseSchema（Gemini OpenAPI 子集，类型大写） */
export const CLASSIFY_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { i: { type: 'INTEGER' }, category: { type: 'STRING' }, new: { type: 'BOOLEAN' } },
        required: ['i', 'category', 'new'],
      },
    },
    // v2（R-413）：意思差不多、该合成一个的已有分类对；不是必填（没有就空数组或不给）
    similar: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { a: { type: 'STRING' }, b: { type: 'STRING' } }, required: ['a', 'b'] },
    },
  },
  required: ['items'],
});

/** 一次最多认几对相似分类（30 个分类里真像的不会多，多了多半是模型乱给） */
export const SIMILAR_MAX = 10;

/**
 * 组请求：系统提示只填“能不能新建”和名字长度；分类名单和随手记都放进 <data>（安全审 11-10 建议 4：分类名是用户写的，也只当数据）。
 * <data> 是 JSON：{"categories":[…],"notes":[{i,text}]}，'<' 转义，免得文字里写 </data> 跳出去。
 */
export function classifyRequest(notes: readonly Pick<PendingNote, 'title' | 'body'>[], catNames: readonly string[], canCreate: boolean): AiRequest {
  const system = CLASSIFY_RULES
    .replace('{{CAN_CREATE}}', canCreate ? CLASSIFY_CAN_CREATE : CLASSIFY_CANNOT_CREATE)
    .replace('{{NAME_MAX}}', String(CATEGORY_NAME_MAX));
  const data = JSON.stringify({ categories: catNames, notes: notes.map((n, i) => ({ i, text: noteText(n) })) }).replace(/</g, '\\u003c');
  return { system, parts: [{ text: `<data>${data}</data>` }], schema: CLASSIFY_SCHEMA, params: TASK_PARAMS.classify, timeoutMs: CLASSIFY_TIMEOUT_MS };
}

/** 模型返回的每一项：编号在范围内、分类名合格；同一个编号只认第一次。返回 编号 → {name, isNew} */
export function readItems(json: unknown, count: number): Map<number, { name: string; isNew: boolean }> {
  const out = new Map<number, { name: string; isNew: boolean }>();
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    if (typeof it !== 'object' || it === null) continue;
    const o = it as Record<string, unknown>;
    const i = o['i'];
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= count || out.has(i)) continue;
    const name = cleanCategoryName(o['category']);
    if (name === null) continue;
    out.set(i, { name, isNew: o['new'] === true });
  }
  return out;
}

/**
 * 模型给的相似分类对（R-413）：两个名字都要在 catNames 里（按 normalize 比，和 writeAi 认分类名同一口径）、不是同一个；
 * 同一对（不分先后）只认一次，最多 SIMILAR_MAX 对。返回 catNames 里的原名对
 */
export function readSimilar(json: unknown, catNames: readonly string[], normalize: (s: string) => string): [string, string][] {
  const list = (json as { similar?: unknown } | null)?.similar;
  if (!Array.isArray(list)) return [];
  const byKey = new Map<string, string>();
  for (const n of catNames) {
    const k = normalize(n);
    if (k !== '' && !byKey.has(k)) byKey.set(k, n);
  }
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const it of list) {
    if (out.length >= SIMILAR_MAX) break;
    if (typeof it !== 'object' || it === null) continue;
    const o = it as Record<string, unknown>;
    if (typeof o['a'] !== 'string' || typeof o['b'] !== 'string') continue;
    const ka = normalize(o['a']);
    const kb = normalize(o['b']);
    const a = byKey.get(ka);
    const b = byKey.get(kb);
    if (a === undefined || b === undefined || ka === kb) continue;
    const pair = JSON.stringify(ka < kb ? [ka, kb] : [kb, ka]);
    if (seen.has(pair)) continue;
    seen.add(pair);
    out.push([a, b]);
  }
  return out;
}
