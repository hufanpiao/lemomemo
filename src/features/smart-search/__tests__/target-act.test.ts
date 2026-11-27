// 取消、改期、完成写什么、撤销写回什么（data/target-act.ts；架构 5.14 第 7 点；B4b-3）：patchFor、applyTarget / undoTarget、每行“⋯”菜单 rowAct。
// 写库一律用桩 save、get，不碰本机库
import { describe, expect, it, vi } from 'vitest';
import { applyTarget, patchFor, rowAct, undoTarget, type Row, type Save, type TargetHit } from '../data/target-act.ts';

/** 设备时区洛杉矶：2026-11-14 12:00 */
const LA = 'America/Los_Angeles';
const NOW = Date.UTC(2026, 10, 14, 20);
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ok: Save = vi.fn(async () => 'saved' as const);

const EV: Row = { id: uid(1), title: '看牙医', date: '2026-11-10', time: '15:00', tz: 'Asia/Seoul', duration_min: 60, notified_for: 'n1', snooze_at: 123, deleted_at: null };
const EV_HIT: TargetHit = { kind: 'event', id: uid(1), date: '2026-11-09', time: '22:00' };
const TD: Row = { id: uid(2), title: '交发票', due: '2026-11-10', due_time: '09:00', remind_before_min: 30, done: false, done_at: null };
const TD_HIT: TargetHit = { kind: 'todo', id: uid(2), date: '2026-11-10', time: '09:00' };

describe('patchFor：取消、完成', () => {
  it('取消 = 软删 deleted_at；撤销写回原来的 deleted_at（没有的写 null）', () => {
    expect(patchFor('cancel', EV_HIT, EV, null, NOW, LA)).toEqual([{ deleted_at: NOW, updated_at: NOW }, { deleted_at: null, updated_at: NOW }]);
    const { deleted_at: _d, ...noCol } = EV;
    expect(patchFor('cancel', EV_HIT, noCol as Row, null, NOW, LA)[1]).toEqual({ deleted_at: null, updated_at: NOW });
  });
  it('完成：done、done_at = now；撤销写回原 done 和原 done_at，原来没有的写 0', () => {
    expect(patchFor('complete', TD_HIT, TD, null, NOW, LA)).toEqual([{ done: true, done_at: NOW, updated_at: NOW }, { done: false, done_at: 0, updated_at: NOW }]);
    expect(patchFor('complete', TD_HIT, { ...TD, done: true, done_at: 777 }, null, NOW, LA)[1]).toEqual({ done: true, done_at: 777, updated_at: NOW });
  });
  it('第 15 条：已经完成的再点完成，不覆盖 done_at（和列表同一个 core/todo-done.ts）', () => {
    expect(patchFor('complete', TD_HIT, { ...TD, done: true, done_at: 777 }, null, NOW, LA)[0]).toEqual({ done: true, done_at: 777, updated_at: NOW });
  });
});

describe('第 15 条：完成的提醒标记按 todoRemindFlag 算（不一律 true）', () => {
  // TD 的提醒（11-10 08:30）早过了：标完成、撤销都不带标记；今天 18:00 截止提前 30 分钟的还会响：两头都带
  const RING: Row = { ...TD, due: '2026-11-14', due_time: '18:00' };
  it('applyTarget、undoTarget', async () => {
    const save = vi.fn<Save>(async () => 'saved');
    const a = await applyTarget('complete', [TD_HIT], new Map([[uid(2), TD]]), null, NOW, LA, save);
    expect(save).toHaveBeenLastCalledWith('todos', uid(2), { done: true, done_at: NOW, updated_at: NOW }, false);
    await undoTarget(a, NOW + 5, save);
    expect(save).toHaveBeenLastCalledWith('todos', uid(2), { done: false, done_at: 0, updated_at: NOW + 5 }, false);
    const b = await applyTarget('complete', [TD_HIT], new Map([[uid(2), RING]]), null, NOW, LA, save);
    expect(save).toHaveBeenLastCalledWith('todos', uid(2), { done: true, done_at: NOW, updated_at: NOW }, true);
    await undoTarget(b, NOW + 5, save);
    expect(save).toHaveBeenLastCalledWith('todos', uid(2), { done: false, done_at: 0, updated_at: NOW + 5 }, true);
  });
  it('rowAct done', async () => {
    const save = vi.fn<Save>(async () => 'saved');
    await rowAct('done', 'todo', uid(2), { date: '2026-11-10', time: null }, NOW, LA, save, () => TD);
    expect(save).toHaveBeenLastCalledWith('todos', uid(2), { done: true, done_at: NOW, updated_at: NOW }, false);
  });
});

