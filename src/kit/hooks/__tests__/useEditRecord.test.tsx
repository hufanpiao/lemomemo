// useEditRecord 的写入（B2 FA-2；代码审查 S1、S9、S12，补审改法 ①～④）
// ① 写入串成一条链：前一次回来才开始下一次（S1）；状态只认最后一次（S9）
// ② 每次带上用户改过、还没保存上的全部字段（N1，取代 S12）：用例在 useEditRecord-unsaved.test.tsx
// ③ 新建页 insert 还在路上又改：等它回来再按 patch 写，不 insert 两行、不丢改动；insert 失败下一次重新 insert
// ④ remind 标记交给 spec.hasRemind，带上写之前的行和这次的 patch；删除 / 撤销删除也算
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaveOutcome } from '../../../core/edit-save.ts';
import type { RemindCtx } from '../useEditRecord.ts';

type Call = { op: 'insert' | 'patch' | 'deleted'; id: string; data: Record<string, unknown>; remind: boolean; resolve(r: SaveOutcome): void };
const calls: Call[] = [];
let rowNow: (Record<string, unknown> & { id: string }) | undefined;

vi.mock('../../../core/edit-save.ts', () => ({
  saveInsert: (_t: string, row: Record<string, unknown> & { id: string }, remind: boolean) =>
    new Promise<SaveOutcome>((resolve) => calls.push({ op: 'insert', id: row.id, data: row, remind, resolve })),
  savePatch: (_t: string, id: string, data: Record<string, unknown>, remind: boolean) =>
    new Promise<SaveOutcome>((resolve) => calls.push({ op: 'patch', id, data, remind, resolve })),
  saveDeleted: (_t: string, id: string, deleted: boolean, now: number, remind: boolean) =>
    new Promise<SaveOutcome>((resolve) => calls.push({ op: 'deleted', id, data: { deleted, now }, remind, resolve })),
}));
vi.mock('../useItem.ts', () => ({ useItem: () => rowNow }));

const { useEditRecord } = await import('../useEditRecord.ts');

type F = { title: string; note: string };
const hasRemind = vi.fn((_c: RemindCtx<F>) => false);
const spec = (id: string, over: Record<string, unknown> = {}) => ({
  table: 'todos', id,
  formOf: (r: Readonly<Record<string, unknown>>): F => ({ title: String(r['title'] ?? ''), note: String(r['note'] ?? '') }),
  emptyForm: (): F => ({ title: '', note: '' }),
  titleOf: (f: F) => f.title,
  patchOf: (_r: Readonly<Record<string, unknown>>, prev: F, next: F) => {
    const d: Record<string, unknown> = {};
    if (prev.title !== next.title) d['title'] = next.title;
    if (prev.note !== next.note) d['note'] = next.note;
    return Object.keys(d).length ? d : null;
  },
  newRow: (rid: string, f: F) => ({ id: rid, ...f }),
  hasRemind,
  newId: () => 'new-1', now: () => 1, tz: () => 'Asia/Seoul',
  ...over,
});

/** 等链上排着的那一步发出去 */
const tick = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});
const settle = (i: number, r: SaveOutcome, p?: Promise<unknown>) => act(async () => {
  calls[i]?.resolve(r);
  if (p) await p;
  for (let k = 0; k < 5; k++) await Promise.resolve();
});

beforeEach(() => {
  calls.length = 0;
  rowNow = undefined;
  hasRemind.mockClear();
});

