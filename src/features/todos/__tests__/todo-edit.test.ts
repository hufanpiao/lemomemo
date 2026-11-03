// 待办编辑页的规则（data/todo-edit.ts；架构 0.29 续第 124 条③、第 136 条；TC-B2-74）
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { todosWrite } from '../../../../shared/schema/rows.ts';
import { remindAtOf, type TodoRemindRow } from '../../../../shared/logic/remind.ts';
import {
  emptyForm, formOf, hasRemind, newTodoRow, normalize, patchOf, prevRemindAtOf, REMIND_BEFORE_OPTIONS, TODO_TIMING_COLS, type TodoForm,
} from '../data/todo-edit.ts';

const TZ = 'Asia/Seoul';
const ID = '00000000-0000-4000-8000-000000000001';
const base = (over: Partial<TodoForm> = {}): TodoForm => ({ ...emptyForm(), title: '交报告', ...over });

describe('提前提醒的选项（TC-B2-74 ①）', () => {
  it('不提醒 / 准时 / 10 分钟 / 30 分钟 / 1 小时 / 2 小时 / 1 天，和库的约束一致', () => {
    expect(REMIND_BEFORE_OPTIONS).toEqual([null, 0, 10, 30, 60, 120, 1440]);
  });
});

describe('normalize：截止日期、截止时刻的连带规则', () => {
  it('第一次设截止时刻：提前量默认 1 小时', () => {
    const prev = base({ due: '2026-11-05' });
    expect(normalize(prev, { ...prev, due_time: '17:00' }).remind_before_min).toBe(60);
  });

  it('已有截止时刻再改时刻：保留原来的提前量（含“不提醒”）', () => {
    const prev = base({ due: '2026-11-05', due_time: '17:00', remind_before_min: null });
    expect(normalize(prev, { ...prev, due_time: '18:00' }).remind_before_min).toBeNull();
    const p2 = base({ due: '2026-11-05', due_time: '17:00', remind_before_min: 10 });
    expect(normalize(p2, { ...p2, due_time: '18:00' }).remind_before_min).toBe(10);
  });

  it('设截止时刻时同时选了提前量：用选的', () => {
    const prev = base({ due: '2026-11-05' });
    expect(normalize(prev, { ...prev, due_time: '17:00', remind_before_min: 120 }).remind_before_min).toBe(120);
  });

  it('清掉截止时刻（TC-B2-74 ②）：提前量一并清掉，“当天 / 前一天 + 时刻”原样', () => {
    const prev = base({ due: '2026-11-05', due_time: '17:00', remind_before_min: 60, remind_days: 1, remind_time: '20:00' });
    expect(normalize(prev, { ...prev, due_time: null })).toMatchObject({ due_time: null, remind_before_min: null, remind_days: 1, remind_time: '20:00' });
  });

  it('清掉截止日期（第 136 条）：截止时刻、提前量一起清', () => {
    const prev = base({ due: '2026-11-05', due_time: '17:00', remind_before_min: 60 });
    expect(normalize(prev, { ...prev, due: null })).toMatchObject({ due: null, due_time: null, remind_before_min: null });
  });
});

describe('patchOf：只写变了的列', () => {
  const row = { id: ID, short_by: null };

  it('没变：null；变了：只带那几列和 updated_at', () => {
    const f = base();
    expect(patchOf(row, f, f, 5)).toBeNull();
    expect(patchOf(row, f, { ...f, note: 'x' }, 5)).toEqual({ note: 'x', updated_at: 5 });
  });

  it('清掉截止日期：同一个 patch 里 due、due_time、remind_before_min 都是 null', () => {
    const prev = base({ due: '2026-11-05', due_time: '17:00', remind_before_min: 60 });
    const p = patchOf(row, prev, normalize(prev, { ...prev, due: null }), 5);
    expect(p).toEqual({ due: null, due_time: null, remind_before_min: null, updated_at: 5 });
    expect(todosWrite.safeParse({ ...newTodoRow(ID, prev, 1), ...p, deleted_at: null, undone: false }).success).toBe(true);
  });

  it('改标题：简称是 AI 起的就清掉 short、short_by；用户自己写的不动', () => {
    const f = base();
    expect(patchOf({ id: ID, short_by: 'ai' }, f, { ...f, title: '新标题' }, 5)).toEqual({ title: '新标题', short: null, short_by: null, updated_at: 5 });
    expect(patchOf({ id: ID, short_by: 'user' }, f, { ...f, title: '新标题' }, 5)).toEqual({ title: '新标题', updated_at: 5 });
  });

  it('打勾记 done_at，取消打勾回 0', () => {
    const f = base();
    expect(patchOf(row, f, { ...f, done: true }, 7)).toEqual({ done: true, done_at: 7, updated_at: 7 });
    expect(patchOf(row, { ...f, done: true }, f, 8)).toEqual({ done: false, done_at: 0, updated_at: 8 });
  });
});

