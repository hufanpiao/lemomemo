// 待办长按拖动排序（data/todo-sort.ts、data/todo-list.ts 的组内排序；R-429）：能放进哪组、组内换序、跨组改截止、拖到今天去掉已过的截止时刻
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { groupTodos, type Row } from '../data/todo-list.ts';
import { canDropTodo, groupId, planTodoDrop } from '../data/todo-sort.ts';

const TZ = 'Asia/Seoul';
const TODAY = '2026-11-05';
const NOW = msAt(TODAY, 14 * 60 + 17, TZ);
const td = (id: string, over: Record<string, unknown> = {}): Row => ({
  id, title: id, project: '', done: false, important: false, due: null, due_time: null, done_at: 0, deleted_at: null, undone: false, sort_key: null, ...over,
});

describe('能放进哪组', () => {
  it('今天、明天、某一天能跨组放进去；过期只出不进；以后、没日期只能组内换；已完成不能换', () => {
    expect(canDropTodo('late:', 'today:')).toBe(true);
    expect(canDropTodo('today:', 'tomorrow:')).toBe(true);
    expect(canDropTodo('nodate:', 'day:2026-11-08')).toBe(true);
    expect(canDropTodo('today:', 'late:')).toBe(false);
    expect(canDropTodo('today:', 'later:')).toBe(false);
    expect(canDropTodo('today:', 'nodate:')).toBe(false);
    expect(canDropTodo('late:', 'late:')).toBe(true);
    expect(canDropTodo('nodate:', 'nodate:')).toBe(true);
    expect(canDropTodo('done:', 'done:')).toBe(false);
  });
});

describe('组内排序', () => {
  it('没拖过的在前照原规则，拖过的按排序值大的在上', () => {
    const rows = [td('a', { due: TODAY }), td('b', { due: TODAY, sort_key: '3' }), td('c', { due: TODAY, sort_key: '5' })];
    const g = groupTodos(rows, NOW, TZ).find((x) => x.key === 'today');
    expect(g?.items.map((i) => i.todo.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('planTodoDrop', () => {
  it('组内换序：只写排序值，不改截止、不带 updated_at；落到放下的位置', () => {
    const rows = [td('a', { due: TODAY, sort_key: '5' }), td('b', { due: TODAY, sort_key: '4' }), td('c', { due: TODAY, sort_key: '3' })];
    const groups = groupTodos(rows, NOW, TZ);
    const p = planTodoDrop(groups, rows, { id: 'c', from: 'today:', to: 'today:', index: 0 }, NOW, TZ, TODAY);
    expect(p?.to).toBeNull();
    expect(p?.writes).toHaveLength(1);
    expect(p?.writes[0]).toMatchObject({ id: 'c', due: false, undo: { sort_key: '3' } });
    expect(Object.keys(p?.writes[0]?.patch ?? {})).toEqual(['sort_key']);
    const moved = rows.map((r) => ({ ...r, ...(p?.writes.find((w) => w.id === r.id)?.patch ?? {}) }));
    expect(groupTodos(moved, NOW, TZ)[0]?.items.map((i) => i.todo.id)).toEqual(['c', 'a', 'b']);
  });

  it('跨组到明天：截止日期改成明天、带 updated_at；撤销写回原来的日期；截止时刻保留', () => {
    const rows = [td('a', { due: TODAY, due_time: '18:00' }), td('m', { due: '2026-11-06' })];
    const groups = groupTodos(rows, NOW, TZ);
    const p = planTodoDrop(groups, rows, { id: 'a', from: 'today:', to: 'tomorrow:', index: 0 }, NOW, TZ, TODAY);
    expect(p?.to?.key).toBe('tomorrow');
    const w = p?.writes.find((x) => x.id === 'a');
    expect(w?.due).toBe(true);
    expect(w?.patch).toMatchObject({ due: '2026-11-06', updated_at: NOW });
    expect(w?.patch).not.toHaveProperty('due_time');
    expect(w?.undo).toMatchObject({ due: TODAY });
  });

  it('从过期拖到今天、截止时刻今天已经过了：去掉截止时刻和提前量；撤销写回', () => {
    const rows = [td('x', { due: '2026-11-03', due_time: '09:00', remind_before_min: 15 }), td('y', { due: TODAY })];
    const groups = groupTodos(rows, NOW, TZ);
    expect(groupId(groups[0]!)).toBe('late:');
    const p = planTodoDrop(groups, rows, { id: 'x', from: 'late:', to: 'today:', index: 1 }, NOW, TZ, TODAY);
    const w = p?.writes.find((x) => x.id === 'x');
    expect(w?.patch).toMatchObject({ due: TODAY, due_time: null, remind_before_min: null });
    expect(w?.undo).toMatchObject({ due: '2026-11-03', due_time: '09:00', remind_before_min: 15 });
  });

  it('拖到今天、截止时刻还没到：保留截止时刻', () => {
    const rows = [td('x', { due: '2026-11-07', due_time: '20:00' }), td('y', { due: TODAY })];
    const groups = groupTodos(rows, NOW, TZ);
    const p = planTodoDrop(groups, rows, { id: 'x', from: 'day:2026-11-07', to: 'today:', index: 0 }, NOW, TZ, TODAY);
    const w = p?.writes.find((x) => x.id === 'x');
    expect(w?.patch).toMatchObject({ due: TODAY });
    expect(w?.patch).not.toHaveProperty('due_time');
  });

  it('不让放进过期、以后；组或条目对不上回 null', () => {
    const rows = [td('x', { due: '2026-11-03' }), td('y', { due: TODAY }), td('z', { due: '2026-12-20' })];
    const groups = groupTodos(rows, NOW, TZ);
    expect(planTodoDrop(groups, rows, { id: 'y', from: 'today:', to: 'late:', index: 0 }, NOW, TZ, TODAY)).toBeNull();
    expect(planTodoDrop(groups, rows, { id: 'y', from: 'today:', to: 'later:', index: 0 }, NOW, TZ, TODAY)).toBeNull();
    expect(planTodoDrop(groups, rows, { id: 'gone', from: 'today:', to: 'today:', index: 0 }, NOW, TZ, TODAY)).toBeNull();
  });
});
