// 退出、换账号清本机 localStorage 里账号留下的痕迹只走一个入口（platform/exit-basics.ts 的 forgetAccountLocal；第三方审查第 10、13 条）：
// 外观缓存 pv-look、隐私记交给微软预览的同意 att.ms_preview_vault、日志上传队列 lemo.logq.*。这里守 core 的三个出口都走到它
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimCache, wipeLocal } from '../account.ts';
import { coldStart, resetBootForTest, type BootResult } from '../boot.ts';
import { freshCache } from './account-fixtures.ts';
import { fakeIndexedDB } from './idb-fake.ts';

const KEYS = ['pv-look', 'att.ms_preview_vault', 'lemo.logq.A', 'lemo.logq.B'];
const left = (): string[] => KEYS.filter((k) => localStorage.getItem(k) !== null);

beforeEach(() => {
  localStorage.clear();
  for (const k of KEYS) localStorage.setItem(k, '1');
  localStorage.setItem('att.ms_preview', 'yes');
});
afterEach(() => {
  resetBootForTest();
  localStorage.clear();
});

describe('core 的出口都清本机痕迹', () => {
  it('wipeLocal：清外观、隐私记同意、这个账号的日志队列；别的账号的队列和普通附件的同意不动', async () => {
    const cache = { name: 'x', isClosed: () => true, close: vi.fn(), seal: vi.fn() };
    const boot = { userId: 'A', switching: false, cache, outbox: { suspend: vi.fn() } } as unknown as BootResult;
    await wipeLocal(boot, { clearCacheStorage: async () => undefined, deleteDb: async () => undefined, wipeMs: 50, cachesMs: 50 });
    expect(left()).toEqual(['lemo.logq.B']);
    expect(localStorage.getItem('att.ms_preview')).toBe('yes');
  });

  it('claimCache 换了账号：清外观、隐私记同意；日志队列不动（新账号的队列由 main 的 clearOtherLogQueues 管）', async () => {
    const cache = await freshCache();
    await claimCache(cache, 'A');
    expect(left()).toEqual(KEYS);
    await claimCache(cache, 'B');
    expect(left()).toEqual(['lemo.logq.A', 'lemo.logq.B']);
    cache.close();
  });

  it('冷启动没有会话（不是登录过期）：全部清掉，日志队列哪个账号的都不留', async () => {
    const { factory } = fakeIndexedDB();
    await coldStart({ userId: null, cacheOptions: { factory }, readReauth: () => null });
    expect(left()).toEqual([]);
  });

  it('冷启动没有会话但是登录过期（有 lemo.reauth）：都留着，同一账号重新登录后照用', async () => {
    const { factory } = fakeIndexedDB();
    await coldStart({ userId: null, cacheOptions: { factory }, readReauth: () => ({}) as never });
    expect(left()).toEqual(KEYS);
  });
});
