// 什么时候转通知按键（hooks/usePendingDrain.ts）：本机行灌好以后（App 启动、引擎挂上）、行变了、回到前台、打开整页提醒（SW 聚焦已开的窗口改 hash）
// • 本机还没有行（known 为空）不转：这时什么都找不到，会把按键当 gone 丢掉
// • 同时只跑一份，跑的时候又触发了，跑完再跑一次
// • jsdom 改 location.hash 自己会发 hashchange，测试里不另发
// • find：用最新的列表；纪念日这一行本机还不认识（推算没加载好）回 later，日程、待办不认识回 undefined（gone）
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FindReminder } from '../data/remind-pending.ts';
import type { Reminder } from '../data/reminder-model.ts';

const calls: FindReminder[] = [];
let gate: Promise<void> = Promise.resolve();
const drain = vi.fn(async (find: FindReminder, _now: number, _tz: string): Promise<number> => {
  calls.push(find);
  await gate;
  return 0;
});
vi.mock('../data/remind-pending.ts', () => ({ drainNotifyActions: (f: FindReminder, n: number, t: string) => drain(f, n, t) }));
vi.mock('../../../platform/clock.ts', () => ({ clock: { now: () => 5 } }));

const { usePendingDrain } = await import('../hooks/usePendingDrain.ts');

const settle = () => act(async () => {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setTimeout(r, 0));
});
const rem = (kind: Reminder['kind'], id: string) => ({ kind, id, tag: `${kind}:${id}:1` }) as unknown as Reminder;

beforeEach(() => {
  drain.mockClear();
  calls.length = 0;
  gate = Promise.resolve();
  window.location.hash = '';
});
afterEach(cleanup);

describe('usePendingDrain', () => {
  it('本机还没有行：不转；行灌好了转一次；行变了再转', async () => {
    const { rerender } = renderHook(({ list, known }) => usePendingDrain(list, known, 'Asia/Seoul'), {
      initialProps: { list: [] as Reminder[], known: new Set<string>() },
    });
    await settle();
    expect(drain).not.toHaveBeenCalled();
    rerender({ list: [rem('todo', 'a')], known: new Set(['todo:a']) });
    await settle();
    expect(drain).toHaveBeenCalledTimes(1);
    expect(drain.mock.calls[0]?.slice(1)).toEqual([5, 'Asia/Seoul']);
    rerender({ list: [rem('todo', 'b')], known: new Set(['todo:b']) });
    await settle();
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('回到前台、打开整页提醒（hash 变成 #/remind/…）各转一次；别的 hash 不转', async () => {
    renderHook(() => usePendingDrain([rem('todo', 'a')], new Set(['todo:a']), 'Asia/Seoul'));
    await settle();
    drain.mockClear();
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    expect(drain).toHaveBeenCalledTimes(1);
    act(() => {
      window.location.hash = '#/todos';
    });
    await settle();
    expect(drain).toHaveBeenCalledTimes(1);
    act(() => {
      window.location.hash = '#/remind/todo/a?due=1';
    });
    await settle();
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('同时只跑一份：跑的时候又触发了两次，跑完只补跑一次', async () => {
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    renderHook(() => usePendingDrain([rem('todo', 'a')], new Set(['todo:a']), 'Asia/Seoul'));
    await settle();
    expect(drain).toHaveBeenCalledTimes(1);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    expect(drain).toHaveBeenCalledTimes(1);
    gate = Promise.resolve();
    open();
    await settle();
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('find：最新列表里的那一条；纪念日不认识回 later，日程、待办不认识回 undefined', async () => {
    const a = rem('todo', 'a');
    renderHook(() => usePendingDrain([a], new Set(['todo:a', 'event:gone', 'anniv:known']), 'Asia/Seoul'));
    await settle();
    const find = calls[0];
    if (!find) throw new Error('no call');
    expect(find('todo', 'a')).toBe(a);
    expect(find('event', 'gone')).toBeUndefined();
    expect(find('todo', 'nope')).toBeUndefined();
    expect(find('anniv', 'known')).toBeUndefined();
    expect(find('anniv', 'unloaded')).toBe('later');
  });
});
