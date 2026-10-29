// wipeOnRemoved 的时间上限（接手清单 SETTINGS-sugg ①）：主 App（sync-wiring）、同意页（consent-exit）、设置页（account-exit）三处
// 被移除、停用、冷静期的清本机都走它。清库卡住或失败 → 关本页连接、按库名删库；清运行时缓存卡住 → 不等；任何情况都 onRemoved（回登录页）
import { describe, expect, it, vi } from 'vitest';
import { wipeOnRemoved } from '../account.ts';
import type { BootResult } from '../boot.ts';

const never = (): Promise<void> => new Promise<void>(() => undefined);

/** 只有 wipeOnRemoved 用到的几项 */
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

describe('wipeOnRemoved 的时间上限（SETTINGS-sugg ①）', () => {
  it('清库、清运行时缓存都按时完成：不按库名删，onRemoved 一次', async () => {
    const b = fakeBoot(async () => undefined);
    const deleteDb = vi.fn(async () => undefined);
    const onRemoved = vi.fn();
    await wipeOnRemoved(b.boot, { clearCacheStorage: async () => undefined, onRemoved, deleteDb, wipeMs: 50, cachesMs: 50 });
    expect(deleteDb).not.toHaveBeenCalled();
    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(b.boot.switching).toBe(true);
    expect(b.outbox.suspend).toHaveBeenCalled();
  });

  it('清库一直不回、清运行时缓存一直不回：到点先关连接再按库名删库，照样 onRemoved', async () => {
    const b = fakeBoot(never);
    const order: string[] = [];
    b.cache.close.mockImplementation(() => void order.push('close'));
    const deleteDb = vi.fn(async () => void order.push('deleteDb'));
    const onRemoved = vi.fn(() => void order.push('onRemoved'));
    const t0 = performance.now();
    await wipeOnRemoved(b.boot, { clearCacheStorage: never, onRemoved, deleteDb, wipeMs: 30, cachesMs: 30 });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(order.slice(0, 2)).toEqual(['close', 'deleteDb']);
    expect(order.at(-1)).toBe('onRemoved');
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it('清库抛错：也按库名删库；按库名删也一直不回：到点照样 onRemoved', async () => {
    const b = fakeBoot(async () => Promise.reject(new Error('QuotaExceeded')));
    const deleteDb = vi.fn(never);
    const onRemoved = vi.fn();
    await wipeOnRemoved(b.boot, { clearCacheStorage: async () => undefined, onRemoved, deleteDb, wipeMs: 30, cachesMs: 30 });
    expect(deleteDb).toHaveBeenCalledTimes(1);
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });
});
