// 本机分类行（categories 集合）→ 名字、归属（随手记和隐私记共用；11-14 隐私记列表行照线框 s9 显示分类时从 notes/data/note-list.ts 原样挪来，
// features 之间不能互相 import）
// • categoryResolver：条目的 category_id 顺着 merged_into 归到留下的那个活着的分类；绕成圈时照 shared 的 keepFirst 留一个
// • categoryNames：活着的分类（含绕成圈、还没写回的那个）id → 名字
// 纯 TS：不准 import React（A1）
import { isLiveCategory, isLiveRow, type CategoryRow } from '../../shared/logic/live-row.ts';
import { keepFirst } from '../../shared/logic/notes/category-merge.ts';
import { str } from '../../shared/logic/notes/note-headline.ts';

export type Row = { readonly id: string } & Readonly<Record<string, unknown>>;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 本机集合里的分类行 → shared 的 CategoryRow（名字、sort 取不到当空串、0；其余列原样带着，isLiveCategory 照看）：合并提示、成环取舍共用这一份 */
export const categoryRow = (c: Row): CategoryRow & Row => ({ ...c, name: str(c['name']), sort: num(c['sort']) });

/** 活着的分类（isLiveCategory；绕成圈、还没写回的那个也算，见 categoryResolver）：id → 名字 */
export function categoryNames(categories: readonly Row[]): Map<string, string> {
  const keep = new Set(cycleKeepers(categories));
  const out = new Map<string, string>();
  for (const c of categories) if (isLiveCategory(c) || keep.has(c.id)) out.set(c.id, str(c['name']));
  return out;
}

/**
 * 条目的 category_id → 归到哪个活着的分类：顺着 merged_into 走（合并过的归到留下的那个），走不到活着的为 null。
 * 两台设备各合并一次可能绕成圈（A → B、B → A）：圈里照 shared 的 keepFirst 留一个，不把两个分类下的条目都变成没分类——
 *   这只是写回之前的显示兜底，notes 的 category-merge-store.ts 的 fixCategoryCycles 会给它写 merged_into: null，之后全按 isLiveCategory。
 * “条目归哪个分类”只在这里定：随手记列表、分类胶囊、编辑页（note-edit.ts 的 formOf）、隐私记列表都经它
 */
export function categoryResolver(categories: readonly Row[]): (id: unknown) => string | null {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const first = (a: Row, b: Row): Row => (keepFirst(categoryRow(a), categoryRow(b)) <= 0 ? a : b);
  return (id) => {
    const path: Row[] = [];
    for (let cur = id; typeof cur === 'string'; ) {
      const c = byId.get(cur);
      if (!c || !isLiveRow(c)) return null;
      if (isLiveCategory(c)) return cur;
      const at = path.indexOf(c);
      if (at >= 0) return path.slice(at).reduce(first).id;
      path.push(c);
      cur = c['merged_into'];
    }
    return null;
  };
}

/** 绕成圈时圈里留下的那几个分类：categoryResolver 归到自己、却还不是 isLiveCategory 的（等着写回 merged_into: null） */
export function cycleKeepers(categories: readonly Row[]): string[] {
  const target = categoryResolver(categories);
  return categories.filter((c) => isLiveRow(c) && !isLiveCategory(c) && target(c.id) === c.id).map((c) => c.id);
}

/** 条目的 category_id → 显示用的分类名（归不到活着的分类为 null） */
export function categoryNameOf(categories: readonly Row[]): (id: unknown) => string | null {
  const resolve = categoryResolver(categories);
  const names = categoryNames(categories);
  return (id) => {
    const cid = resolve(id);
    return cid === null ? null : (names.get(cid) ?? null);
  };
}
