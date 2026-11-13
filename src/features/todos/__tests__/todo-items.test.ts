// 待办子任务的数据规则（data/todo-items.ts；R-350 方案 5.5、6.1、6.4；TC-R350-05～09、14、15 的数据部分）
import { beforeEach, describe, expect, it, vi } from 'vitest';

const save = vi.hoisted(() => ({ calls: [] as unknown[][], out: 'saved' as string }));
vi.mock('../../../core/edit-save.ts', () => ({
  saveInsert: (...a: unknown[]) => (save.calls.push(['insert', ...a]), Promise.resolve(save.out)),
  savePatch: (...a: unknown[]) => (save.calls.push(['patch', ...a]), Promise.resolve(save.out)),
  saveDeleted: (...a: unknown[]) => (save.calls.push(['deleted', ...a]), Promise.resolve(save.out)),
}));

import {
  addSubtasks, autoTodo, cleanTitle, groupSubtasks, ITEMS_MAX, moveSorts, nextSort, progressOf, splitLines, tickSubtask, undoAutoDone, type Subtask,
} from '../data/todo-items.ts';

const TZ = 'Asia/Seoul';
const sub = (id: string, sort: number, done = false): Subtask => ({ id, todoId: 't', title: id, done, sort, createdAt: 0 });

beforeEach(() => {
  save.calls = [];
  save.out = 'saved';
});

describe('分组和进度', () => {
  it('按 todo_id 分组、按 sort 排（一样时按 created_at、id）；删了、撤销了、没有 todo_id 的不要', () => {
    const g = groupSubtasks([
      { id: 'b', todo_id: 't1', title: 'B', sort: 2, created_at: 1 },
      { id: 'a', todo_id: 't1', title: 'A', sort: 1, created_at: 5, done: true },
      { id: 'c', todo_id: 't1', title: 'C', sort: 2, created_at: 0 },
      { id: 'd', todo_id: 't1', sort: 3, deleted_at: 9 },
      { id: 'e', todo_id: 't1', sort: 4, undone: true },
      { id: 'f', sort: 1 },
      { id: 'g', todo_id: 't2', title: 'G', sort: 1 },
    ]);
    expect(g.get('t1')?.map((s) => s.id)).toEqual(['a', 'c', 'b']);
    expect(g.get('t2')?.map((s) => s.id)).toEqual(['g']);
    expect(progressOf(g.get('t1') ?? [])).toEqual({ done: 1, total: 3 });
  });
});

describe('标题、粘贴、上限（6.1、TC-R350-14）', () => {
  it('去掉首尾空白、截到 100 字；全空白是空串', () => {
    expect(cleanTitle('  买牛奶  ')).toBe('买牛奶');
    expect(cleanTitle('字'.repeat(101))).toHaveLength(100);
    expect(cleanTitle('   ')).toBe('');
  });

  it('粘贴多行：按行拆、去空行；只取剩下的空位，多出来的数在 dropped', () => {
    expect(splitLines('牛奶\r\n\n 鸡蛋 \r猫砂\n', 20)).toEqual({ titles: ['牛奶', '鸡蛋', '猫砂'], dropped: 0 });
    expect(splitLines('1\n2\n3\n4\n5', 2)).toEqual({ titles: ['1', '2'], dropped: 3 });
    expect(splitLines('1\n2', 0)).toEqual({ titles: [], dropped: 2 });
    expect(ITEMS_MAX).toBe(20);
  });

  it('新加的排序键 = 最大值 + 1；加几项依次 insert，整行可写列、不带 remind 标记', async () => {
    expect(nextSort([])).toBe(1);
    expect(nextSort([sub('a', 3), sub('b', 1.5)])).toBe(4);
    let n = 0;
    expect(await addSubtasks('t', [sub('a', 3)], ['x', 'y'], 100, () => `n${++n}`)).toBe('saved');
    expect(save.calls).toEqual([
      ['insert', 'todo_items', { id: 'n1', todo_id: 't', title: 'x', done: false, sort: 4, created_at: 100, updated_at: 100 }, false],
      ['insert', 'todo_items', { id: 'n2', todo_id: 't', title: 'y', done: false, sort: 5, created_at: 100, updated_at: 100 }, false],
    ]);
  });

  it('写不进去就停在那一项、返回原因', async () => {
    save.out = 'readonly';
    expect(await addSubtasks('t', [], ['x', 'y'], 1, () => 'n')).toBe('readonly');
    expect(save.calls).toHaveLength(1);
  });
});

