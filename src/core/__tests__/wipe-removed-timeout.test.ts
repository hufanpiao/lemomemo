// wipeLocal 的时间上限：它只给 platform/exit-basics.ts 的 wipeThisDevice 配上本页的库（bootWipeSteps），步骤和超时都在那一份（第三方审查前端-4、后端-3）。
// 清完一律关本页连接、按库名删库；清库卡住或失败照样删；清运行时缓存卡住 → 不等；任何情况都按时 resolve（调用方随后回登录页）
import { describe, expect, it, vi } from 'vitest';
import { bootWipeSteps, wipeLocal } from '../account.ts';
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
  it('清库、清运行时缓存都按时完成：同步设闸；清完关库、再按库名删一次（不再分 dropDb）', async () => {
    const b = fakeBoot(async () => undefined);
    const order: string[] = [];
    b.cache.close.mockImplementation(() => void order.push('close'));
    const deleteDb = vi.fn(async () => void order.push('deleteDb'));
    const p = wipeLocal(b.boot, { clearCacheStorage: async () => undefined, deleteDb, wipeMs: 50, cachesMs: 50 });
    expect(b.boot.switching).toBe(true);   // 调用一返回就设好闸
    expect(b.outbox.suspend).toHaveBeenCalled();
    await p;
    expect(b.cache.clearAll).toHaveBeenCalledOnce();
    expect(order.slice(0, 2)).toEqual(['close', 'deleteDb']);
  });

  it('bootWipeSteps：wipe 设闸后清库（库已关只清内存集合）；deleteDb 先关本页连接再按库名删', async () => {
    const b = fakeBoot(async () => undefined);
    const s = bootWipeSteps(b.boot);
    await s.wipe();
    expect(b.cache.seal).toHaveBeenCalled();
    expect(b.cache.clearAll).toHaveBeenCalledOnce();
    vi.stubGlobal('indexedDB', undefined);   // 没有 IndexedDB：deleteDb 回 unavailable，只看它先关了连接
    expect(await s.deleteDb()).toBe('unavailable');
    expect(b.cache.isClosed()).toBe(true);
    vi.unstubAllGlobals();
    await s.wipe();   // 库已关：只清内存集合
    expect(b.cache.clearAll).toHaveBeenCalledOnce();
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
