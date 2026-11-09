// 记下来、撤销（data/capture-save.ts；B3 任务单 FA-1；架构审 M5、M10；TC-B3-04、05）
import { describe, expect, it, vi } from 'vitest';
import type { WriteResult } from '../../../core/write.ts';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { insertSchema, type WritableTable } from '../../../../shared/schema/rows.ts';
import { rowsOf, saveCapture, undoRefs, type Writer } from '../data/capture-save.ts';

/** 2026-11-02 10:00 首尔 */
const NOW = Date.UTC(2026, 10, 2, 1, 0);
const TZ = 'Asia/Seoul';

const item = (over: Partial<AiItem> = {}): AiItem => ({
  kind: 'todo', title: 'buy milk', date: null, time: null, duration_min: null, due: null, important: false,
  project: null, body: null, short: null, date_basis: null, anniv: null, confirm: null, ...over,
});

let n = 0;
const ids = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const OK: WriteResult = { ok: true, item: null };
const FAIL: WriteResult = { ok: false, reason: 'local_unavailable' };

function writer(fail: number | null = null): Writer & { insert: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> } {
  let i = 0;
  return {
    insert: vi.fn(async (): Promise<WriteResult> => (i++ === fail ? FAIL : OK)),
    patch: vi.fn(async () => OK),
  };
}

describe('rowsOf：经 capture-map 生成行（M10）', () => {
  it('同一句话的几条共用 batch_id，每条自己的 uuid；不写 ai_status（M5）', () => {
    const { batchId, rows } = rowsOf({ items: [item(), item({ kind: 'event', title: 'meet', date: '2026-11-03', time: '15:00' })], rawText: 'raw', source: 'page', origin: 'rule', now: NOW, tz: TZ }, ids);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.row)).toEqual([expect.objectContaining({ batch_id: batchId }), expect.objectContaining({ batch_id: batchId })]);
    expect(new Set(rows.map((r) => r.row.id)).size).toBe(2);
    expect(rows.every((r) => !('ai_status' in r.row))).toBe(true);
    expect(rows[1]).toMatchObject({ table: 'events', row: { tz: TZ, raw_text: 'raw', source: 'page', remind_min: 15 } });
  });

  it('TC-B3-05：AI 给了 short 记 short_by=ai；本机规则不写 short（显示时取 itemShort）', () => {
    const ai = rowsOf({ items: [item({ short: 'milk' })], rawText: 'r', source: 'page', origin: 'ai', now: NOW, tz: TZ }, ids);
    expect(ai.rows[0]?.row).toMatchObject({ short: 'milk', short_by: 'ai' });
    const rule = rowsOf({ items: [item({ short: 'milk' })], rawText: 'r', source: 'page', origin: 'rule', now: NOW, tz: TZ }, ids);
    expect(rule.rows[0]?.row).toMatchObject({ short: null, short_by: null });
  });

  it('R-353：给了 day，没日子的日程记到那天、只说时刻的待办截止那天', () => {
    const { rows } = rowsOf({ items: [item({ kind: 'event', title: 'e' }), item({ time: '09:00' })], rawText: 'r', source: 'page', origin: 'rule', now: NOW, tz: TZ, day: '2026-11-20' }, ids);
    expect(rows[0]?.row).toMatchObject({ date: '2026-11-20' });
    expect(rows[1]?.row).toMatchObject({ due: '2026-11-20', due_time: '09:00', remind_before_min: 60 });
  });

  it('R-166：确认行选完的那一条加进同一批（给了 batchId 就不新开）', () => {
    const { batchId } = rowsOf({ items: [item()], rawText: 'r', source: 'page', origin: 'rule', now: NOW, tz: TZ, batchId: 'b-1' }, ids);
    expect(batchId).toBe('b-1');
  });

  it('随手记 captureRow 不认：跳过；at 记着每一行对应第几条', () => {
    const r = rowsOf({ items: [item({ kind: 'note' }), item({ title: 'x' })], rawText: 'r', source: 'page', origin: 'rule', now: NOW, tz: TZ }, ids);
    expect(r.rows).toHaveLength(1);
    expect(r.at).toEqual([1]);
  });

  it('只有随手记：没有行', () => {
    expect(rowsOf({ items: [item({ kind: 'note' })], rawText: 'r', source: 'page', origin: 'rule', now: NOW, tz: TZ }, ids).rows).toEqual([]);
  });
});

