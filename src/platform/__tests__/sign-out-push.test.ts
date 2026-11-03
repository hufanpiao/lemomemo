// 设置页退出、被移除、登录页“退出并换账号”共用的 wipeThisDevice：设闸清库之后、按库名删库之前断开浏览器推送
// （B2 安全审查六之三 FE-2：关掉本 App 已显示的通知、退订推送；失败不挡退出）
import { describe, expect, it, vi } from 'vitest';
import { defaultExitSteps, wipeThisDevice, type ExitSteps } from '../sign-out.ts';

function steps(order: string[], over: Partial<ExitSteps> = {}): ExitSteps {
  return {
    deleteDb: async () => void order.push('deleteDb'),
    clearCacheStorage: async () => void order.push('clearCacheStorage'),
    clearLocalSessionIf: () => Promise.resolve(true),
    readSessionId: () => null,
    disconnectPush: async () => void order.push('disconnect'),
    ...over,
  };
}

describe('wipeThisDevice 断开浏览器推送（FE-2）', () => {
  it('清库成功：wipe → 断开 → 清运行时缓存', async () => {
    const order: string[] = [];
    await wipeThisDevice(steps(order, { wipe: async () => (order.push('wipe'), true) }));
    expect(order).toEqual(['wipe', 'disconnect', 'clearCacheStorage']);
  });

  it('库不能用（改按库名删）：断开在删库之前', async () => {
    const order: string[] = [];
    await wipeThisDevice(steps(order, { wipe: async () => (order.push('wipe'), false) }));
    expect(order).toEqual(['wipe', 'disconnect', 'deleteDb', 'clearCacheStorage']);
  });

  it('断开出错：照样删库、清缓存，不抛', async () => {
    const order: string[] = [];
    await expect(
      wipeThisDevice(steps(order, { disconnectPush: () => Promise.reject(new Error('x')) })),
    ).resolves.toBeUndefined();
    expect(order).toEqual(['deleteDb', 'clearCacheStorage']);
  });

  it('默认的几步里带着断开（platform/push.ts 的 disconnectBrowserPush）', async () => {
    expect(typeof defaultExitSteps.disconnectPush).toBe('function');
    // jsdom 里没有 SW、没有 PushManager：直接返回，不抛
    await expect(defaultExitSteps.disconnectPush?.()).resolves.toBeUndefined();
  });

  it('没传断开（测试桩、没有推送的环境）：其余照旧', async () => {
    const order: string[] = [];
    const s = steps(order);
    delete s.disconnectPush;
    const spy = vi.fn();
    await wipeThisDevice({ ...s, wipe: async () => (spy(), true) });
    expect(order).toEqual(['clearCacheStorage']);
  });
});