describe('patchFor：改期日程', () => {
  it('改 date、time，tz 写设备时区；清 notified_for、snooze_at；撤销写回原来的几列', () => {
    const [after, before] = patchFor('reschedule', EV_HIT, EV, { date: '2026-11-20', time: '10:00' }, NOW, LA);
    expect(after).toEqual({ date: '2026-11-20', time: '10:00', tz: LA, notified_for: null, snooze_at: null, updated_at: NOW });
    expect(before).toEqual({ date: '2026-11-10', time: '15:00', tz: 'Asia/Seoul', notified_for: 'n1', snooze_at: 123, updated_at: NOW });
  });
  it('只说日子：保留候选（已换算到设备时区）的时刻；只说时刻：用候选的日子', () => {
    expect(patchFor('reschedule', EV_HIT, EV, { date: '2026-11-20', time: null }, NOW, LA)[0]).toMatchObject({ date: '2026-11-20', time: '22:00', tz: LA });
    expect(patchFor('reschedule', EV_HIT, EV, { date: null, time: '08:00' }, NOW, LA)[0]).toMatchObject({ date: '2026-11-09', time: '08:00', tz: LA });
  });
  it('全天日程只改日子：tz 照原来的', () => {
    const allDay: Row = { ...EV, time: null };
    const [after, before] = patchFor('reschedule', { ...EV_HIT, date: '2026-11-10', time: null }, allDay, { date: '2026-11-21', time: null }, NOW, LA);
    expect(after).toMatchObject({ date: '2026-11-21', time: null, tz: 'Asia/Seoul' });
    expect(before).toMatchObject({ date: '2026-11-10', time: null });
  });
});

describe('patchFor：改期待办', () => {
  it('只说日子：保留原 due_time，不动提前量', () => {
    const [after, before] = patchFor('reschedule', TD_HIT, TD, { date: '2026-11-12', time: null }, NOW, LA);
    expect(after).toEqual({ due: '2026-11-12', due_time: '09:00', updated_at: NOW });
    expect(before).toEqual({ due: '2026-11-10', due_time: '09:00', updated_at: NOW });
  });
  it('说了时刻、原来没有时刻：补默认提前量 remind_before_min，撤销写回原来的', () => {
    const row: Row = { ...TD, due_time: null, remind_before_min: null };
    const [after, before] = patchFor('reschedule', { ...TD_HIT, time: null }, row, { date: '2026-11-12', time: '15:00' }, NOW, LA);
    expect(after).toEqual({ due: '2026-11-12', due_time: '15:00', remind_before_min: 60, updated_at: NOW });
    expect(before).toEqual({ due: '2026-11-10', due_time: null, remind_before_min: null, updated_at: NOW });
  });
  it('说了时刻、原来就有时刻：不动提前量', () => {
    const [after, before] = patchFor('reschedule', TD_HIT, TD, { date: null, time: '15:00' }, NOW, LA);
    expect(after).toEqual({ due: '2026-11-10', due_time: '15:00', updated_at: NOW });
    expect(before).not.toHaveProperty('remind_before_min');
  });
  it('只说时刻：due 用候选的日子；候选没有截止日时记今天（设备时区）', () => {
    expect(patchFor('reschedule', TD_HIT, TD, { date: null, time: '18:00' }, NOW, LA)[0]).toMatchObject({ due: '2026-11-10', due_time: '18:00' });
    const noDue: Row = { ...TD, due: null, due_time: null };
    expect(patchFor('reschedule', { ...TD_HIT, date: null, time: null }, noDue, { date: null, time: '18:00' }, NOW, LA)[0]).toMatchObject({ due: '2026-11-14', due_time: '18:00' });
  });
});