describe('saveCapture', () => {
  it('整批经 write.insert 写进 outbox；带提醒的标 remind', async () => {
    const w = writer();
    const r = await saveCapture({ items: [item({ kind: 'event', title: 'e', date: '2026-11-03', time: '15:00' }), item()], rawText: 'r', source: 'page', origin: 'rule', now: NOW, tz: TZ }, w, ids);
    expect(r).toMatchObject({ ok: true, remind: true });
    expect(w.insert).toHaveBeenCalledTimes(2);
    expect(w.insert.mock.calls[0]?.[0]).toBe('events');
    expect(w.insert.mock.calls[0]?.[2]).toEqual({ remind: true });
    expect(w.insert.mock.calls[1]?.[2]).toEqual({ remind: false });
  });

  it('交给 write.insert 的行过得了本机新增校验（rows.ts 的 insertSchema）：不带只能 update 的 deleted_at、undone（11-07 e2e 查出 invalid_row）', async () => {
    const w = writer();
    const items = [
      item({ kind: 'event', title: 'e', date: '2026-11-03', time: '15:00' }),
      item({ kind: 'event', title: 'all day', date: '2026-11-03' }),
      item({ title: 't' }),
      item({ title: 'due', due: '2026-11-04', time: '09:30' }),
    ];
    const r = await saveCapture({ items, rawText: 'r', source: 'page', origin: 'rule', now: NOW, tz: TZ }, w, ids);
    expect(r.ok).toBe(true);
    expect(w.insert).toHaveBeenCalledTimes(4);
    for (const [table, row] of w.insert.mock.calls as [WritableTable, Record<string, unknown>][]) {
      const p = insertSchema(table).safeParse(row);
      expect(p.success, `${table} ${JSON.stringify(p.error?.issues)}`).toBe(true);
      expect(row).not.toHaveProperty('deleted_at');
      expect(row).not.toHaveProperty('undone');
    }
  });

  it('第二条没写进去：已写的第一条撤回，整批报没保存', async () => {
    const w = writer(1);
    const r = await saveCapture({ items: [item({ title: 'a' }), item({ title: 'b' })], rawText: 'r', source: 'page', origin: 'rule', now: NOW, tz: TZ }, w, ids);
    expect(r).toEqual({ ok: false, reason: 'local_unavailable' });
    expect(w.patch).toHaveBeenCalledTimes(1);
    expect(w.patch.mock.calls[0]?.[2]).toEqual({ undone: true, updated_at: NOW });
  });

  it('什么都没认出来：nothing，不写', async () => {
    const w = writer();
    expect(await saveCapture({ items: [], rawText: 'r', source: 'page', origin: 'rule', now: NOW, tz: TZ }, w, ids)).toEqual({ ok: false, reason: 'nothing' });
    expect(w.insert).not.toHaveBeenCalled();
  });
});

describe('undoRefs：capture.undo(batch_id)', () => {
  it('日程、待办写 undone=true；纪念日先不撤（B4 定），原样报回', async () => {
    const w = writer();
    const left = await undoRefs([{ table: 'events', id: 'e1' }, { table: 'todos', id: 't1' }, { table: 'anniversaries', id: 'a1' }], NOW, w);
    expect(w.patch.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ['events', 'e1', { undone: true, updated_at: NOW }],
      ['todos', 't1', { undone: true, updated_at: NOW }],
    ]);
    expect(left).toEqual([{ table: 'anniversaries', id: 'a1' }]);
  });
});
