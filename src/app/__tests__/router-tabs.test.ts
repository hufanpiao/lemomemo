// 按层级记历史（R-372，负责人 11-10“整体往左滑应该是返回上一个层级，不是返回上一个操作啊！！”）：
// ① 底栏四个页签今天是根：今天 → 别的页签压一条，别的页签之间原地换，回今天能退就退；在今天页左滑不动
// ② 日历里翻月、切月/周、“今天”、选年月、点某天进周视图算同一层（replaceInPage，不记步数）
// 设置“‹ 今天”按层级退回（backTo），不新压一条；iOS 恢复后（编号对不上）不退到 App 外
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backTo, canGoBack, navigate, navigateTab, resetLoadForTest, useRoute } from '../router.ts';
import { replaceInPage } from '../router-levels.ts';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function back(): Promise<void> {
  window.history.back();
  await vi.waitFor(() => new Promise((r) => setTimeout(r, 10)));
  await flush();
}

let base = 0;
beforeEach(() => {
  resetLoadForTest();
  // 进 App 的第一页（深度 0，没有编号）。用 push 截掉上一个用例留下的“前进”历史，history.length 才能拿来比
  window.history.pushState(null, '', '#/today');
  base = window.history.length;
});
afterEach(() => {
  cleanup(); // 卸掉 useRoute：下一个用例重新订阅时才记下第一页（entryAt），和 App 载入时一样
  vi.restoreAllMocks();
});

describe('① 底栏页签：今天是根', () => {
  it('今天 → 日历 → 待办 → 随手记：只压一条；后退一步回今天', async () => {
    renderHook(() => useRoute());
    navigateTab('calendar');
    await flush();
    navigateTab('todos');
    await flush();
    navigateTab('notes');
    await flush();
    expect(window.location.hash).toBe('#/notes');
    expect(window.history.length).toBe(base + 1);
    await back();
    expect(window.location.hash).toBe('#/today');
  });

  it('回到今天以后没有 App 里的上一页（今天页左滑不动，不出 App）；再去别的页签也只压一条', async () => {
    renderHook(() => useRoute());
    navigateTab('todos');
    await flush();
    navigateTab('calendar');
    await flush();
    navigateTab('today'); // 上一条就是今天：退一步，不新压
    await vi.waitFor(() => expect(window.location.hash).toBe('#/today'));
    await flush();
    expect(window.history.length).toBe(base + 1);
    expect(canGoBack()).toBe(false);
    navigateTab('notes');
    await flush();
    expect(window.history.length).toBe(base + 1); // 截掉前进的那条，再压一条
    await back();
    expect(window.location.hash).toBe('#/today');
  });

  it('点当前页签不动', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    navigateTab('today');
    await flush();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('直接打开别的页签（前面没有今天）点“今天”：原地换，不压也不退出 App', async () => {
    window.history.replaceState(null, '', '#/todos');
    const before = window.history.length;
    const go = vi.spyOn(window.history, 'back');
    navigateTab('today');
    await flush();
    expect(go).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/today');
    expect(window.history.length).toBe(before);
  });

  it('iOS 被系统收回后恢复（编号对不上）：点“今天”原地换，不 history.back 到 App 外', async () => {
    window.history.replaceState({ lemoDepth: 1, lemoDoc: -1 }, '', '#/calendar'); // 上一次载入压的那条
    const go = vi.spyOn(window.history, 'back');
    navigateTab('today');
    await flush();
    expect(go).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/today');
  });
});

describe('② 日历内部算同一层', () => {
  it('今天 → 日历 → 翻 3 个月、进周视图：后退一步回今天', async () => {
    renderHook(() => useRoute());
    navigateTab('calendar');
    await flush();
    for (const m of ['2026-12', '2027-01', '2027-02']) await replaceInPage('cal', 'month', m);
    await replaceInPage('cal', 'week', '2027-02-10');
    expect(window.history.length).toBe(base + 1);
    expect(canGoBack()).toBe(true); // 原地换沿用编号：日历里点“今天”页签照样退一步
    await back();
    expect(window.location.hash).toBe('#/today');
  });

  it('从日历翻过的月点“今天”页签：退一步回今天，不新压', async () => {
    renderHook(() => useRoute());
    navigateTab('calendar');
    await flush();
    await replaceInPage('cal', 'month', '2027-02');
    const push = vi.spyOn(window.history, 'pushState');
    navigateTab('today');
    await vi.waitFor(() => expect(window.location.hash).toBe('#/today'));
    expect(push).not.toHaveBeenCalled();
    expect(window.history.length).toBe(base + 1);
  });
});

describe('设置“‹ 今天”', () => {
  it('从今天头像进来：退一步回今天，不新压', async () => {
    renderHook(() => useRoute());
    await navigate('settings');
    const push = vi.spyOn(window.history, 'pushState');
    backTo('today');
    await vi.waitFor(() => expect(window.location.hash).toBe('#/today'));
    await flush();
    expect(push).not.toHaveBeenCalled();
    expect(window.history.length).toBe(base + 1);
    expect(canGoBack()).toBe(false);
  });

  it('直接打开设置：原地换成今天', async () => {
    window.history.replaceState(null, '', '#/settings');
    const go = vi.spyOn(window.history, 'back');
    backTo('today');
    await flush();
    expect(go).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/today');
    expect(window.history.length).toBe(base);
  });
});
