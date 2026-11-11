// wipeLocal 的时间上限：清本机库只走它（被移除、冷静期、别的标签页退出、本人退出）。
// 清库卡住或失败 → 关本页连接、按库名删库；清运行时缓存卡住 → 不等；任何情况都按时 resolve（调用方随后回登录页）
import { describe, expect, it, vi } from 'vitest';
import { wipeLocal } from '../account.ts';
import type { BootResult } from '../boot.ts';

const never = (): Promise<void> => new Promise<void>(() => undefined);

/** 只有 wipeLocal 用到的几项 */
function fakeBoot(clearAll: () => Promise<void>) {
  let closed = false;
  const cache = {
    name: 'lemo-test',
    isClosed: () => closed,
    clearAll: vi.fn(clearAll),
    seal: vi.fn(),
    close: vi.fn(() => void (closed = true)),
  };
  const outbox = { suspend: vi.fn() };
  return { boot: { switching: false, cache, outbox } as unknown as BootResult, cache, outbox };
}

describe('wipeLocal 的时间上限', () => {
  it('清库、清运行时缓存都按时完成：不按库名删；设闸、关库', async () => {
    const b = fakeBoot(async () => undefined);
    const deleteDb = vi.fn(async () => undefined);
    await wipeLocal(b.boot, { clearCacheStorage: async () => undefined, deleteDb, wipeMs: 50, cachesMs: 50 });
    expect(deleteDb).not.toHaveBeenCalled();
    expect(b.boot.switching).toBe(true);
    expect(b.outbox.suspend).toHaveBeenCalled();
    expect(b.cache.isClosed()).toBe(true);
  });

  it('dropDb：清完也按库名删整个库', async () => {
    const b = fakeBoot(async () => undefined);
    const deleteDb = vi.fn(async () => undefined);
    await wipeLocal(b.boot, { clearCacheStorage: async () => undefined, deleteDb, dropDb: true, wipeMs: 50, cachesMs: 50 });
    expect(deleteDb).toHaveBeenCalledOnce();
  });

  it('清库一直不回、清运行时缓存一直不回：到点先关连接再按库名删库，照样按时结束', async () => {
    const b = fakeBoot(never);
    const order: string[] = [];
    b.cache.close.mockImplementation(() => void order.push('close'));
    const deleteDb = vi.fn(async () => void order.push('deleteDb'));
    const t0 = performance.now();
    await wipeLocal(b.boot, { clearCacheStorage: never, deleteDb, wipeMs: 30, cachesMs: 30 });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(order.slice(0, 2)).toEqual(['close', 'deleteDb']);
  });

  it('清库抛错：也按库名删库；按库名删也一直不回：到点照样结束', async () => {
    const b = fakeBoot(async () => Promise.reject(new Error('QuotaExceeded')));
    const deleteDb = vi.fn(never);
    await wipeLocal(b.boot, { clearCacheStorage: async () => undefined, deleteDb, wipeMs: 30, cachesMs: 30 });
    expect(deleteDb).toHaveBeenCalledTimes(1);
  });
});
