// 随手记转成待办 / 日程的纯函数（B4 S8）：converted_to 的形状、一条随手记映射成目标行（标题规则用 note-headline.ts）、converted_to 的追加规则。
// R-414 的规则（负责人 11-13 定；只写在这里，别处写“规则见 shared/logic/notes/note-convert.ts 文件头”）：
//   ① 备注放不下（超过 ITEM_NOTE_MAX，即 2000 字）的不让转：界面菜单两项变淡（convertTooLong），数据层 convertNote 再判一次、返回 too_long；
//   ② 带插图的先弹确认窗（线框 S8-2），转换后原条保留（R-412、D-13，只记 converted_to）；不带图的原条进“最近删除”。
// 不变量：转出的行经 capture-map 的 captureRow 生成（没截止、没提醒、全天），原样能过 insertSchema；标题超长照它截短（不算超长）；
//   标题取自正文第一行时备注不再重复这一行（这一行被截短时备注放全文）；converted_to 最多 20 项，认不出的旧值不覆盖。
// 纯函数，不读时钟
import { z } from 'zod';
import type { DateStr } from '../../core/date.ts';
import type { Tz } from '../../core/tz.ts';
import { ITEM_NOTE_MAX, ITEM_TITLE_MAX } from '../../schema/rows.ts';
import { captureRow, type CaptureItem, type EventRow, type TodoRow } from '../capture-map.ts';
import { noteHeadline, str } from './note-headline.ts';

/** converted_to 最多几项（20 项按 jsonb::text 约 1.3 KB，库约束 notes_converted_to_size 是 2048 字节） */
export const CONVERTED_TO_MAX = 20;

export const convertedToSchema = z.array(z.strictObject({ kind: z.enum(['todo', 'event']), id: z.uuid() })).max(CONVERTED_TO_MAX);
export type ConvertedTo = z.infer<typeof convertedToSchema>;
export type ConvertKind = ConvertedTo[number]['kind'];

export interface ConvertCtx {
  /** 新条的 uuid */
  id: string;
  batchId: string;
  now: number;
  today: DateStr;
  tz: Tz;
}

export type ConvertTodoRow = Omit<TodoRow, 'from_note_id'> & { from_note_id: string };

export type ConvertRow = { table: 'todos'; row: ConvertTodoRow } | { table: 'events'; row: EventRow };

/** 转过去放进备注的那段字：标题取自正文第一行时是其余几行；那一行放不进标题时放全文，免得截掉的半行丢了 */
function convertBody(note: { title: unknown; body: unknown }, h = noteHeadline(note.title, note.body)): string {
  const src = h.fromBody && h.title.length > ITEM_TITLE_MAX ? str(note.body) : h.rest;
  return src.trim() === '' ? '' : src;
}

/** 备注放不下（超过 ITEM_NOTE_MAX，转过去会被截掉）：不让转（文件头规则 ①）。只看备注，标题截短不算 */
export function convertTooLong(note: { title: unknown; body: unknown }): boolean {
  return convertBody(note).length > ITEM_NOTE_MAX;
}

/** 一条随手记 → 待办或日程的一行；标题（含取自正文的）为空返回 null */
export function convertRow(note: { id: string; title: unknown; body: unknown }, kind: ConvertKind, ctx: ConvertCtx): ConvertRow | null {
  const h = noteHeadline(note.title, note.body);
  const body = convertBody(note, h);
  const item: CaptureItem = {
    kind, title: h.title, date: null, time: null, duration_min: null, due: null, important: false, project: null, body, short: null, anniv: null,
  };
  const r = captureRow(item, { ...ctx, source: 'page', rawText: '', origin: 'rule' });
  if (!r || r.table === 'anniversaries' || r.row.title === '') return null;
  return r.table === 'todos' ? { table: 'todos', row: { ...r.row, from_note_id: note.id } } : { table: 'events', row: r.row };
}

/** 原条 converted_to 加上新的一项：同 id 的旧项去掉、新的接在最后、超过上限去最旧的；原值认不出返回 null（不覆盖） */
export function convertedToAfter(prev: unknown, ref: ConvertedTo[number]): ConvertedTo | null {
  const p = convertedToSchema.safeParse(prev ?? []);
  if (!p.success) return null;
  return [...p.data.filter((x) => x.id !== ref.id), { kind: ref.kind, id: ref.id }].slice(-CONVERTED_TO_MAX);
}
