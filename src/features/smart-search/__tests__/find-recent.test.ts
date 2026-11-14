// “最近找过”跟着账号走（data/find-recent.ts；B4b-3 独立评审第 18 条）：退出、换账号时 core/store 的 clearAllCollections 清内存，
// 下一个账号打开查找面板看不到上一个账号找过的词，并从自己的本机缓存重新读
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({ meta: new Map<string, unknown>() }));
vi.mock('../../../core/boot.ts', () => ({
  getBoot: () => ({
    cache: {
      isClosed: () => false,
      getMeta: async (k: string) => fx.meta.get(k),
      setMeta: async (k: string, v: unknown) => void fx.meta.set(k, v),
    },
  }),
}));
const { clearAllCollections } = await import('../../../core/store.ts');
const { addRecent, loadRecent, recentSnapshot, resetRecentForTest, subscribeRecent } = await import('../data/find-recent.ts');

beforeEach(() => {
  fx.meta.clear();
  resetRecentForTest();
});

describe('最近找过：退出、换账号', () => {
  it('clearAllCollections 之后内存里的清空、通知订阅的', () => {
    addRecent('体检报告');
    expect(recentSnapshot()).toEqual(['体检报告']);
    const fn = vi.fn();
    const off = subscribeRecent(fn);
    clearAllCollections();
    off();
    expect(recentSnapshot()).toEqual([]);
    expect(fn).toHaveBeenCalled();
  });

  it('清过以后重新读下一个账号自己的本机缓存（不沿用上一次已读过的标记）', async () => {
    fx.meta.set('ui.find_recent', ['甲的词']);
    await loadRecent();
    expect(recentSnapshot()).toEqual(['甲的词']);
    clearAllCollections();
    fx.meta.set('ui.find_recent', ['乙的词']);
    await loadRecent();
    expect(recentSnapshot()).toEqual(['乙的词']);
  });
});
