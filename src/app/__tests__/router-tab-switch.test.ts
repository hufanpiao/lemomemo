// 四个页签之间互切不走 View Transition（负责人 11-06 方案 B）：navigate、底栏 <a href> 的 hashchange 都走 fadeSwap；别的切页照旧 transition
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  transition: vi.fn((update: () => void) => {
    update();
    return Promise.resolve();
  }),
  fadeSwap: vi.fn((update: () => void, pick: () => Element | null) => {
    void pick;
    update();
    return Promise.resolve();
  }),
  cancelFade: vi.fn(),
}));
vi.mock('../../motion/index.ts', () => m);

const { navigate, replaceRoute, setSamePage, setTabSwitch, useRoute } = await import('../router.ts');
const { renderHook } = await import('@testing-library/react');

const TABS = new Set(['today', 'calendar', 'cal', 'todos', 'notes']);
const tabOf = (n: string): string => (n === 'cal' ? 'calendar' : n);

beforeEach(() => {
  window.history.replaceState(null, '', '/app/#/today');
  m.transition.mockClear();
  m.fadeSwap.mockClear();
  m.cancelFade.mockClear();
  setTabSwitch((a, b) => TABS.has(a.name) && TABS.has(b.name) && tabOf(a.name) !== tabOf(b.name));
  setSamePage((a, b) => tabOf(a.name) === 'calendar' && tabOf(b.name) === 'calendar');
});
afterEach(() => {
  setTabSwitch(() => false);
  setSamePage(() => false);
});

describe('页签互切：fadeSwap，不起 View Transition', () => {
  it('navigate / replaceRoute 在两个页签之间：fadeSwap；拿的是新页的 main', async () => {
    await navigate('todos');
    expect(m.fadeSwap).toHaveBeenCalledTimes(1);
    expect(m.transition).not.toHaveBeenCalled();
    const main = document.createElement('main');
    document.body.append(main);
    const pick = m.fadeSwap.mock.calls[0]?.[1];
    expect(pick?.()).toBe(main);
    main.remove();
    await replaceRoute('calendar');
    expect(m.fadeSwap).toHaveBeenCalledTimes(2);
    expect(window.location.hash).toBe('#/calendar');
  });

  it('同一页里新压一条（纪念日列表 → 编辑层、月历 → 周视图）：不起任何过渡，照样压一条历史（整块评审第 20 条：pushInPage 并进 navigate）', async () => {
    await navigate('calendar');
    m.fadeSwap.mockClear();
    const len = window.history.length;
    await navigate('cal', 'week', '2026-12-07');
    expect(m.transition).not.toHaveBeenCalled();
    expect(m.fadeSwap).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/cal/week/2026-12-07');
    expect(window.history.length).toBe(len + 1);
  });

  it('页签和别的页之间（进编辑页、设置）：照旧 View Transition', async () => {
    await navigate('todo', 'new');
    await navigate('today');
    await navigate('settings');
    expect(m.transition).toHaveBeenCalledTimes(3);
    expect(m.fadeSwap).not.toHaveBeenCalled();
  });

  it('底栏 <a href> 换地址（hashchange）：页签互切 fadeSwap；月历同一页里不动；进编辑页 View Transition', () => {
    const { unmount } = renderHook(() => useRoute());
    const go = (from: string, to: string): void => {
      window.history.replaceState(null, '', `/app/${to}`);
      window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: `http://x/app/${from}`, newURL: `http://x/app/${to}` }));
    };
    go('#/today', '#/calendar');
    expect(m.fadeSwap).toHaveBeenCalledTimes(1);
    go('#/calendar', '#/cal/month/2026-12');
    expect(m.fadeSwap).toHaveBeenCalledTimes(1);
    // 同页内切换：停掉还在等分包的淡入，只停等待、不打断正在播的（代码审查方案 B M9）
    expect(m.cancelFade).toHaveBeenCalledWith(false);
    expect(m.transition).not.toHaveBeenCalled();
    go('#/cal/month/2026-12', '#/event/new');
    expect(m.transition).toHaveBeenCalledTimes(1);
    go('#/event/new', '#/notes');
    expect(m.transition).toHaveBeenCalledTimes(2);
    expect(m.fadeSwap).toHaveBeenCalledTimes(1);
    unmount();
  });
});
