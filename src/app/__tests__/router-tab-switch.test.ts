// 四个页签之间互切不走 View Transition（负责人 11-06 方案 B）：navigate、底栏 <a href> 的 hashchange 都走 fadeSwap，
// 不分方向（11-18 负责人“底部导航切页动画直接套用日历的切页动画”：原地模糊淡换，原来的左右滑入删掉）；别的切页照旧 transition
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  transition: vi.fn((update: () => void) => {
    update();
    return Promise.resolve();
  }),
  fadeSwap: vi.fn((update: () => void, _part?: boolean) => {
    update();
    return Promise.resolve();
  }),
  cancelFade: vi.fn(),
}));
vi.mock('../../motion/index.ts', () => m);

const { navigate, replaceRoute, setAnimOf, useRoute } = await import('../router.ts');
const { renderHook } = await import('@testing-library/react');

// 和 App 装的是同一份规则（page-anim.ts 的 animFor），不另抄一份（代码审查 D3）；wide 是网页版宽屏（MQ_DESK_WIDE）
const { animFor, installPageAnim } = await import('../page-anim.ts');
installPageAnim((await import('../features.ts')).featureRoutes);
let wide = false;

beforeEach(() => {
  window.history.replaceState(null, '', '/app/#/today');
  m.transition.mockClear();
  m.fadeSwap.mockClear();
  m.cancelFade.mockClear();
  wide = false;
  setAnimOf((a, b) => animFor(a, b, wide));
});
afterEach(() => {
  setAnimOf(() => 'none');
});

describe('页签互切：fadeSwap，不起 View Transition', () => {
  it('navigate / replaceRoute 在两个页签之间：fadeSwap（不分方向，只传换页那一步）', async () => {
    await navigate('todos');
    expect(m.fadeSwap).toHaveBeenCalledTimes(1);
    expect(m.transition).not.toHaveBeenCalled();
    await replaceRoute('calendar');
    expect(m.fadeSwap).toHaveBeenCalledTimes(2);
    expect(window.location.hash).toBe('#/calendar');
    expect(m.fadeSwap.mock.calls.every((c) => c[1] === false)).toBe(true);
  });

  it('同一页里新进一层（纪念日列表 → 编辑层、月历 → 周视图）：不起任何过渡，浏览器历史不多一条（整块评审第 20 条；R-487）', async () => {
    await navigate('calendar');
    m.fadeSwap.mockClear();
    const len = window.history.length;
    await navigate('cal', 'week', '2026-12-07');
    expect(m.transition).not.toHaveBeenCalled();
    expect(m.fadeSwap).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/cal/week/2026-12-07');
    expect(window.history.length).toBe(len);
  });

  it('网页版宽屏（负责人 11-25）：设置里换层只淡换详情那一栏（part）；进出设置、最近删除和页签互切一样原地淡换；进编辑页照旧整页推', async () => {
    wide = true;
    await navigate('settings');
    expect(m.fadeSwap.mock.calls.at(-1)?.[1]).toBe(false);
    await navigate('settings', 'skin');
    await navigate('settings');
    expect(m.fadeSwap.mock.calls.slice(-2).map((c) => c[1])).toEqual([true, true]);
    await navigate('trash', 'todos');
    await navigate('settings');
    await navigate('trash');
    await replaceRoute('today');
    expect(m.fadeSwap.mock.calls.slice(-4).map((c) => c[1])).toEqual([false, false, false, false]);
    expect(m.transition).not.toHaveBeenCalled();
    await navigate('event', 'new');
    expect(m.transition).toHaveBeenCalledTimes(1);
  });

  it('手机、窄屏：设置里换层、进出设置和最近删除照旧整页推', async () => {
    await navigate('settings');
    await navigate('settings', 'skin');
    await navigate('trash');
    await navigate('today');
    expect(m.transition).toHaveBeenCalledTimes(4);
    expect(m.fadeSwap).not.toHaveBeenCalled();
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

  it('浏览器历史前进后退（iOS 系统边缘手势已经自己播了截图）紧跟的 hashchange：直接画，不再补整页过渡、不淡入（负责人 11-20“右滑进设置页会跳一下画面”）', () => {
    // 手机（没有悬停）才跳过：jsdom 没有 matchMedia，临时装一个
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(hover: none)' }));
    const { result, unmount } = renderHook(() => useRoute());
    window.history.replaceState(null, '', '/app/#/settings');
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: 'http://x/app/#/todos', newURL: 'http://x/app/#/settings' }));
    expect(m.transition).not.toHaveBeenCalled();
    expect(m.fadeSwap).not.toHaveBeenCalled();
    expect(result.current.name).toBe('settings');
    // 只管紧跟的那一次：之后普通换地址照旧起过渡
    window.history.replaceState(null, '', '/app/#/event/new');
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: 'http://x/app/#/settings', newURL: 'http://x/app/#/event/new' }));
    expect(m.transition).toHaveBeenCalledTimes(1);
    unmount();
    vi.unstubAllGlobals();
  });
});
