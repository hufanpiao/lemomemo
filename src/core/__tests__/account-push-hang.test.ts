// 安全审查必改 1（B2-安全审查-推送断开按需下载.md）：默认路径上的 push.ts 一直下载不回时，换账号（ensureAccount）按时完成，
// owner 记成新账号；退出那条在 platform/__tests__/push-disconnect-hang.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

// 下载永远不回
vi.mock('../../platform/push.ts', () => new Promise(() => undefined));

const { DISCONNECT_PUSH_MS } = await import('../../platform/push-claim-key.ts');
const { LOAD_PUSH_MS, setPushDisconnectLog } = await import('../../platform/push-disconnect.ts');
const { cacheOwner, claimCache, ensureAccount } = await import('../account.ts');
const { resetBootForTest } = await import('../boot.ts');
const { freshCache } = await import('./account-fixtures.ts');

afterEach(() => {
  vi.useRealTimers();
  setPushDisconnectLog(null);
  resetBootForTest();
});

describe('ensureAccount：push.ts 一直下载不回', () => {
  it('换账号（默认断开）：DISCONNECT_PUSH_MS 内完成，owner 记成新账号', async () => {
    const logs: string[] = [];
    setPushDisconnectLog((code) => void logs.push(code));
    const cache = await freshCache();
    await claimCache(cache, 'A');
    // 只换 setTimeout、Date（fake-indexeddb 用 setImmediate 走真事件循环）
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let done = false;
    const p = ensureAccount(cache, 'B', { clearCacheStorage: async () => undefined }).then((r) => ((done = true), r));
    // 断开的计时器挂上之前（前面的 IDB 读写在真事件循环里，机器忙时可能慢）只让真事件循环转，不推假时钟、不计时
    for (let i = 0; i < 5000 && !done && vi.getTimerCount() === 0; i += 1) await new Promise<void>((r) => setImmediate(r));
    expect(vi.getTimerCount(), '断开没有挂上计时器').toBeGreaterThan(0);
    let waited = 0;
    while (!done && waited <= DISCONNECT_PUSH_MS + 100) {
      await vi.advanceTimersByTimeAsync(10);
      waited += 10;
      await new Promise<void>((r) => setImmediate(r));
    }
    vi.useRealTimers();
    expect(done).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(LOAD_PUSH_MS);
    expect(waited).toBeLessThanOrEqual(DISCONNECT_PUSH_MS);
    expect(await p).toBe(true);
    expect(await cacheOwner(cache)).toBe('B');
    expect(logs[0]).toBe('timeout');
    cache.close();
  });
});
