// ai-media 送 AI 的请求和读回（照 ai-classify/request.ts 的拆法）。纯函数，不碰库、不联网。
// 图片放 inlineData（webp 缩略图，≤ 384 px，Gemini 按 258 个 token 计，架构 5.13 第 5 点）；<data> 里只有编号，没有用户写的字。
// 读回（readResults）：编号在范围内、同一编号只认第一次；描述和标签都过 cleanText——去控制字符、把 6 位以上的连续数字换成“…”
//   （证件号码不进描述，5.13 第 5 点；提示词也要求了，这里是第二道；夹空格、横线、点的和全角数字也拦），描述 ≤ DESC_MAX 字、标签 ≤ TAG_MAX 字、最多 TAGS_MAX 个、去重；
//   描述清完是空的这一张不认（按这张没成，走退避）。
import { MEDIA_TIMEOUT_MS, TASK_PARAMS } from '../_shared/ai/params.ts';
import { MEDIA_LANG_KO, MEDIA_LANG_ZH, MEDIA_RULES } from '../_shared/ai/prompts/media.v1.ts';
import type { AiRequest } from '../_shared/ai/provider.ts';

/** 库里 ai_desc 的 check：≤ 200 字（0003）；提示词让模型写短一点，这里按库的上限截 */
export const DESC_MAX = 200;
/** 库里 ai_tags 的 check：最多 12 个（0003） */
export const TAGS_MAX = 12;
/** 一个标签最多几个字（库里不限，防模型写成句子） */
export const TAG_MAX = 20;
/** 提示词里要模型写多短（库的上限留余地） */
export const DESC_ASK = 60;

const CONTROL = /[\p{Cc}\p{Cf}]/gu;
/** 6 位以上数字，中间可以夹空格、横线、点（卡号 1234 5678…、电话 010-1234-5678）；全角数字先换成半角（不用 NFKC：会把中文标点也换成半角） */
const FULL_DIGIT = /[０-９]/g;
const LONG_DIGITS = /\d(?:[\s.-]*\d){5,}/gu;
const TAG_TRIM = /^[\s\p{P}]+|[\s\p{P}]+$/gu;

const cut = (s: string, n: number): string => [...s].slice(0, n).join('');

/** 模型给的一段字：NFC、全角数字换半角、去控制字符、合并空白、6 位以上数字（可夹空格、横线、点）换成“…”、截到 max 字 */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v.normalize('NFC').replace(FULL_DIGIT, (d) => String(d.charCodeAt(0) - 0xff10)).replace(CONTROL, '').replace(/\s+/g, ' ').trim().replace(LONG_DIGITS, '…');
  return cut(s, max).trim();
}

/** 标签：去头尾标点、过 cleanText，空的、太长的（像句子）不要，同一个只留一次，最多 TAGS_MAX 个 */
export function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (out.length >= TAGS_MAX) break;
    const t = cleanText(typeof x === 'string' ? x.replace(TAG_TRIM, '') : x, TAG_MAX + 1);
    if (t === '' || [...t].length > TAG_MAX || out.includes(t)) continue;
    out.push(t);
  }
  return out;
}

export const MEDIA_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    results: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { i: { type: 'INTEGER' }, desc: { type: 'STRING' }, tags: { type: 'ARRAY', items: { type: 'STRING' } } },
        required: ['i', 'desc', 'tags'],
      },
    },
  },
  required: ['results'],
});

export type MediaLocale = 'zh-CN' | 'ko-KR';

/** 组请求：系统提示填语言和长度；<data> 只放编号，图片按同样顺序跟在后面 */
export function mediaRequest(images: readonly { mime: string; bytes: Uint8Array }[], locale: MediaLocale): AiRequest {
  const system = MEDIA_RULES.replace('{{LANG}}', locale === 'ko-KR' ? MEDIA_LANG_KO : MEDIA_LANG_ZH).replace('{{DESC_MAX}}', String(DESC_ASK)).replace('{{TAGS_MAX}}', String(TAGS_MAX));
  const data = JSON.stringify({ images: images.map((_, i) => i) });
  return {
    system,
    parts: [{ text: `<data>${data}</data>` }, ...images.map((im) => ({ inlineData: { mimeType: im.mime, data: im.bytes } }))],
    schema: MEDIA_SCHEMA,
    params: TASK_PARAMS.media,
    timeoutMs: MEDIA_TIMEOUT_MS,
  };
}

/** 读回：编号 → {desc, tags}；不合格的编号不在里面 */
export function readResults(json: unknown, count: number): Map<number, { desc: string; tags: string[] }> {
  const out = new Map<number, { desc: string; tags: string[] }>();
  const list = (json as { results?: unknown } | null)?.results;
  if (!Array.isArray(list)) return out;
  for (const it of list) {
    if (typeof it !== 'object' || it === null) continue;
    const o = it as Record<string, unknown>;
    const i = o['i'];
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= count || out.has(i)) continue;
    const desc = cleanText(o['desc'], DESC_MAX);
    if (desc === '') continue;
    out.set(i, { desc, tags: cleanTags(o['tags']) });
  }
  return out;
}