describe('applyTarget / undoTarget', () => {
  it('逐条写：成功的进撤销列表，写不进的、找不到原行的算 failed；取消写入带 remind = true（完成按 todoRemindFlag，见上）', async () => {
    const save = vi.fn<Save>(async (_t, id) => (id === uid(2) ? 'rejected' : 'saved'));
    const rows = new Map<string, Row>([[uid(1), EV], [uid(2), TD]]);
    const hits: TargetHit[] = [EV_HIT, TD_HIT, { kind: 'todo', id: uid(9), date: null, time: null }];
    const a = await applyTarget('cancel', hits, rows, null, NOW, LA, save);
    expect(a).toEqual({ ok: 1, failed: 2, undo: [{ table: 'events', id: uid(1), data: { deleted_at: null, updated_at: NOW }, remind: true }] });
    expect(save.mock.calls).toEqual([
      ['events', uid(1), { deleted_at: NOW, updated_at: NOW }, true],
      ['todos', uid(2), { deleted_at: NOW, updated_at: NOW }, true],
    ]);
  });
  it('撤销：把改之前的值写回、updated_at 换成撤销那一刻；返回写回成功几条', async () => {
    const a = await applyTarget('complete', [TD_HIT], new Map([[uid(2), TD]]), null, NOW, LA, ok);
    const save = vi.fn<Save>(async () => 'saved');
    expect(await undoTarget(a, NOW + 5, save)).toBe(1);
    expect(save).toHaveBeenCalledWith('todos', uid(2), { done: false, done_at: 0, updated_at: NOW + 5 }, false);
    expect(await undoTarget(a, NOW + 6, vi.fn<Save>(async () => 'rejected'))).toBe(0);
  });
});

describe('rowAct：每行“⋯”菜单', () => {
  const rows: Record<string, Row> = {
    [`events:${uid(1)}`]: EV, [`todos:${uid(2)}`]: { ...TD, due_time: '08:00' },
    [`anniversaries:${uid(3)}`]: { id: uid(3), name: '妈妈生日' }, [`notes:${uid(4)}`]: { id: uid(4), title: '拉面店' },
  };
  const get = (t: string, i: string) => rows[`${t}:${i}`];

  it('done：待办写 done、done_at，撤销写回', async () => {
    const save = vi.fn<Save>(async () => 'saved');
    const a = await rowAct('done', 'todo', uid(2), { date: '2026-11-10', time: null }, NOW, LA, save, get);
    expect(save).toHaveBeenCalledWith('todos', uid(2), { done: true, done_at: NOW, updated_at: NOW }, false);
    expect(a).toEqual({ ok: 1, failed: 0, undo: [{ table: 'todos', id: uid(2), data: { done: false, done_at: 0, updated_at: NOW }, remind: false }] });
  });
  it('tomorrow：待办改到设备时区的明天，保留原 due_time（不用 at.time）', async () => {
    const save = vi.fn<Save>(async () => 'saved');
    await rowAct('tomorrow', 'todo', uid(2), { date: '2026-11-10', time: '23:00' }, NOW, LA, save, get);
    expect(save).toHaveBeenCalledWith('todos', uid(2), { due: '2026-11-15', due_time: '08:00', updated_at: NOW }, true);
  });
  it('delete：各表名正确；随手记不带 remind 标记', async () => {
    const save = vi.fn<Save>(async () => 'saved');
    for (const [kind, n] of [['event', 1], ['todo', 2], ['anniv', 3], ['note', 4]] as const) {
      await rowAct('delete', kind, uid(n), { date: null, time: null }, NOW, LA, save, get);
    }
    expect(save.mock.calls.map((c) => [c[0], c[1], c[2], c[3]])).toEqual([
      ['events', uid(1), { deleted_at: NOW, updated_at: NOW }, true],
      ['todos', uid(2), { deleted_at: NOW, updated_at: NOW }, true],
      ['anniversaries', uid(3), { deleted_at: NOW, updated_at: NOW }, true],
      ['notes', uid(4), { deleted_at: NOW, updated_at: NOW }, false],
    ]);
  });
  it('找不到这一行、写不进去：failed 1，没有撤销', async () => {
    const save = vi.fn<Save>(async () => 'saved');
    expect(await rowAct('delete', 'todo', uid(99), { date: null, time: null }, NOW, LA, save, get)).toEqual({ undo: [], ok: 0, failed: 1 });
    expect(save).not.toHaveBeenCalled();
    expect(await rowAct('delete', 'todo', uid(2), { date: null, time: null }, NOW, LA, vi.fn<Save>(async () => 'rejected'), get)).toEqual({ undo: [], ok: 0, failed: 1 });
  });
});
