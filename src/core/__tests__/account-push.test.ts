// 换账号、会话没了、被移除时断开浏览器推送（B2 安全审查六之三 FE-2）：
// 清库之后、删库之前调 disconnectPush（关掉本 App 已显示的通知、退订推送）；它失败、卡住都不挡后面的步骤
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimCache, ensureAccount, wipeOnRemoved } from '../account.ts';
import { resetBootForTest } from '../boot.ts';
import { freshCache } from './account-fixtures.ts';
import { setup } from './account-watch-harness.ts';
import { flush } from './idb-fake.ts';

afterEach(() => {
  resetBootForTest();
});

describe('ensureAccount（启动时换账号）', () => {
  it('换了账号才断开；同一个账号、第一次认领都不断开', async () => {
    const cache = await freshCache();
    const disconnectPush = vi.fn(async () => undefined);
    const clearCacheStorage = vi.fn(async () => undefined);
    expect(await ensureAccount(cache, 'A', { clearCacheStorage, disconnectPush })).toBe(false); // 第一次
    expect(await ensureAccount(cache, 'A', { clearCacheStorage, disconnectPush })).toBe(false); // 同一个
    expect(disconnectPush).not.toHaveBeenCalled();
    expect(await ensureAccount(cache, 'B', { clearCacheStorage, disconnectPush })).toBe(true);
    expect(disconnectPush).toHaveBeenCalledOnce();
    cache.close();
  });

  it('断开出错：照样清运行时缓存、算换了账号', async () => {
    const cache = await freshCache();
    await claimCache(cache, 'A');
    const clearCacheStorage = vi.fn(async () => undefined);
    expect(await ensureAccount(cache, 'B', { clearCacheStorage, disconnectPush: () => Promise.reject(new Error('x')) })).toBe(true);
    expect(clearCacheStorage).toHaveBeenCalledOnce();
    cache.close();
  });
});

describe('watchAccount', () => {
  it('别的标签页退出（会话没了）：清库之后、删库之前断开', async () => {
    const s = await setup();
    const order: string[] = [];
    s.deps.disconnectPush = vi.fn(async () => void order.push('disconnect'));
    const del = s.deps.deleteDb;
    s.deps.deleteDb = async () => {
      order.push('deleteDb');
      return del?.();
    };
    s.storage(null);
    await vi.waitFor(() => expect(s.deps.onSignedOut).toHaveBeenCalled());
    expect(order).toEqual(['disconnect', 'deleteDb']);
  });

  it('会话里换成了别的账号：断开', async () => {
    const s = await setup();
    s.deps.disconnectPush = vi.fn(async () => undefined);
    s.auth('B');
    await vi.waitFor(() => expect(s.deps.onSwitched).toHaveBeenCalled());
    expect(s.deps.disconnectPush).toHaveBeenCalledOnce();
  });
});

describe('wipeOnRemoved（被移除、停用、注销）', () => {
  it('断开在 onRemoved 之前；断开卡住或出错都不挡回登录页', async () => {
    for (const fail of [false, true]) {
      const s = await setup();
      const order: string[] = [];
      const onRemoved = vi.fn(() => void order.push('onRemoved'));
      await wipeOnRemoved(s.boot, {
        clearCacheStorage: async () => void order.push('clearCacheStorage'),
        onRemoved,
        disconnectPush: async () => {
          order.push('disconnect');
          if (fail) throw new Error('x');
        },
      });
      expect(order).toEqual(['disconnect', 'clearCacheStorage', 'onRemoved']);
      resetBootForTest();
      await flush();
    }
  });
});
