// 待办标完成、改回没完成、撤销：所有入口共用 core/todo-done.ts（B4b-3 评审第 15 条，主持人 11-14 定口径）
// • 提醒标记一律按 todoRemindFlag 算（改之后会响，或改之前还会响）
// • 撤销写回原来的 done 和原来的 done_at
// • 已经完成的再点完成，不覆盖 done_at
// • 列表、今天页刚点过的再点回去 = 撤销（doneToggler）
import { describe, expect, it, vi } from 'vitest';
import { donePrev, doneToggler, setTodoDone, todoDonePatch, todoUndoPatch, undoTodoDone } from '../todo-done.ts';

const TZ = 'Asia/Seoul';
const NOW = Date.UTC(2026, 10, 14, 3, 0); // 首尔 12:00
const T0 = NOW - 86_400_000;
const plain = { id: 't1', done: false, done_at: 0, due: null, due_time: null, remind_before_min: null, remind_days: null, remind_time: '09:00', remind_at: null, snooze_at: null, deleted_at: null };
// 今天 18:00 截止、提前 30 分钟提醒：改之前还会响
const ringing = { ...plain, id: 't2', due: '2026-11-14', due_time: '18:00', remind_before_min: 30 };
const doneRow = { ...plain, id: 't3', done: true, done_at: T0 };

describe('todoDonePatch：写什么列、提醒标记', () => {
  it('没完成的标完成：done_at 记 now；没有提醒的标记为 false', () => {
    expect(todoDonePatch(plain, true, NOW, TZ)).toEqual({ data: { done: true, done_at: NOW, updated_at: NOW }, remind: false });
  });
  it('还会响的标完成：标记为 true（按 todoRemindFlag，不是一律 true）', () => {
    expect(todoDonePatch(ringing, true, NOW, TZ).remind).toBe(true);
  });
  it('已经完成的再点完成：不覆盖 done_at', () => {
    expect(todoDonePatch(doneRow, true, NOW, TZ).data).toEqual({ done: true, done_at: T0, updated_at: NOW });
  });
  it('改回没完成：done_at 写 0', () => {
    expect(todoDonePatch(doneRow, false, NOW, TZ).data).toEqual({ done: false, done_at: 0, updated_at: NOW });
  });
});

describe('撤销：写回原来的 done 和 done_at', () => {
  it('todoUndoPatch 写回原值；标记按改回去以后算', () => {
    const prev = donePrev(doneRow);
    const after = { ...doneRow, done: false, done_at: 0 };
    expect(todoUndoPatch(after, prev, NOW, TZ)).toEqual({ data: { done: true, done_at: T0, updated_at: NOW }, remind: false });
    const prevRing = donePrev(ringing);
    expect(todoUndoPatch({ ...ringing, done: true, done_at: NOW }, prevRing, NOW, TZ)).toEqual({ data: { done: false, done_at: 0, updated_at: NOW }, remind: true });
  });

  it('setTodoDone、undoTodoDone 经同一个保存入口写', async () => {
    const save = vi.fn(async () => 'saved' as const);
    expect(await setTodoDone(ringing, true, NOW, TZ, save)).toBe('saved');
    expect(save).toHaveBeenLastCalledWith('todos', 't2', { done: true, done_at: NOW, updated_at: NOW }, true);
    await undoTodoDone({ ...doneRow, done: false, done_at: 0 }, donePrev(doneRow), NOW, TZ, save);
    expect(save).toHaveBeenLastCalledWith('todos', 't3', { done: true, done_at: T0, updated_at: NOW }, false);
  });
});

describe('doneToggler：列表、今天页刚点过的再点回去就是撤销', () => {
  it('完成过的取消打勾、再打勾：done_at 回到原来的，不是 now', async () => {
    const save = vi.fn(async () => 'saved' as const);
    const toggle = doneToggler(save);
    await toggle(doneRow, false, NOW, TZ);
    expect(save).toHaveBeenLastCalledWith('todos', 't3', { done: false, done_at: 0, updated_at: NOW }, false);
    await toggle({ ...doneRow, done: false, done_at: 0 }, true, NOW + 1000, TZ);
    expect(save).toHaveBeenLastCalledWith('todos', 't3', { done: true, done_at: T0, updated_at: NOW + 1000 }, false);
  });
  it('撤销过一次以后不再记着：下次打勾按新的一次算', async () => {
    const save = vi.fn(async () => 'saved' as const);
    const toggle = doneToggler(save);
    await toggle(plain, true, NOW, TZ);
    await toggle({ ...plain, done: true, done_at: NOW }, false, NOW + 1, TZ);
    expect(save).toHaveBeenLastCalledWith('todos', 't1', { done: false, done_at: 0, updated_at: NOW + 1 }, false);
    await toggle(plain, true, NOW + 2, TZ);
    expect(save).toHaveBeenLastCalledWith('todos', 't1', { done: true, done_at: NOW + 2, updated_at: NOW + 2 }, false);
  });
  it('写失败不记：再点按新的一次算', async () => {
    const save = vi.fn(async () => 'rejected' as const);
    const toggle = doneToggler(save);
    expect(await toggle(doneRow, false, NOW, TZ)).toBe('rejected');
    save.mockResolvedValue('saved' as never);
    await toggle(doneRow, true, NOW + 5, TZ);
    expect(save).toHaveBeenLastCalledWith('todos', 't3', { done: true, done_at: T0, updated_at: NOW + 5 }, false);
  });
});

describe('只有一份写法（守门）', () => {
  it('src 里写 done_at 列的只有 core/todo-done.ts（编辑页 todo-edit 按表单整行写、sync-notice 只列字段名，不算）', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, relative, resolve } = await import('node:path');
    const root = resolve(import.meta.dirname, '../..');
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) {
          if (n !== '__tests__') walk(p);
        } else if (/\.tsx?$/.test(n) && !n.endsWith('.gen.ts') && /done_at['"]?\s*:/.test(readFileSync(p, 'utf8'))) hits.push(relative(root, p).replace(/\\/g, '/'));
      }
    };
    walk(root);
    expect(hits.sort()).toEqual(['core/todo-done.ts', 'features/sync-notice/data/fields.ts']);
  });
});