describe('写入串成一条链（S1）、状态只认最后一次（S9）', () => {
  it('连着改两次：前一次回来才发第二次；前一次回来不清掉后一次的本地表单，状态等最后一次', async () => {
    rowNow = { id: 'r1', title: 'A', note: '' };
    const { result } = renderHook(() => useEditRecord<F>(spec('r1')));
    let p1!: Promise<unknown>;
    let p2!: Promise<unknown>;
    act(() => {
      p1 = result.current.update({ title: 'B', note: '' });
    });
    act(() => {
      p2 = result.current.update({ title: 'B', note: 'x' });
    });
    await tick();
    expect(calls.map((c) => c.op)).toEqual(['patch']);
    expect(calls[0]?.data).toEqual({ title: 'B' });
    rowNow = { id: 'r1', title: 'B', note: '' }; // 写进本机后集合里的行跟着变
    await settle(0, 'saved', p1);
    expect(result.current.form).toEqual({ title: 'B', note: 'x' });
    expect(result.current.status).toBe('saving');
    expect(calls.map((c) => c.op)).toEqual(['patch', 'patch']);
    // 第二次只带这一次改的 note，不顺带写 title
    expect(calls[1]?.data).toEqual({ note: 'x' });
    await settle(1, 'saved', p2);
    expect(result.current.status).toBe('saved');
  });

  it('删除也排在链上：前面的 patch 回来以后才删；带上 hasRemind 算的标记（补审改法 ④）', async () => {
    rowNow = { id: 'r1', title: 'A', note: '' };
    hasRemind.mockImplementation((c) => c.data !== null && 'deleted_at' in c.data);
    const { result } = renderHook(() => useEditRecord<F>(spec('r1')));
    let p1!: Promise<unknown>;
    let p2!: Promise<unknown>;
    act(() => {
      p1 = result.current.update({ title: 'A', note: 'n' });
    });
    act(() => {
      p2 = result.current.setDeleted(true);
    });
    await tick();
    expect(calls.map((c) => c.op)).toEqual(['patch']);
    await settle(0, 'saved', p1);
    expect(calls.map((c) => c.op)).toEqual(['patch', 'deleted']);
    expect(calls[1]).toMatchObject({ id: 'r1', data: { deleted: true, now: 1 }, remind: true });
    const ctx = hasRemind.mock.calls.at(-1)?.[0];
    expect(ctx?.data).toEqual({ deleted_at: 1 });
    expect(ctx?.row).toBe(rowNow);
    // 前一次晚回来的 patch 不改状态：最后一次是删除
    expect(result.current.status).toBe('saving');
    await settle(1, 'saved', p2);
    expect(result.current.status).toBe('saved');
  });

  it('撤销删除：data = { deleted_at: null }', async () => {
    rowNow = { id: 'r1', title: 'A', note: '', deleted_at: 5 };
    const { result } = renderHook(() => useEditRecord<F>(spec('r1')));
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.setDeleted(false);
    });
    await tick();
    expect(calls[0]).toMatchObject({ op: 'deleted', data: { deleted: false } });
    expect(hasRemind.mock.calls.at(-1)?.[0].data).toEqual({ deleted_at: null });
    await settle(0, 'saved', p);
  });
});

describe('remind 标记', () => {
  it('hasRemind 拿到写之前的行、这次的 patch、改前改后的表单', async () => {
    rowNow = { id: 'r1', title: 'A', note: '', remind_at: 9 };
    hasRemind.mockReturnValue(true);
    const { result } = renderHook(() => useEditRecord<F>(spec('r1')));
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.update({ title: 'A', note: 'n' });
    });
    await tick();
    expect(hasRemind).toHaveBeenLastCalledWith({ row: rowNow, data: { note: 'n' }, prev: { title: 'A', note: '' }, next: { title: 'A', note: 'n' }, tz: 'Asia/Seoul', now: 1 });
    expect(calls[0]?.remind).toBe(true);
    await settle(0, 'saved', p);
  });
});

