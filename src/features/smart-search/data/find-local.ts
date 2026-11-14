// 本机关键词查找（B4b-2，架构 5.13 第 6 点“立即：本机关键词查找，马上出结果”、5.14 第 3 点；线框 s12、sFind；R-112、R-118）
// • 查哪些（主页面，scope=main）：日程（标题、地点、备注、原话）、待办（标题、备注、项目、原话）、纪念日（名字、备注；主持人范围里加的）、
//   随手记（标题、正文、标签）、图片（AI 描述、标签）、文档（文件名、抽出的文字、AI 描述、标签）。
//   删除、撤销的不出；隐私记（notes.is_private）、隐私记的图片（bucket = vault-images）和文档（is_vault）一律不出（D-16：主页面不查隐私记）；
//   图片、文档所属的随手记已删、是隐私记的也不出。
// • 命中规则只经 shared/logic/search.ts（中韩归一、每个词都要命中、韩文去助词），这里不另写一套；排序同它（命中标题的多的在前）。
// • 时间筛选（线框 s12“任何时间 / 上周 / 这个月”）：日程按日期、待办按截止日、纪念日按下一次的日子、随手记和它的图片文档按创建那天（current_tz）；
//   选了时间而这一条没有日子（没截止日的待办）就不出。
// • 合并“意思相近”（mergeFind）：服务器只回 [{kind, id, score}]，这里只认本机缓存里还活着的条目（删了、隐私记的、本机还没有的丢掉）。
//   两边都中 → 最相关；其余关键词的 → 关键词找到；只有意思中的 → 意思相近（按分数）。
// 纯 TS：不准 import React（A1）；不读时钟、不读设置，now、tz 由调用方给
import { addDays, fmtHm, todayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { firstOfMonth, lastOfMonth, monthOf, startOfWeek } from '../../../../shared/logic/calendar/cal-nav.ts';
import { placeEvent, type CalEvent } from '../../../../shared/logic/calendar/cal-items.ts';
import { isShownFile } from '../../../../shared/logic/files/shown-file.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import { noteHeadline, str } from '../../../../shared/logic/notes/note-headline.ts';
import { normalizeForSearch, queryTerms, searchItems, termVariants } from '../../../../shared/logic/search.ts';

export type Row = Readonly<Record<string, unknown>> & { readonly id: string };
export const FIND_KINDS = ['event', 'todo', 'anniv', 'note', 'image', 'file'] as const;
export type FindKind = (typeof FIND_KINDS)[number];
/** 服务器 note-search 回的 kind（note_vectors 的五种；纪念日没有向量） */
export type SemKind = Exclude<FindKind, 'anniv'>;

export interface FindSources {
  events: readonly Row[];
  todos: readonly Row[];
  anniversaries: readonly Row[];
  notes: readonly Row[];
  note_images: readonly Row[];
  note_files: readonly Row[];
}

/** 一条可查的条目（建索引时一次算好） */
export interface FindItem {
  kind: FindKind;
  id: string;
  /** 第一行（随手记没有标题时取正文第一行；图片取 AI 描述） */
  title: string;
  /** 要查的字段，第一个当标题 */
  fields: readonly string[];
  /** 时间筛选用的日子；没有为 null */
  date: DateStr | null;
  /** 日程的时刻（HH:MM）；别的为 null */
  time: string | null;
  /** 第二行补充：日程地点、待办项目、文档所在随手记的标题 */
  extra: string;
  /** 图片、文档所在的随手记（打开时去这一条）；别的为 null */
  noteId: string | null;
  /** 待办做完了 */
  done: boolean;
  /** 图片：有没有缩略图 */
  hasThumb: boolean;
}

export const keyOf = (kind: FindKind, id: string): string => `${kind}:${id}`;

const tags = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const dateStr = (v: unknown): DateStr | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const createdDay = (r: Row, tz: Tz): DateStr | null => (typeof r['created_at'] === 'number' ? todayOf(r['created_at'], tz) : null);

/** 本机缓存 → 可查的条目（隐私记、删了的、撤销的不进；见文件头） */
export function buildIndex(src: FindSources, tz: Tz): FindItem[] {
  const out: FindItem[] = [];
  const base = { time: null, extra: '', noteId: null, done: false, hasThumb: false };
  for (const r of src.events) {
    if (!isLiveRow(r)) continue;
    const title = str(r['title']);
    // 日子、时刻按 4.6 换算到设备时区（B4b-3：时间类查找“下周的日程”按换算后的那天算）；格式坏了的照原值
    const p = placeEvent(r as unknown as CalEvent, tz);
    out.push({ ...base, kind: 'event', id: r.id, title, fields: [title, str(r['location']), str(r['note']), str(r['raw_text'])],
      date: p?.date ?? dateStr(r['date']), time: p ? (p.allDay ? null : fmtHm(p.startMin)) : typeof r['time'] === 'string' ? r['time'] : null, extra: str(r['location']) });
  }
  for (const r of src.todos) {
    if (!isLiveRow(r)) continue;
    const title = str(r['title']);
    out.push({ ...base, kind: 'todo', id: r.id, title, fields: [title, str(r['note']), str(r['project']), str(r['raw_text'])],
      date: dateStr(r['due']), extra: str(r['project']), done: r['done'] === true });
  }
  for (const r of src.anniversaries) {
    if (!isLiveRow(r)) continue;
    const title = str(r['name']);
    out.push({ ...base, kind: 'anniv', id: r.id, title, fields: [title, str(r['note'])], date: dateStr(r['next_date']) });
  }
  // 随手记：先记下活着的普通随手记（图片、文档要靠它判断能不能出、取标题）
  const notes = new Map<string, { title: string; date: DateStr | null }>();
  for (const r of src.notes) {
    if (!isLiveRow(r) || r['is_private'] === true) continue;
    const h = noteHeadline(r['title'], r['body']);
    const date = createdDay(r, tz);
    notes.set(r.id, { title: h.title, date });
    out.push({ ...base, kind: 'note', id: r.id, title: h.title, fields: [h.title, h.rest, tags(r['tags']).join(' ')], date });
  }
  for (const r of src.note_images) {
    const parent = notes.get(str(r['note_id']));
    const desc = str(r['ai_desc']);
    // 没有描述的图片没有可查的字（描述由服务器 ai-media 识图写，还没识别好的查不到）；隐私记的图片（vault-images）不出
    if (!parent || !isLiveRow(r) || r['bucket'] === 'vault-images' || desc === '') continue;
    out.push({ ...base, kind: 'image', id: r.id, title: desc, fields: [desc, tags(r['ai_tags']).join(' ')], date: parent.date,
      extra: parent.title, noteId: str(r['note_id']), hasThumb: r['has_thumb'] === true });
  }
  for (const r of src.note_files) {
    const parent = notes.get(str(r['note_id']));
    if (!parent || !isShownFile(r)) continue;
    const name = str(r['name']);
    out.push({ ...base, kind: 'file', id: r.id, title: name,
      fields: [name, str(r['text_excerpt']), str(r['ai_desc']), tags(r['ai_tags']).join(' ')], date: parent.date,
      extra: parent.title, noteId: str(r['note_id']) });
  }
  return out;
}

export type TimeFilter = 'any' | 'lastWeek' | 'thisMonth';

/** 时间筛选的起止（含两头）；any 为 null。周一起算（同 intent.ts 的整周） */
export function rangeOf(f: TimeFilter, now: number, tz: Tz): { from: DateStr; to: DateStr } | null {
  const today = todayOf(now, tz);
  if (f === 'lastWeek') {
    const from = addDays(startOfWeek(today, 1), -7);
    return { from, to: addDays(from, 6) };
  }
  if (f === 'thisMonth') {
    const ym = monthOf(today);
    return { from: firstOfMonth(ym), to: lastOfMonth(ym) };
  }
  return null;
}

export interface FindHit {
  item: FindItem;
  /** 关键词分数（只有意思中的为 0） */
  score: number;
  /** 正文、抽出的文字里命中的那一小段（没有为 null） */
  snippet: string | null;
}

/** 片段前后各留几个字 */
const SNIP_BEFORE = 10;
const SNIP_AFTER = 26;

/**
 * 查询词在原文里出现的位置（大小写、全角半角不计；空白、标点不算进词）：给高亮和片段用。
 * 查找本身按归一后的文字比（shared/logic/search.ts），这里只在原文里找词本身，找不到的（中间夹了空格、标点）就不高亮，不影响命中
 */
export function markRanges(text: string, q: string): [number, number][] {
  const hay = text.normalize('NFKC').toLowerCase();
  // NFKC 可能改变长度（全角英数是一对一，合成谚文字母不是）：长度不一样就不标，免得标错位置
  if (hay.length !== text.length) return [];
  const out: [number, number][] = [];
  for (const t of queryTerms(q)) {
    // 原词没有就试去掉助词的写法，用第一个找得到的
    const v = termVariants(t).find((x) => hay.includes(x));
    if (v === undefined) continue;
    for (let at = hay.indexOf(v); at >= 0; at = hay.indexOf(v, at + v.length)) out.push([at, at + v.length]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** 命中位置前后截一段（单行），两头被截掉时加“…” */
export function snippetOf(text: string, q: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  const r = markRanges(flat, q)[0];
  if (!r) return null;
  const from = Math.max(0, r[0] - SNIP_BEFORE);
  const to = Math.min(flat.length, r[1] + SNIP_AFTER);
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`;
}

/** 第二个起哪个字段里有片段（标题本身命中就不另给片段，日程、待办、纪念日不给片段） */
function snippetFor(it: FindItem, q: string): string | null {
  if (it.kind !== 'note' && it.kind !== 'file') return null;
  const body = it.fields[1] ?? '';
  return body === '' ? null : snippetOf(body, q);
}

/** 按时间筛选（range 为 null 原样）：没有日子的不出 */
export function inRange(index: readonly FindItem[], range: { from: DateStr; to: DateStr } | null): readonly FindItem[] {
  return range === null ? index : index.filter((it) => it.date !== null && it.date >= range.from && it.date <= range.to);
}

/** 关键词查找：查询为空返回空数组 */
export function findLocal(index: readonly FindItem[], q: string): FindHit[] {
  return searchItems(index, q, (it) => it.fields).map(({ item, score }) => ({ item, score, snippet: snippetFor(item, q) }));
}

/** 查询够不够格送服务器按意思找：归一后至少 2 个字（架构 5.13 第 6 点） */
export const semReady = (q: string): boolean => [...normalizeForSearch(q)].length >= 2;

export interface SemHit {
  kind: SemKind;
  id: string;
  score: number;
}

export interface FindGroups {
  /** 关键词和意思都对上 */
  top: FindHit[];
  /** 只有关键词 */
  kw: FindHit[];
  /** 只有意思相近 */
  sem: FindHit[];
}

/**
 * 合并：sem 为 null（还在找、只按关键词）时全部放“关键词找到”。
 * 意思相近的只认 index 里有的（本机还活着、不是隐私记、在时间筛选范围内由调用方先筛好 index）
 */
export function mergeFind(kw: readonly FindHit[], sem: readonly SemHit[] | null, index: readonly FindItem[], q: string): FindGroups {
  if (sem === null) return { top: [], kw: [...kw], sem: [] };
  const semKeys = new Set(sem.map((h) => keyOf(h.kind, h.id)));
  const kwKeys = new Set(kw.map((h) => keyOf(h.item.kind, h.item.id)));
  const byKey = new Map(index.map((it) => [keyOf(it.kind, it.id), it]));
  const top = kw.filter((h) => semKeys.has(keyOf(h.item.kind, h.item.id)));
  const rest = kw.filter((h) => !semKeys.has(keyOf(h.item.kind, h.item.id)));
  const only: FindHit[] = [];
  const seen = new Set(kwKeys);
  for (const h of [...sem].sort((a, b) => b.score - a.score)) {
    const k = keyOf(h.kind, h.id);
    const it = byKey.get(k);
    if (!it || seen.has(k)) continue;
    seen.add(k);
    only.push({ item: it, score: 0, snippet: snippetFor(it, q) });
  }
  return { top, kw: rest, sem: only };
}

/** 各类型条数（胶囊上的数字）；all 是总数 */
export function countKinds(g: FindGroups): Record<FindKind | 'all', number> {
  const n = { all: 0, event: 0, todo: 0, anniv: 0, note: 0, image: 0, file: 0 };
  for (const h of [...g.top, ...g.kw, ...g.sem]) {
    n[h.item.kind] += 1;
    n.all += 1;
  }
  return n;
}

/** 只留某一类（胶囊选了一类）；all 原样 */
export function onlyKind(g: FindGroups, kind: FindKind | 'all'): FindGroups {
  if (kind === 'all') return g;
  const pick = (xs: FindHit[]) => xs.filter((h) => h.item.kind === kind);
  return { top: pick(g.top), kw: pick(g.kw), sem: pick(g.sem) };
}
