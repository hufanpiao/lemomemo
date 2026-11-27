// 清本机只有一个入口（第三方审查前端-4、后端-3）：platform/exit-basics.ts 的 wipeThisDevice（没会话的冷启动也走它）。
// 主 App 的 core/account.ts wipeLocal 只给它配上本页的库（设闸清库、关连接再按库名删），不再自己排一遍步骤、自己定超时。
// 原来两份各管各的：wipeLocal 给按库名删库套了上限、清记号失败记日志、清完不删库（dropDb 才删）；wipeThisDevice 删库不设上限、不记日志
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CACHES_TIMEOUT_MS, DELETE_WAIT_MS, WIPE_TIMEOUT_MS, wipeThisDevice } from '../exit-basics.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

const hang = <T>() => new Promise<T>(() => undefined);

describe('wipeThisDevice：一套步骤、一套超时', () => {
  it('按库名删库一直不回（别的标签页挡着）：最多等 DELETE_WAIT_MS 就往下清 Cache Storage，按时结束', async () => {
    vi.useFakeTimers();
    const caches = vi.fn(async () => undefined);
    let done = false;
    void wipeThisDevice({ wipe: async () => undefined, deleteDb: () => hang(), clearCacheStorage: caches }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(DELETE_WAIT_MS);
    expect(caches).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CACHES_TIMEOUT_MS);
    expect(done).toBe(true);
  });

  it('清库按时清完也按库名删一次库（不再分“清完不删、dropDb 才删”两种）', async () => {
    const order: string[] = [];
    await wipeThisDevice({
      wipe: async () => (order.push('wipe'), true),
      deleteDb: async () => void order.push('deleteDb'),
      clearCacheStorage: async () => void order.push('caches'),
    });
    expect(order).toEqual(['wipe', 'deleteDb', 'caches']);
  });

  it('清库卡住：到 WIPE_TIMEOUT_MS 照样删库、清缓存', async () => {
    vi.useFakeTimers();
    const deleteDb = vi.fn(async () => undefined);
    void wipeThisDevice({ wipe: () => hang(), deleteDb, clearCacheStorage: async () => undefined });
    await vi.advanceTimersByTimeAsync(WIPE_TIMEOUT_MS);
    expect(deleteDb).toHaveBeenCalledOnce();
  });

  it('删不掉 lemo.reauth（存储不可用）：记一条 auth_loss_store_failed（原来只有 wipeLocal 记）', async () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const log = vi.fn();
    await wipeThisDevice({ deleteDb: async () => undefined, clearCacheStorage: async () => undefined, log });
    expect(log).toHaveBeenCalledWith('auth_loss_store_failed');
  });
});