describe('排序键（6.4、TC-R350-15）', () => {
  const list = [sub('a', 1), sub('b', 2), sub('c', 3), sub('d', 4)];
  it('挪到两项之间取中点；挪到最前 = 第一项 − 1；挪到最后 = 最后一项 + 1；没挪不写', () => {
    expect(moveSorts(list, 0, 2)).toEqual([{ id: 'a', sort: 3.5 }]);
    expect(moveSorts(list, 3, 0)).toEqual([{ id: 'd', sort: 0 }]);
    expect(moveSorts(list, 0, 3)).toEqual([{ id: 'a', sort: 5 }]);
    expect(moveSorts(list, 2, 1)).toEqual([{ id: 'c', sort: 1.5 }]);
    expect(moveSorts(list, 1, 1)).toEqual([]);
    expect(moveSorts(list, 1, 9)).toEqual([]);
  });

  it('两边差得太小（< 1e-9）：整组按新顺序重编 1、2、3……，只写变了的', () => {
    const tight = [sub('a', 1), sub('b', 1 + 1e-10), sub('c', 2)];
    expect(moveSorts(tight, 2, 1)).toEqual([{ id: 'b', sort: 3 }]);
    expect(moveSorts([sub('a', 5), sub('b', 5 + 1e-10), sub('c', 9)], 2, 1)).toEqual([{ id: 'a', sort: 1 }, { id: 'c', sort: 2 }, { id: 'b', sort: 3 }]);
  });
});

describe('主待办跟着改（5.5，Q1～Q3）', () => {
  const three = [sub('a', 1, true), sub('b', 2, true), sub('c', 3)];
  it('勾上最后一项 → 完成；还有没勾的 → 不动；主待办已完成时再勾 → 不动', () => {
    expect(autoTodo(false, three, 'c', true)).toBe(true);
    expect(autoTodo(false, three, 'a', true)).toBeNull();
    expect(autoTodo(false, [sub('a', 1), sub('b', 2)], 'a', true)).toBeNull();
    expect(autoTodo(true, three, 'c', true)).toBeNull();
  });

  it('主待办已完成时取消勾 → 改回未完成（Q2）；没完成时取消勾 → 不动；不认识的项 → 不动', () => {
    expect(autoTodo(true, three, 'a', false)).toBe(false);
    expect(autoTodo(false, three, 'a', false)).toBeNull();
    expect(autoTodo(false, three, 'zzz', true)).toBeNull();
  });

  const todo = { id: 't', done: false, due: null, due_time: null, remind_before_min: null, remind_days: null, remind_time: null, deleted_at: null };

  it('TC-R350-05：勾上最后一项先写子任务、再写主待办（done、done_at、updated_at）；auto = true', async () => {
    const r = await tickSubtask(todo, three, 'c', true, 500, TZ);
    expect(r).toEqual({ out: 'saved', auto: true });
    expect(save.calls).toEqual([
      ['patch', 'todo_items', 'c', { done: true, updated_at: 500 }, false],
      ['patch', 'todos', 't', { done: true, done_at: 500, updated_at: 500 }, false],
    ]);
  });

  it('子任务没写进去：不碰主待办', async () => {
    save.out = 'readonly';
    expect(await tickSubtask(todo, three, 'c', true, 500, TZ)).toEqual({ out: 'readonly', auto: null });
    expect(save.calls).toHaveLength(1);
  });

  it('TC-R350-07：主待办已完成时取消勾一项 → 主待办改回未完成（done_at 0），auto = false', async () => {
    const r = await tickSubtask({ ...todo, done: true }, [sub('a', 1, true), sub('b', 2, true)], 'b', false, 600, TZ);
    expect(r).toEqual({ out: 'saved', auto: false });
    expect(save.calls[1]).toEqual(['patch', 'todos', 't', { done: false, done_at: 0, updated_at: 600 }, false]);
  });

  it('TC-R350-08、09：直接勾子任务但没勾完 → 只写子任务', async () => {
    expect(await tickSubtask(todo, [sub('a', 1), sub('b', 2)], 'a', true, 1, TZ)).toEqual({ out: 'saved', auto: null });
    expect(save.calls).toHaveLength(1);
  });

  it('TC-R350-06（Q1）：撤销“自动完成”时刚勾的那一项取消勾、主待办回未完成', async () => {
    expect(await undoAutoDone({ ...todo, done: true }, 'c', 700, TZ)).toBe('saved');
    expect(save.calls).toEqual([
      ['patch', 'todo_items', 'c', { done: false, updated_at: 700 }, false],
      ['patch', 'todos', 't', { done: false, done_at: 0, updated_at: 700 }, false],
    ]);
  });
});
