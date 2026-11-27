// 换账号时断开推送改成按需下载 push.ts（11-05 首屏瘦身）：下载失败时换账号照样完成（清库、清运行时缓存、owner 记成新账号），不抛
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../platform/push.ts', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

const { cacheOwner, claimCache, ensureAccount } = await import('../account.ts');
const { resetBootForTest } = await import('../boot.ts');
const { setPushDisconnectLog } = await import('../../platform/push-disconnect.ts');
const { freshCache } = await import('./account-fixtures.ts');

afterEach(() => {
  resetBootForTest();
  setPushDisconnectLog(null);
});

describe('ensureAccount：push.ts 下载失败', () => {
  it('默认断开（不传 disconnectPush）：照样算换了账号、清运行时缓存、owner 记成新账号，记一条 load', async () => {
    const logs: string[] = [];
    setPushDisconnectLog((code) => void logs.push(code));
    const cache = await freshCache();
    await claimCache(cache, 'A');
    const clearCacheStorage = vi.fn(async () => undefined);
    expect(await ensureAccount(cache, 'B', { clearCacheStorage })).toBe(true);
    expect(clearCacheStorage).toHaveBeenCalledOnce();
    expect(await cacheOwner(cache)).toBe('B');
    expect(logs).toEqual(['load']);
    cache.close();
  });
});
