// useEditRecord 的 N1（代码审查，取代 S12）：每次写入带上用户改过、还没保存上的全部字段；
// 被拒（rejected）的字段单独记、下次不带，用户再改它才解除；带了旧字段一起被拒时只拿这一次的改动重试一次分清是谁；
// 还有被拒、没写进去的字段时不报 saved。替身和 useEditRecord.test.tsx 相同
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

describe('带上全部没保存上的字段（N1，取代 S12）；被拒的单独记、下次不带', () => {
  it('先改标题没写进去（closing），再改备注：这次带上标题和备注，写成了才报 saved', async () => {
    rowNow = { id: 'r1', title: 'A', note: '' };
    const { result } = renderHook(() => useEditRecord<F>(spec('r1')));
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.update({ title: 'B', note: '' });
    });
    await tick();
    await settle(0, 'closing', p);
    expect(result.current.status).toBe('closing');
    expect(result.current.form).toEqual({ title: 'B', note: '' });
    act(() => {
      p = result.current.update({ ...result.current.form, note: 'n' });
    });
    await tick();
    expect(calls[1]?.data).toEqual({ title: 'B', note: 'n' });
    rowNow = { id: 'r1', title: 'B', note: 'n' };
    await settle(1, 'saved', p);
    expect(result.current.status).toBe('saved');
    expect(result.current.form).toEqual({ title: 'B', note: 'n' });
  });

  it('备注被拒：之后改标题只带标题，状态仍报 rejected；再改备注才带它，都写上了才报 saved', async () => {
    rowNow = { id: 'r1', title: 'A', note: '' };
    const { result } = renderHook(() => useEditRecord<F>(spec('r1')));
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.update({ title: 'A', note: '坏' });
    });
    await tick();
    await settle(0, 'rejected', p);
    expect(result.current.status).toBe('rejected');
    act(() => {
      p = result.current.update({ ...result.current.form, title: 'B' });
    });
    await tick();
    expect(calls[1]?.data).toEqual({ title: 'B' });
    rowNow = { id: 'r1', title: 'B', note: '' };
    await settle(1, 'saved', p);
    expect(result.current.status).toBe('rejected');
    expect(result.current.form).toEqual({ title: 'B', note: '坏' });
    act(() => {
      p = result.current.update({ ...result.current.form, note: '好' });
    });
    await tick();
    expect(calls[2]?.data).toEqual({ note: '好' });
    rowNow = { id: 'r1', title: 'B', note: '好' };
    await settle(2, 'saved', p);
    expect(result.current.status).toBe('saved');
  });

  it('带了旧字段一起被拒：只拿这一次的改动重试；成了就记旧字段被拒，状态不报 saved，下次不再带它', async () => {
    rowNow = { id: 'r1', title: 'A', note: '' };
    const { result } = renderHook(() => useEditRecord<F>(spec('r1')));
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.update({ title: 'A', note: '坏' });
    });
    await tick();
    await settle(0, 'local_unavailable', p);
    act(() => {
      p = result.current.update({ ...result.current.form, title: 'B' });
    });
    await tick();
    expect(calls[1]?.data).toEqual({ title: 'B', note: '坏' });
    calls[1]?.resolve('rejected');
    await tick();
    expect(calls[2]?.data).toEqual({ title: 'B' });
    rowNow = { id: 'r1', title: 'B', note: '' };
    await settle(2, 'saved', p);
    expect(result.current.status).toBe('rejected');
    expect(result.current.form).toEqual({ title: 'B', note: '坏' });
    act(() => {
      p = result.current.update({ ...result.current.form, title: 'C' });
    });
    await tick();
    expect(calls[3]?.data).toEqual({ title: 'C' });
    await settle(3, 'saved', p);
    expect(result.current.status).toBe('rejected');
  });

  it('重试也被拒：这一次的改动记为被拒，旧字段照旧待写（下次还带）', async () => {
    rowNow = { id: 'r1', title: 'A', note: '' };
    const { result } = renderHook(() => useEditRecord<F>(spec('r1')));
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.update({ title: 'A', note: 'n' });
    });
    await tick();
    await settle(0, 'closing', p);
    act(() => {
      p = result.current.update({ ...result.current.form, title: '坏' });
    });
    await tick();
    calls[1]?.resolve('rejected');
    await tick();
    expect(calls[2]?.data).toEqual({ title: '坏' });
    await settle(2, 'rejected', p);
    expect(result.current.status).toBe('rejected');
    act(() => {
      p = result.current.update({ ...result.current.form, title: 'B' });
    });
    await tick();
    expect(calls[3]?.data).toEqual({ title: 'B', note: 'n' });
    rowNow = { id: 'r1', title: 'B', note: 'n' };
    await settle(3, 'saved', p);
    expect(result.current.status).toBe('saved');
  });
});
