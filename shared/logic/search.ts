// 本机关键词查找（B4 任务单 S4、硬约束 2；架构 1.3 B4 行、工期说明第 2 点、5.13 第 6 点“本机关键词先出”、0.29 续第 163 条；TC-B4-04）。
// B4 只做逻辑，不做页面搜索框（开发计划第 26 行 ②）；B4b-3 的“＋”查找、5.14 的 match-target 命中关都复用这里。
// 纯函数：不碰 DOM、不读设置、不联网，前端和 Edge Functions 共用（Deno 经 _shared/gen/）。
// 规则（中韩归一）：
//   • 归一：NFKC（全角转半角、韩文字母拼成音节）→ 小写 → 去掉所有空白、标点和零宽字符。emoji 等符号保留。
//   • 查询按空白和标点拆成几个词，**每个词都要命中**（任一字段里有就算），顺序不限。
//   • 韩文词整词没命中时，去掉末尾助词再试（词表在 search-data.ts）：最多连续去两层（“회의에서도”→“회의에서”→“회의”），
//     每去一层都要至少剩 2 个字。代价是少量误命中（查“고양이”会找出“고양시”），召回多一点可以接受（代码审查 11-10 第 3 条）。
//   • 已删除的（deleted_at 不为空）一律不出。
//   • 排序：词命中在第一个字段（标题）的多的排前面；分数一样的保持传入的顺序。
import { KO_TRAILING_PARTICLES } from './search-data.ts';

/** 去掉的字符：空白、标点、格式字符（零宽空格、ZWJ 等） */
const STRIP = /[\s\p{P}\p{Z}\p{Cf}]+/gu;
/** 拆查询词用：空白和标点 */
const SPLIT = /[\s\p{P}\p{Z}]+/u;
const HANGUL_END = /\p{Script=Hangul}$/u;
/** 查询最多取几个词（多余的丢掉，免得一句很长的话拖慢查找） */
export const MAX_TERMS = 16;

/** 归一：NFKC → 小写 → 去掉空白、标点、零宽字符 */
export function normalizeForSearch(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(STRIP, '');
}

/** 查询拆成归一后的词：去空、去重，最多 MAX_TERMS 个 */
export function queryTerms(q: string): string[] {
  const out: string[] = [];
  for (const raw of q.normalize('NFKC').split(SPLIT)) {
    const t = normalizeForSearch(raw);
    if (t !== '' && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/** 最多连续去掉几层助词 */
export const MAX_PARTICLE_LAYERS = 2;

/** 去掉助词后默认至少剩几个字 */
const KEEP_MIN = 2;

/** 一个词的几种写法：原词；韩文结尾的再依次加上去掉末尾助词的（最多两层，每层去完至少剩 keepMin 个字；泛指词表有单字词，传 1） */
export function termVariants(term: string, keepMin = KEEP_MIN): string[] {
  const v = [term];
  let cur = term;
  for (let layer = 0; layer < MAX_PARTICLE_LAYERS && HANGUL_END.test(cur); layer++) {
    const p = KO_TRAILING_PARTICLES.find((x) => cur.endsWith(x) && [...cur].length - [...x].length >= keepMin);
    if (p === undefined) break;
    cur = cur.slice(0, cur.length - p.length);
    v.push(cur);
  }
  return v;
}

export type Field = string | null | undefined;

/** 已归一的字段里找已拆好的词；全部命中返回分数（≥ 1），否则返回 0 */
function scoreNormalized(fields: readonly string[], terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  let score = 0;
  for (const t of terms) {
    const vs = termVariants(t);
    const at = fields.findIndex((f) => f !== '' && vs.some((v) => f.includes(v)));
    if (at < 0) return 0;
    score += at === 0 ? 2 : 1;
  }
  return score;
}

/**
 * 一组字段（第一个当标题）是否命中查询：每个词都要命中某个字段。
 * 返回 0 表示没命中；命中时返回分数（每个词命中标题记 2 分、命中别的字段记 1 分）。match-target 的命中关用它。
 */
export function matchScore(fields: readonly Field[], query: string): number {
  return scoreNormalized(fields.map((f) => normalizeForSearch(f ?? '')), queryTerms(query));
}

/** 条目上有 deleted_at 且不为空的不出（没有这一列的当没删） */
export interface Searchable { deleted_at?: number | null }

export interface SearchHit<T> { item: T; score: number }

/**
 * 在一组条目里找：fieldsOf 给出这条要查的字段，第一个当标题（随手记：标题、正文、分类名、标签、图片描述……）。
 * 查询为空（或只有空白、标点）返回空数组。limit 不传就全给。
 */
export function searchItems<T extends object>(
  items: readonly T[],
  query: string,
  fieldsOf: (item: T) => readonly Field[],
  opts: { limit?: number } = {},
): SearchHit<T>[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const hits: (SearchHit<T> & { i: number })[] = [];
  items.forEach((item, i) => {
    const del = (item as Searchable).deleted_at;
    if (del !== null && del !== undefined) return;
    const score = scoreNormalized(fieldsOf(item).map((f) => normalizeForSearch(f ?? '')), terms);
    if (score > 0) hits.push({ item, score, i });
  });
  hits.sort((a, b) => b.score - a.score || a.i - b.i);
  const out = hits.map(({ item, score }) => ({ item, score }));
  return opts.limit === undefined ? out : out.slice(0, Math.max(0, opts.limit));
}
