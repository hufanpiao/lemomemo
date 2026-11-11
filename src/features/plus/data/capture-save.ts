// 记下来、撤销（B3 任务单 FA-1；架构 5.1 末尾、5.9；架构审 M5、M10；TC-B3-04、05）
// • 一句话拆出的几条：每条一个 uuid，共用一个 batch_id；行一律经 shared/logic/capture-map.ts 的 captureRow 生成（M10），
//   这里不自己拼列。AI 给了 short 才写 short（short_by='ai'）；没给时不写，显示时取 shared/logic/short.ts 的 itemShort（TC-B3-05）
// • 不写 ai_status（M5）
// • 写入只经 core/write.ts 的 write（先进 outbox）；带不带提醒用 shared 的 remindAtOf 本机现算（同编辑页）
// • 有一条没写进去：已写的几条立刻撤回，整批当没保存（调用方提示“没保存上”、保留原话）
// • 撤销 capture.undo(batch_id)：还没发出的 write.patch 会和 insert 抵消；已发出的写 undone=true（H10）。
//   纪念日表没有 undone 列：B3 只开日程、待办（任务单 Q7），纪念日的撤销等 B4 定，这里先原样报“没撤”
// 纯 TS：不准 import React（A1）
import { todayOf, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';
import { captureRow, type CaptureCtx, type CaptureItem, type CaptureRow } from '../../../../shared/logic/capture-map.ts';
import { remindAtOf } from '../../../../shared/logic/remind.ts';
import { saveUndone } from '../../../core/edit-save.ts';
import { remindLive, todoRemindAfter, todoRemindFields } from '../../../core/remind-flag.ts';
import { write, type WriteFailReason, type WriteResult } from '../../../core/write.ts';

/** 写入口（测试换成桩） */
export interface Writer {
  insert(table: string, data: Record<string, unknown> & { id: string }, opts?: { remind?: boolean }): Promise<WriteResult>;
  patch(table: string, id: string, data: Record<string, unknown>): Promise<WriteResult>;
}

export interface SaveInput {
  items: readonly CaptureItem[];
  rawText: string;
  source: CaptureCtx['source'];
  origin: CaptureCtx['origin'];
  now: number;
  tz: Tz;
  /** 没说日子的日程、只说了时刻的待办记到哪天：一般是今天；日历页是选中的那天（R-353） */
  day?: DateStr;
  /** 加进已有的一批（R-166：确认行选完的那一条加进同一个 batch_id，“全部撤销”照样一起撤）；不给就新开一批 */
  batchId?: string;
}

/** 写进去的一条（撤销、逐条改用） */
export interface SavedRef {
  table: CaptureRow['table'];
  id: string;
}

export type SaveResult =
  /** at：每一条写进去的行对应 items 里第几条（随手记等没生成行的跳过） */
  | { ok: true; batchId: string; saved: SavedRef[]; at: number[]; remind: boolean }
  | { ok: false; reason: WriteFailReason | 'nothing' };

const newId = (): string => crypto.randomUUID();

/** 这一行带不带提醒（outbox 据此整条提前发） */
export function remindOf(r: CaptureRow, now: number, tz: Tz): boolean {
  switch (r.table) {
    case 'events':
      return remindLive(remindAtOf('event', r.row, tz, now), now);
    case 'todos':
      return todoRemindAfter(todoRemindFields({ ...r.row }), now, tz, undefined);
    case 'anniversaries':
      return false;
    default: {
      const never: never = r;
      return never;
    }
  }
}

/** 识别结果 → 要写的几行（随手记等 captureRow 不认的跳过）。纯函数，单测直接测 */
export function rowsOf(input: SaveInput, ids: () => string = newId): { batchId: string; rows: CaptureRow[]; at: number[] } {
  const batchId = input.batchId ?? ids();
  const today = input.day ?? todayOf(input.now, input.tz);
  const rows: CaptureRow[] = [];
  const at: number[] = [];
  for (const [i, item] of input.items.entries()) {
    const ctx: CaptureCtx = {
      id: ids(), batchId, now: input.now, today, tz: input.tz, source: input.source, rawText: input.rawText, origin: input.origin,
    };
    const r = captureRow(item, ctx);
    if (r) {
      rows.push(r);
      at.push(i);
    }
  }
  return { batchId, rows, at };
}

/** 记下来（整批；有一条没写进去就整批撤回） */
export async function saveCapture(input: SaveInput, w: Writer = write, ids: () => string = newId): Promise<SaveResult> {
  const { batchId, rows, at } = rowsOf(input, ids);
  if (rows.length === 0) return { ok: false, reason: 'nothing' };
  const saved: SavedRef[] = [];
  let remind = false;
  for (const r of rows) {
    const flag = remindOf(r, input.now, input.tz);
    // deleted_at、undone 只能 update（shared/schema/rows.ts 的 insertSchema 去掉了它们），新增时不带，由库的默认值给（null、false）；
    // 这里剔掉只是兜底：capture-map 的新增行已不带这两列（tests/shared/capture-map-insert.test.ts 会拦）
    const { deleted_at: _deleted, undone: _undone, ...row }: { id: string; deleted_at?: unknown; undone?: unknown } = r.row;
    const res = await w.insert(r.table, row, { remind: flag });
    if (!res.ok) {
      await undoRefs(saved, input.now, w);
      return { ok: false, reason: res.reason };
    }
    saved.push({ table: r.table, id: r.row.id });
    remind ||= flag;
  }
  return { ok: true, batchId, saved, at, remind };
}

/** 撤销这几条；返回没撤成的（纪念日、写失败的） */
export async function undoRefs(refs: readonly SavedRef[], now: number, w: Writer = write): Promise<SavedRef[]> {
  const left: SavedRef[] = [];
  for (const ref of refs) {
    if (ref.table === 'anniversaries') {
      left.push(ref);
      continue;
    }
    if ((await saveUndone(ref.table, ref.id, now, w)) !== 'saved') left.push(ref);
  }
  return left;
}