describe('新建', () => {
  it('insert 还没发出去又改了一次：一次 insert 带上两次的改动；onCreated 调到', async () => {
    const onCreated = vi.fn();
    const { result } = renderHook(() => useEditRecord<F>(spec('new', { onCreated })));
    let p1!: Promise<unknown>;
    let p2!: Promise<unknown>;
    act(() => {
      p1 = result.current.update({ title: '买盒子', note: '' });
    });
    act(() => {
      p2 = result.current.update({ title: '买盒子', note: '两个' });
    });
    await tick();
    expect(calls.map((c) => c.op)).toEqual(['insert']);
    expect(calls[0]?.data).toEqual({ id: 'new-1', title: '买盒子', note: '两个' });
    expect(hasRemind.mock.calls[0]?.[0]).toMatchObject({ row: undefined, data: null, prev: null });
    await settle(0, 'saved', p1);
    await act(async () => {
      await p2;
    });
    expect(onCreated).toHaveBeenCalledWith('new-1');
    expect(calls.map((c) => c.op)).toEqual(['insert']);
    expect(result.current.savedId).toBe('new-1');
    expect(result.current.status).toBe('saved');
  });

  it('insert 在路上（已发出）又改了一次 → 等 insert 回来，再按 patch 写（同一个 id，只带变了的列）', async () => {
    const { result } = renderHook(() => useEditRecord<F>(spec('new')));
    let p1!: Promise<unknown>;
    let p2!: Promise<unknown>;
    act(() => {
      p1 = result.current.update({ title: '买盒子', note: '' });
    });
    await tick();
    act(() => {
      p2 = result.current.update({ title: '买盒子', note: '两个' });
    });
    await tick();
    expect(calls.map((c) => c.op)).toEqual(['insert']);
    await settle(0, 'saved', p1);
    expect(calls.map((c) => c.op)).toEqual(['insert', 'patch']);
    expect(calls[1]).toMatchObject({ id: 'new-1', data: { note: '两个' } });
    expect(result.current.form).toEqual({ title: '买盒子', note: '两个' });
    await settle(1, 'saved', p2);
    expect(result.current.status).toBe('saved');
  });

  it('insert 失败：下一次改动重新 insert', async () => {
    const onCreated = vi.fn();
    const { result } = renderHook(() => useEditRecord<F>(spec('new', { onCreated })));
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.update({ title: 'A', note: '' });
    });
    await tick();
    await settle(0, 'local_unavailable', p);
    expect(result.current.status).toBe('local_unavailable');
    expect(onCreated).not.toHaveBeenCalled();
    act(() => {
      p = result.current.update({ title: 'A', note: 'n' });
    });
    await tick();
    expect(calls.map((c) => c.op)).toEqual(['insert', 'insert']);
    expect(calls[1]?.data).toEqual({ id: 'new-1', title: 'A', note: 'n' });
    await settle(1, 'saved', p);
    expect(result.current.status).toBe('saved');
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it('insert 失败后排着两次改动（S1）：第一次重新 insert 整张表单，第二次在它回来后按 patch 写，只有一行', async () => {
    const { result } = renderHook(() => useEditRecord<F>(spec('new')));
    const ps: Promise<unknown>[] = [];
    act(() => {
      ps.push(result.current.update({ title: 'A', note: '' }));
    });
    act(() => {
      ps.push(result.current.update({ title: 'A', note: '1' }));
    });
    act(() => {
      ps.push(result.current.update({ title: 'A', note: '12' }));
    });
    await tick();
    await settle(0, 'local_unavailable', ps[0]);
    expect(calls.map((c) => c.op)).toEqual(['insert', 'insert']);
    expect(calls[1]?.data).toEqual({ id: 'new-1', title: 'A', note: '12' });
    rowNow = { id: 'new-1', title: 'A', note: '12' };
    await settle(1, 'saved', ps[1]);
    // 第三次：表单和刚 insert 的一样，没有要写的
    await act(async () => {
      await ps[2];
    });
    expect(calls.map((c) => c.op)).toEqual(['insert', 'insert']);
    expect(result.current.status).toBe('saved');
    expect(result.current.form).toEqual({ title: 'A', note: '12' });
  });

  it('标题为空不写：empty_title', async () => {
    const { result } = renderHook(() => useEditRecord<F>(spec('new')));
    await act(async () => {
      await result.current.update({ title: '  ', note: 'x' });
    });
    expect(result.current.status).toBe('empty_title');
    expect(calls).toHaveLength(0);
  });
});

describe('markRejected', () => {
  it('调用方拦下的修改：状态 rejected、不写，前面晚回来的写入不改状态', async () => {
    rowNow = { id: 'r1', title: 'A', note: '' };
    const { result } = renderHook(() => useEditRecord<F>(spec('r1')));
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.update({ title: 'B', note: '' });
    });
    act(() => {
      result.current.markRejected();
    });
    expect(result.current.status).toBe('rejected');
    await tick();
    await settle(0, 'saved', p);
    expect(calls).toHaveLength(1);
    expect(result.current.status).toBe('rejected');
  });
});
