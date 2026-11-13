// 随手记列表的数据逻辑（B4 S1、S2；定稿线框 s7；皮肤视觉稿“随手记：瀑布流 / 列表”）
// • 只列普通随手记：删了的（deleted_at）、撤销了的（undone）、隐私记（is_private，B5）不出
// • 排序：最近记的在前（created_at 倒序，一样的按 id），新记的一条出现在最上面
// • 分组（列表方式）：今天 / 昨天 / 日期（按 current_tz 算哪一天）
// • 没有标题时取正文前两行当标题（线框 s7 注）：第一行当标题，第二行起当摘要
// • “AI”小标：AI 分过类、用户还没看过（category_source = 'ai' 且 category_seen = false）
// • “已转过”（R-415 ③）：converted_to 至少一项（转成过待办 / 日程，带图保留的原条、恢复回来的原条都会有）
// • 分类胶囊：全部 + 有条目的分类和条数（按条数多的在前，一样的按分类的 sort、名字）；条目的分类顺着 merged_into 归到留下的那个
// • 分类色点（视觉稿第 1322、1341 行，6px）：颜色取 categories.color（架构：小写 #rrggbb，或皮肤令牌名）；
//   令牌名只认皮肤里有的项目色 p1～p6（画深色那一档 --pNs），别的认不出、没设颜色的不画点
// • 插图（S3，视觉稿 PH.mason）：卡片顶部放第一张（按 id 排，id 是 UUID v7、按插入先后），右上角“+N”是另外还有几张
// 纯 TS：不准 import React（A1）
import { addDays, todayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { isLiveCategory, isLiveRow, type CategoryRow } from '../../../../shared/logic/live-row.ts';
import { keepFirst } from '../../../../shared/logic/notes/category-merge.ts';
import { noteHeadline, str } from '../../../../shared/logic/notes/note-headline.ts';

export type Row = { readonly id: string } & Readonly<Record<string, unknown>>;

export interface NoteItem {
  id: string;
  title: string;
  summary: string;
  categoryId: string | null;
  categoryName: string | null;
  /** 分类色点的 CSS 颜色；没有就不画点 */
  categoryColor: string | null;
  /** 显示“AI”小标 */
  ai: boolean;
  /** 转成过待办 / 日程（converted_to 至少一项；R-415 ③ 负责人定方案丙：标题前“已转过”描边小标） */
  converted: boolean;
  createdAt: number;
  date: DateStr;
  /** 第一张插图（没有为 null） */
  cover: NoteImage | null;
  /** 一共几张插图 */
  images: number;
}

/** 一张插图（note_images 一行里界面要的） */
export interface NoteImage {
  id: string;
  noteId: string;
  path: string;
  hasThumb: boolean;
  width: number;
  height: number;
}

export interface NoteGroup {
  key: 'today' | 'yesterday' | 'day';
  date: DateStr;
  items: NoteItem[];
}

export interface CategoryCount {
  id: string;
  name: string;
  color: string | null;
  count: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 本机集合里的分类行 → shared 的 CategoryRow（名字、sort 取不到当空串、0；其余列原样带着，isLiveCategory 照看）：合并提示、成环取舍共用这一份 */
export const categoryRow = (c: Row): CategoryRow & Row => ({ ...c, name: str(c['name']), sort: num(c['sort']) });
const alive = (r: Row): boolean => isLiveRow(r) && r['is_private'] !== true;

/** 标题和摘要：有标题就用标题、摘要是正文；没有标题取正文第一行当标题，后面的（第二行起）当摘要 */
export function titleAndSummary(title: unknown, body: unknown): { title: string; summary: string } {
  const h = noteHeadline(title, body);
  const summary = h.rest
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join(' ');
  return { title: h.title, summary };
}

/** 显示“AI”小标：AI 分过的、还没看过 */
export function showsAi(row: Row): boolean {
  return row['category_source'] === 'ai' && row['category_seen'] === false;
}

/** categories.color → CSS 颜色：#rrggbb 照用；p1～p6 用皮肤的项目色深色档；别的（没设、认不出）为 null，不画点 */
export function categoryColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const m = /^p([1-6])$/.exec(v);
  return m ? `var(--p${m[1]}s)` : null;
}

/** 分类 id → 颜色（这里不筛：调用方只拿 categoryResolver 归到的活着的分类来取） */
function categoryColors(categories: readonly Row[]): Map<string, string | null> {
  return new Map(categories.map((c) => [c.id, categoryColor(c['color'])]));
}

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
 *   这只是写回之前的显示兜底，category-merge-store.ts 的 fixCategoryCycles 会给它写 merged_into: null，之后全按 isLiveCategory。
 * “条目归哪个分类”只在这里定：列表、分类胶囊、编辑页（note-edit.ts 的 formOf）都经它
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

/** 活着的插图，按随手记分好、每条里按 id（插入先后）排 */
export function imagesByNote(images: readonly Row[]): Map<string, NoteImage[]> {
  const out = new Map<string, NoteImage[]>();
  for (const r of images) {
    if (!isLiveRow(r) || r['bucket'] !== 'images') continue;
    const noteId = str(r['note_id']);
    const path = str(r['path']);
    if (noteId === '' || path === '') continue;
    const list = out.get(noteId) ?? [];
    list.push({ id: r.id, noteId, path, hasThumb: r['has_thumb'] === true, width: num(r['width']), height: num(r['height']) });
    out.set(noteId, list);
  }
  for (const l of out.values()) l.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** 列表要的条目（已筛掉删了的、隐私记），最近记的在前；category 不为 null 时只留这个分类的 */
export function noteItems(rows: readonly Row[], categories: readonly Row[], tz: Tz, category: string | null = null, images: readonly Row[] = []): NoteItem[] {
  const names = categoryNames(categories);
  const target = categoryResolver(categories);
  const pics = imagesByNote(images);
  const colors = categoryColors(categories);
  const out: NoteItem[] = [];
  for (const r of rows) {
    if (!alive(r)) continue;
    const cid = target(r['category_id']);
    if (category !== null && cid !== category) continue;
    const createdAt = num(r['created_at']);
    out.push({
      id: r.id,
      ...titleAndSummary(r['title'], r['body']),
      categoryId: cid,
      categoryName: cid === null ? null : (names.get(cid) ?? null),
      categoryColor: cid === null ? null : (colors.get(cid) ?? null),
      ai: cid !== null && showsAi(r),
      converted: Array.isArray(r['converted_to']) && r['converted_to'].length > 0,
      createdAt,
      date: todayOf(createdAt, tz),
      cover: pics.get(r.id)?.[0] ?? null,
      images: pics.get(r.id)?.length ?? 0,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 某个时刻落在今天、昨天，还是更早的某天（瀑布流卡片、电脑抽屉顶行的时间写法） */
export function dayKind(at: number, now: number, tz: Tz): 'today' | 'yesterday' | 'day' {
  const d = todayOf(at, tz);
  const today = todayOf(now, tz);
  return d === today ? 'today' : d === addDays(today, -1) ? 'yesterday' : 'day';
}

/** 列表方式的分组：今天 / 昨天 / 各日期（items 已按时间倒序） */
export function groupByDay(items: readonly NoteItem[], now: number, tz: Tz): NoteGroup[] {
  const today = todayOf(now, tz);
  const yesterday = addDays(today, -1);
  const out: NoteGroup[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.date === it.date) last.items.push(it);
    else out.push({ key: it.date === today ? 'today' : it.date === yesterday ? 'yesterday' : 'day', date: it.date, items: [it] });
  }
  return out;
}

/** 分类胶囊：有条目的分类和条数（隐私记、删了的不算） */
export function categoryCounts(rows: readonly Row[], categories: readonly Row[], locale: string): CategoryCount[] {
  const names = categoryNames(categories);
  const target = categoryResolver(categories);
  const colors = categoryColors(categories);
  const sortOf = new Map(categories.map((c) => [c.id, num(c['sort'])]));
  const n = new Map<string, number>();
  for (const r of rows) {
    const cid = alive(r) ? target(r['category_id']) : null;
    if (cid !== null) n.set(cid, (n.get(cid) ?? 0) + 1);
  }
  return [...n]
    .map(([id, count]) => ({ id, name: names.get(id) ?? '', color: colors.get(id) ?? null, count }))
    .sort((a, b) => b.count - a.count || (sortOf.get(a.id) ?? 0) - (sortOf.get(b.id) ?? 0) || a.name.localeCompare(b.name, locale));
}

/** 活着的普通随手记一共几条（“全部 N”） */
export function aliveCount(rows: readonly Row[]): number {
  let n = 0;
  for (const r of rows) if (alive(r)) n++;
  return n;
}