describe('newTodoRow：整行可写列，过得了 insert 的校验', () => {
  it('有截止时刻的、没有日期的都合格', () => {
    for (const f of [base(), base({ due: '2026-11-05', due_time: '17:00', remind_before_min: 60 })]) {
      expect(todosWrite.safeParse({ ...newTodoRow(ID, f, 1_800_000_000_000), deleted_at: null, undone: false }).success).toBe(true);
    }
  });

  it('formOf(newTodoRow(...)) 回到同一份表单', () => {
    const f = base({ due: '2026-11-05', due_time: '17:00', remind_before_min: 30, important: true, project: 'NEOX', note: 'n' });
    expect(formOf(newTodoRow(ID, f, 1))).toEqual(f);
  });

  it('formOf：坏值按默认', () => {
    expect(formOf({ id: ID, title: 3, remind_before_min: 45, remind_days: 2, remind_time: '' })).toMatchObject({
      title: '', remind_before_min: null, remind_days: null, remind_time: '09:00',
    });
  });
});

describe('hasRemind：和 shared 的 remindAtOf 同一份（BE-4 共用）', () => {
  const at = (hm: string) => msAt('2026-11-05', Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)), TZ);
  const f = base({ due: '2026-11-05', due_time: '17:00', remind_before_min: 60 });

  const dueAt = at('17:00');
  const rowOf = (form: TodoForm, extra: Record<string, unknown> = {}) => ({ ...newTodoRow(ID, form, 1), deleted_at: null, ...extra });
  /** 模拟一次保存：row = 写之前那一行，next = 改之后的表单，data = 这次 patch（patchOf 算） */
  const save = (row: Record<string, unknown>, next: TodoForm, now: number) => {
    const prev = formOf(row);
    const data = patchOf(row, prev, normalize(prev, next), now);
    return { data, flag: hasRemind({ row, data, prev, next: normalize(prev, next), tz: TZ, now }) };
  };

  it('新建（insert，data = null，不传）：16:00 之前响提前提醒；16:59 回落到截止时刻；17:01 截止也过了 → 不响', () => {
    const ins = (form: TodoForm, now: number) => hasRemind({ row: undefined, data: null, prev: null, next: form, tz: TZ, now });
    expect(ins(f, at('15:00'))).toBe(true);
    expect(ins(f, at('16:59'))).toBe(true);
    expect(ins(f, at('17:01'))).toBe(false);
    expect(ins(base(), at('09:00'))).toBe(false);
    expect(ins({ ...f, done: true }, at('09:00'))).toBe(false);
    expect(ins({ ...f, remind_before_min: null }, at('09:00'))).toBe(false);
  });

  it('prevRemindAtOf：照补审表逐条路径', () => {
    const row = rowOf(f, { remind_at: dueAt });
    // 新建：不传
    expect(prevRemindAtOf(undefined, null)).toBeUndefined();
    expect(prevRemindAtOf(row, null)).toBeUndefined();
    // 改标题、打勾 / 取消、标重要、改项目、改备注、改“当天 / 前一天”、改当天提醒时刻、删除 / 恢复：传这一行的 remind_at
    for (const data of [
      { title: 'x', short: null, short_by: null }, { done: true, done_at: 5 }, { done: false, done_at: 0 }, { important: true },
      { project: 'P' }, { note: 'n' }, { remind_days: 1 }, { remind_time: '20:00' }, { deleted_at: 5 }, { deleted_at: null },
    ]) {
      expect(prevRemindAtOf(row, { ...data, updated_at: 5 })).toBe(dueAt);
    }
    // 设 / 改截止日期、清截止日期、第一次设截止时刻、改截止时刻、清截止时刻、改提前提醒：不传
    for (const data of [
      { due: '2026-11-06' }, { due: null, due_time: null, remind_before_min: null }, { due_time: '17:00', remind_before_min: 60 },
      { due_time: '18:00' }, { due_time: null, remind_before_min: null }, { remind_before_min: 10 },
    ]) {
      expect(prevRemindAtOf(row, { ...data, updated_at: 5 })).toBeUndefined();
    }
    // 一个 patch 里同时有“不传”列和“传”列：整次不传
    expect(prevRemindAtOf(row, { note: 'n', due: '2026-11-06', updated_at: 5 })).toBeUndefined();
    // 本机新建、还没同步回来的行没有 remind_at：传 null
    expect(prevRemindAtOf(rowOf(f), { note: 'n', updated_at: 5 })).toBeNull();
  });

  it('提前时刻已过、截止也过了（remind_at = 截止时刻）：改备注、取消打勾传 prev，算出的时刻早过了 → false（S16）；改截止时刻、清截止日期不传 → false（补审第 5 条）', () => {
    const now = at('17:30');
    const row = rowOf(f, { remind_at: dueAt });
    const note = save(row, { ...f, note: '补一句' }, now);
    expect(prevRemindAtOf(row, note.data)).toBe(dueAt);
    expect(note.flag).toBe(false);
    const undone = save(rowOf({ ...f, done: true }, { remind_at: dueAt }), { ...f, done: false }, now);
    expect(undone.flag).toBe(false);
    // 截止刚过 2 分钟内（push-dispatch 可能还没推）：改备注照样带
    expect(save(row, { ...f, note: '补一句' }, dueAt + 60_000).flag).toBe(true);
    // 按过“稍后”（S14）：snooze_at 还没到，打勾要带标记撤掉它
    expect(save(rowOf(f, { remind_at: dueAt, snooze_at: now + 600_000 }), { ...f, done: true }, now).flag).toBe(true);
    const moveTime = save(row, { ...f, due_time: '17:20' }, now);
    expect(prevRemindAtOf(row, moveTime.data)).toBeUndefined();
    expect(moveTime.flag).toBe(false);
    const clearDue = save(row, { ...f, due: null }, now);
    expect(prevRemindAtOf(row, clearDue.data)).toBeUndefined();
    expect(clearDue.flag).toBe(false);
    // 打勾：改之后不响（已完成），改之前的提醒也已过 → false（不用撤）
    expect(save(row, { ...f, done: true }, now).flag).toBe(false);
  });

  it('撤掉还没到的提醒也带标记（S2）：改成“不提醒”、打勾、删除 → true', () => {
    const now = at('15:00');
    const row = rowOf(f, { remind_at: at('16:00') });
    expect(save(row, { ...f, remind_before_min: null }, now).flag).toBe(true);
    expect(save(row, { ...f, done: true }, now).flag).toBe(true);
    expect(hasRemind({ row, data: { deleted_at: now }, prev: f, next: f, tz: TZ, now })).toBe(true);
    // 本来就不响的行：改备注不带
    const quiet = rowOf({ ...f, remind_before_min: null });
    expect(save(quiet, { ...f, remind_before_min: null, note: 'x' }, now).flag).toBe(false);
  });

  it('删除 / 撤销删除（补审改法 ④）：撤销删除后会响 → true；删一条早就过了的 → false', () => {
    const now = at('15:00');
    const gone = rowOf(f, { remind_at: at('16:00'), deleted_at: 3 });
    expect(hasRemind({ row: gone, data: { deleted_at: null }, prev: f, next: f, tz: TZ, now })).toBe(true);
    const late = at('17:30');
    expect(hasRemind({ row: rowOf(f, { remind_at: dueAt }), data: { deleted_at: late }, prev: f, next: f, tz: TZ, now: late })).toBe(false);
    // 已删的行再改（data 不带 deleted_at）：按删了算，不响
    expect(hasRemind({ row: gone, data: { note: 'x' }, prev: f, next: { ...f, note: 'x' }, tz: TZ, now })).toBe(false);
  });

  it('TODO_TIMING_COLS 和 TodoRemindRow 里决定回落的字段一致（shared 加字段时这里编译不过）', () => {
    const decidesFallback: Record<keyof TodoRemindRow, boolean> = {
      due: true, due_time: true, remind_before_min: true, remind_days: false, remind_time: false, done: false, deleted_at: false,
    };
    const want = Object.entries(decidesFallback).filter(([, v]) => v).map(([k]) => k).sort();
    expect([...TODO_TIMING_COLS].sort()).toEqual(want);
    // 行为上：只有这几列变了，“提前时刻已过”时才会回落到截止时刻
    const now = at('16:30');
    const overdue = { ...f, due_time: '17:00', remind_before_min: 60 };
    expect(remindAtOf('todo', overdue, TZ, now)).toBe(dueAt);
    expect(remindAtOf('todo', overdue, TZ, now, at('16:00'))).toBe(at('16:00'));
  });
});
