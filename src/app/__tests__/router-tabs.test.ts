// 按层级返回（R-372，负责人 11-10“整体往左滑应该是返回上一个层级，不是返回上一个操作啊！！”）、返回栈（R-487，负责人 11-19“右滑重写”）：
// App 从不调 pushState，浏览器历史只有一条（iOS 主屏幕版留着“前进”那一条，右边缘往左划就被系统抢走）
// ① 底栏四个页签之间一律原地换；主页面是根，到了就清空栈
// ② 日历里翻月、切月/周、“今天”、选年月、点某天进周视图算同一层（replaceInPage，不动栈）
// 设置“‹ 今天”按层级退回（backTo）：栈顶是今天就退一步，否则原地换
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backTo, canGoBack, goBack, navigate, navigateTab, stackOf, useRoute } from '../router.ts';
import { replaceInPage } from '../router-levels.ts';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let base = 0;
beforeEach(() => {
  // 进 App 的第一页（没有栈）。用 push 截掉上一个用例留下的“前进”历史，history.length 才能拿来比
  window.history.pushState(null, '', '#/today');
  base = window.history.length;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('① 底栏页签：主页面是根', () => {
  it('今天 → 日历 → 待办 → 随手记 → 今天：一条都不压，始终没有 App 里的上一页（负责人 11-18 推翻 R-372 ①）', async () => {
    renderHook(() => useRoute());
    for (const t of ['calendar', 'todos', 'notes', 'today'] as const) {
      navigateTab(t);
      await vi.waitFor(() => expect(window.location.hash).toBe(`#/${t}`));
      await flush();
      expect(window.history.length, t).toBe(base);
      expect(canGoBack(), t).toBe(false);
    }
  });

  it('点当前页签不动', async () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    navigateTab('today');
    await flush();
    expect(replace).not.toHaveBeenCalled();
  });

  it('从二级页（栈里还有东西）点页签：到了主页面栈清空', async () => {
    window.history.replaceState({ lemoStack: ['#/todos', '#/todo/a'] }, '', '#/settings');
    navigateTab('notes');
    await flush();
    expect(window.location.hash).toBe('#/notes');
    expect(stackOf()).toEqual([]);
  });
});

describe('② 日历内部算同一层', () => {
  it('今天 → 日历 → 翻 3 个月、进周视图：一条都不压，栈一直是空的', async () => {
    renderHook(() => useRoute());
    navigateTab('calendar');
    await flush();
    for (const m of ['2026-12', '2027-01', '2027-02']) await replaceInPage('cal', 'month', m);
    await replaceInPage('cal', 'week', '2027-02-10');
    expect(window.history.length).toBe(base);
    expect(canGoBack()).toBe(false);
  });

  it('月历里点日程进编辑页、返回：回到那个月', async () => {
    renderHook(() => useRoute());
    await replaceInPage('cal', 'month', '2027-02');
    await navigate('event', 'x');
    expect(stackOf()).toEqual(['#/cal/month/2027-02']);
    goBack();
    await vi.waitFor(() => expect(window.location.hash).toBe('#/cal/month/2027-02'));
    expect(window.history.length).toBe(base);
  });
});

describe('设置“‹ 今天”', () => {
  it('从今天头像进来：退一步回今天，栈清空', async () => {
    renderHook(() => useRoute());
    await navigate('settings');
    expect(stackOf()).toEqual(['#/today']);
    backTo('today');
    await vi.waitFor(() => expect(window.location.hash).toBe('#/today'));
    await flush();
    expect(window.history.length).toBe(base);
    expect(canGoBack()).toBe(false);
  });

  it('直接打开设置：原地换成今天', async () => {
    window.history.replaceState(null, '', '#/settings');
    backTo('today');
    await flush();
    expect(window.location.hash).toBe('#/today');
    expect(window.history.length).toBe(base);
  });

  it('从日历头像进来（原地换）：栈顶不是今天，原地换成今天', async () => {
    window.history.replaceState(null, '', '#/calendar');
    navigateTab('settings');
    await flush();
    expect(window.location.hash).toBe('#/settings');
    expect(canGoBack()).toBe(false);
    backTo('today');
    await flush();
    expect(window.location.hash).toBe('#/today');
  });
});

describe('返回栈（R-487）', () => {
  it('负责人 11-19：待办 → 待办编辑 → 返回待办 → 右边往左划进设置：全程历史一条，设置的返回回到待办', async () => {
    renderHook(() => useRoute());
    const push = vi.spyOn(window.history, 'pushState');
    const back = vi.spyOn(window.history, 'back');
    navigateTab('todos');
    await flush();
    await navigate('todo', 'x');
    expect(stackOf()).toEqual(['#/todos']);
    goBack();
    await vi.waitFor(() => expect(window.location.hash).toBe('#/todos'));
    expect(stackOf()).toEqual([]);
    await navigate('settings');
    expect(window.location.hash).toBe('#/settings');
    expect(stackOf()).toEqual(['#/todos']);
    expect(window.history.length).toBe(base);
    goBack();
    await vi.waitFor(() => expect(window.location.hash).toBe('#/todos'));
    expect(push).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });

  it('栈空时 goBack 什么都不做（不 history.back 到 App 外）', async () => {
    window.history.replaceState(null, '', '#/todo/x');
    const back = vi.spyOn(window.history, 'back');
    goBack();
    await flush();
    expect(window.location.hash).toBe('#/todo/x');
    expect(back).not.toHaveBeenCalled();
  });

  it('刷新、iOS 恢复后栈还在（在 history.state 里）', () => {
    window.history.replaceState({ lemoStack: ['#/todos'] }, '', '#/todo/x');
    expect(canGoBack()).toBe(true);
  });

  it('没人接手的 <a href="#/…"> 普通点击：拦下交给路由，不让浏览器压历史；按着 Ctrl 的照常', async () => {
    renderHook(() => useRoute());
    const a = document.createElement('a');
    a.href = '#/todo/y';
    document.body.append(a);
    a.click();
    await vi.waitFor(() => expect(window.location.hash).toBe('#/todo/y'));
    expect(window.history.length).toBe(base);
    expect(stackOf()).toEqual(['#/today']);
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    a.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    a.remove();
  });
});
