// 随手记转成待办 / 日程的纯函数（B4 S8）：converted_to 的形状、一条随手记映射成目标行（标题规则用 note-headline.ts）、converted_to 的追加规则。
// 不变量：转出的行经 capture-map 的 captureRow 生成（没截止、没提醒、全天），原样能过 insertSchema；
//   标题、备注按 UTF-16 单元截且不截半个字；标题取自正文第一行时备注不再重复这一行；converted_to 最多 20 项，认不出的旧值不覆盖。
// 纯函数，不读时钟
import { z } from 'zod';
import type { DateStr } from '../../core/date.ts';
import type { Tz } from '../../core/tz.ts';
import { captureRow, type CaptureItem, type EventRow, type TodoRow } from '../capture-map.ts';
import { cutGraphemes } from '../short.ts';
import { noteHeadline } from './note-headline.ts';

/** converted_to 最多几项（20 项按 jsonb::text 约 1.3 KB，库约束 notes_converted_to_size 是 2048 字节） */
export const CONVERTED_TO_MAX = 20;

export const convertedToSchema = z.array(z.strictObject({ kind: z.enum(['todo', 'event']), id: z.uuid() })).max(CONVERTED_TO_MAX);
export type ConvertedTo = z.infer<typeof convertedToSchema>;
export type ConvertKind = ConvertedTo[number]['kind'];

/** 待办、日程标题和备注的上限（UTF-16 单元，同 shared/schema/rows.ts 的 title max(160)、note max(2000)） */
const ITEM_TITLE_MAX = 160;
const ITEM_NOTE_MAX = 2000;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface ConvertCtx {
  /** 新条的 uuid */
  id: string;
  batchId: string;
  now: number;
  today: DateStr;
  tz: Tz;
}

export type ConvertTodoRow = Omit<TodoRow, 'from_note_id'> & { from_note_id: string };

/** truncated：随手记的内容没能全部放进新条（备注截到了 2000） */
export type ConvertRow = ({ table: 'todos'; row: ConvertTodoRow } | { table: 'events'; row: EventRow }) & { truncated: boolean };

/** 一条随手记 → 待办或日程的一行；标题（含取自正文的）为空返回 null */
export function convertRow(note: { id: string; title: unknown; body: unknown }, kind: ConvertKind, ctx: ConvertCtx): ConvertRow | null {
  const h = noteHeadline(note.title, note.body);
  const title = cutGraphemes(h.title, ITEM_TITLE_MAX);
  if (title === '') return null;
  // 取自正文的第一行被截短了：备注放全文，免得截掉的半行丢了
  const src = h.fromBody && title.length < h.title.length ? str(note.body) : h.rest;
  const body = src.trim() === '' ? '' : src;
  const noteText = cutGraphemes(body, ITEM_NOTE_MAX);
  const truncated = noteText.length < body.length || (!h.fromBody && title.length < h.title.length);
  const item: CaptureItem = {
    kind, title, date: null, time: null, duration_min: null, due: null, important: false, project: null, body: noteText, short: null, anniv: null,
  };
  const r = captureRow(item, { ...ctx, source: 'page', rawText: '', origin: 'rule' });
  if (r?.table === 'todos') return { table: 'todos', row: { ...r.row, from_note_id: note.id }, truncated };
  if (r?.table === 'events') return { table: 'events', row: r.row, truncated };
  return null;
}

/** 原条 converted_to 加上新的一项：同 id 的旧项去掉、新的接在最后、超过上限去最旧的；原值认不出返回 null（不覆盖） */
export function convertedToAfter(prev: unknown, ref: ConvertedTo[number]): ConvertedTo | null {
  const p = convertedToSchema.safeParse(prev ?? []);
  if (!p.success) return null;
  return [...p.data.filter((x) => x.id !== ref.id), { kind: ref.kind, id: ref.id }].slice(-CONVERTED_TO_MAX);
}
