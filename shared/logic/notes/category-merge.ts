// 合并相近分类的判定（B4 任务单 S7；架构 5.2 末条“发现有分类彼此很像 → 提示‘要合并分类吗？’”；TC-B4-07）。
// 只判哪几对像，不写库：提示写到哪里（架构只写了“写一条通知”，库里还没有通知表）待架构师定；前端也可以直接拿分类列表算。
// 两个分类算“像”（都要没删、没合并掉，按 search.ts 的中韩归一比）：
//   ① 归一后一样（“工作 ”和“工作”、全角半角、大小写不同）；
//   ② 一个包含另一个，且短的那个至少 2 个字（“购物”和“购物清单”；“书”和“书单”不算，单字太容易误中）；
//   ③ 都至少 3 个字、只差一个字（增、删、换一个字：“读书笔记”和“读书笔迹”）。
// 每对建议留下 sort 小的（一样就留名字短的、再按 id），把另一个合并进去。纯函数：前端和 Edge Functions 共用。
import { normalizeForSearch } from '../search.ts';

export interface MergeCategory {
  id: string;
  name: string;
  sort?: number;
  deleted_at?: number | null;
  merged_into?: string | null;
}

export interface MergePair {
  /** 建议留下的 */
  keep: string;
  /** 建议合并进 keep 的 */
  merge: string;
  why: 'same' | 'contains' | 'one_char';
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

/** 找出彼此很像的分类对；同一对只出一次，按 keep 的 sort 先后 */
export function similarCategoryPairs(categories: readonly MergeCategory[]): MergePair[] {
  const live = categories
    .filter((c) => (c.deleted_at === null || c.deleted_at === undefined) && (c.merged_into === null || c.merged_into === undefined))
    .map((c) => ({ c, n: normalizeForSearch(c.name) }))
    .filter((x) => x.n !== '')
    .sort((x, y) => (x.c.sort ?? 0) - (y.c.sort ?? 0) || [...x.c.name].length - [...y.c.name].length || (x.c.id < y.c.id ? -1 : 1));
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
