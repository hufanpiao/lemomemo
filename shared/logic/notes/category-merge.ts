// 合并相近分类的判定（B4 任务单 S7；架构 5.2 末条“发现有分类彼此很像 → 提示‘要合并分类吗？’”；TC-B4-07）。
// 只判哪几对像，不写库：前端拿分类列表算、提示“要合并分类吗？”，忽略的记在 settings notes.merge_dismissed（B4 任务单待定项 7）。
// 两个分类算“像”（都要活着，即 live-row.ts 的 isLiveCategory；按 search.ts 的中韩归一比）：
//   ① 归一后一样（“工作 ”和“工作”、全角半角、大小写不同）；
//   ② 一个包含另一个，且短的那个至少 2 个字（“购物”和“购物清单”；“书”和“书单”不算，单字太容易误中）；
//   ③ 都至少 3 个字、只差一个字（增、删、换一个字：“读书笔记”和“读书笔迹”）。
// 每对建议留下 sort 小的（一样就留名字短的、再按 id），把另一个合并进去。纯函数。
// R-413（负责人 11-13 定“分类很像交给 AI 判断”）：ai-classify 分类时一并判断哪几对意思差不多（“读书”和“书单”），
//   记在 settings notes.merge_suggest（只有 ai-classify 写；RLS 不拦本人写这一行，读的当不可信值）；要提示的是 AI 判的这些加上上面三条本机规则判的（openPairs），去掉点过“不用”的。
//   两个键的值是同一种：排好序的 [小 id, 大 id] 数组，最多 PAIRS_MAX 对，满了去最旧的（idPairs 读、withPairs 加；客户端和 ai-classify 共用）。
import { isLiveCategory, type CategoryRow } from '../live-row.ts';
import { normalizeForSearch } from '../search.ts';

export interface MergePair {
  /** 建议留下的 */
  keep: string;
  /** 建议合并进 keep 的 */
  merge: string;
  /** ai：AI 判的（notes.merge_suggest）；其余是本机规则 */
  why: 'ai' | 'same' | 'contains' | 'one_char';
}

/** 用户点过“不用”的各对（客户端写） */
export const MERGE_DISMISSED_KEY = 'notes.merge_dismissed';
/** AI 判出来很像的各对（ai-classify 写，客户端代码只读；RLS 并不拦本人写） */
export const MERGE_SUGGEST_KEY = 'notes.merge_suggest';
/** 每个键最多记几对（一对 uuid 按 jsonb 文字约 82 字节，40 对约 3.3 KB，settings.value 的库约束是 4096 字节） */
export const PAIRS_MAX = 40;

export type Pair = [string, string];
const sorted = (a: string, b: string): Pair => (a < b ? [a, b] : [b, a]);
const samePair = (x: Pair, y: Pair): boolean => x[0] === y[0] && x[1] === y[1];

/** 存的值 → 排好序的各对；不是数组当空，坏项丢掉 */
export function idPairs(value: unknown): Pair[] {
  if (!Array.isArray(value)) return [];
  const out: Pair[] = [];
  for (const v of value as unknown[]) {
    if (!Array.isArray(v) || v.length !== 2) continue;
    const [a, b] = v as unknown[];
    if (typeof a === 'string' && typeof b === 'string' && a !== '' && b !== '' && a !== b) out.push(sorted(a, b));
  }
  return out;
}

/** 加上几对（不分先后，已有的、两个一样的跳过），新的接在最后，超过 PAIRS_MAX 去最旧的；一对都没加上原样返回（同一个数组，不产生写入） */
export function withPairs(list: readonly Pair[], add: readonly (readonly [string, string])[]): readonly Pair[] {
  let out: Pair[] | null = null;
  for (const [a, b] of add) {
    if (a === b || a === '' || b === '') continue;
    const p = sorted(a, b);
    if ((out ?? list).some((x) => samePair(x, p))) continue;
    out = [...(out ?? list), p];
  }
  return out === null ? list : out.slice(-PAIRS_MAX);
}

/** 两串差不差一个字（按码点；长度差超过 1 直接不算） */
function oneEdit(a: readonly string[], b: readonly string[]): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let diff = 0;
  while (i < a.length && j < b.length) {
    if (a.at(i) === b.at(j)) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}

function why(a: string, b: string): MergePair['why'] | null {
  if (a === b) return 'same';
  const ca = [...a];
  const cb = [...b];
  const short = Math.min(ca.length, cb.length);
  if (short >= 2 && (a.includes(b) || b.includes(a))) return 'contains';
  if (short >= 3 && oneEdit(ca, cb)) return 'one_char';
  return null;
}

/** 一对里留哪个：sort 小的在前，一样就名字短的、再按 id */
const keepFirst = (a: CategoryRow, b: CategoryRow): number =>
  (a.sort ?? 0) - (b.sort ?? 0) || [...a.name].length - [...b.name].length || (a.id < b.id ? -1 : 1);

/** 找出彼此很像的分类对；同一对只出一次，按 keep 的 sort 先后 */
export function similarCategoryPairs(categories: readonly CategoryRow[]): MergePair[] {
  const live = categories
    .filter(isLiveCategory)
    .map((c) => ({ c, n: normalizeForSearch(c.name) }))
    .filter((x) => x.n !== '')
    .sort((x, y) => keepFirst(x.c, y.c));
  const out: MergePair[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (!a || !b) continue;
      const w = why(a.n, b.n);
      if (w) out.push({ keep: a.c.id, merge: b.c.id, why: w });
    }
  }
  return out;
}

/**
 * 要提示的几对（R-413）：AI 判的（suggested）在前、本机规则判的接在后面，同一对只出一次；两个分类都要活着；点过“不用”的（dismissed）去掉。
 * keep 和 merge 的口径同 similarCategoryPairs（AI 只说哪两个像，留哪个照 sort 定）
 */
export function openPairs(categories: readonly CategoryRow[], suggested: readonly Pair[], dismissed: readonly Pair[]): MergePair[] {
  const live = new Map(categories.filter(isLiveCategory).filter((c) => normalizeForSearch(c.name) !== '').map((c) => [c.id, c] as const));
  const ai: MergePair[] = [];
  for (const [x, y] of suggested) {
    const a = live.get(x);
    const b = live.get(y);
    if (a && b) ai.push(keepFirst(a, b) < 0 ? { keep: a.id, merge: b.id, why: 'ai' } : { keep: b.id, merge: a.id, why: 'ai' });
  }
  const out: MergePair[] = [];
  for (const p of [...ai, ...similarCategoryPairs(categories)]) {
    const k = sorted(p.keep, p.merge);
    if (dismissed.some((d) => samePair(d, k)) || out.some((o) => samePair(sorted(o.keep, o.merge), k))) continue;
    out.push(p);
  }
  return out;
}

/** ai-classify 用（R-413）：在存的 notes.merge_suggest 上加 AI 这次判的几对，去掉分类已经不在 live 里的；什么都没变回 null（不写） */
export function addSuggested(cur: unknown, add: readonly (readonly [string, string])[], live: ReadonlySet<string>): Pair[] | null {
  const old = idPairs(cur);
  const kept = old.filter(([a, b]) => live.has(a) && live.has(b));
  const next = withPairs(kept, add.filter(([a, b]) => live.has(a) && live.has(b)));
  return next === kept && kept.length === old.length ? null : [...next];
}
