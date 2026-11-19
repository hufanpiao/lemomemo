// 四个主页面从屏幕左右两边往里划（负责人 11-18：只在左右两边触发、两头循环、二级页不切；11-19：右边往左划进设置，设置首页左边往右划退回）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Router from '../router.ts';

const nav = vi.hoisted(() => ({ to: [] as string[], back: false }));
vi.mock('../router.ts', async (orig) => ({
  ...(await orig<typeof Router>()),
  navigateTab: (n: string) => nav.to.push(n),
  navigate: (n: string) => nav.to.push(`push:${n}`),
  replaceRoute: (n: string) => nav.to.push(`replace:${n}`),
  goBack: () => nav.to.push('goBack'),
  canGoBack: () => nav.back,
}));

import { SIDE_PX } from '../../motion/gestures.ts';
import { blockedAt, installTabSwipe, swipeTarget, SWIPE_MAX_MS, SWIPE_MIN_PX } from '../tab-swipe.ts';

describe('swipeTarget：划完去哪个页签', () => {
  it('左边那条往右划（负责人说的“左滑”）去下一个：今天 → 日历 → 待办 → 随手记 → 今天；右边那条往左划进设置', () => {
    expect(swipeTarget('today', 'l', 80, 0, 200)).toBe('calendar');
    expect(swipeTarget('calendar', 'l', 80, 0, 200)).toBe('todos');
    expect(swipeTarget('todos', 'l', 80, 0, 200)).toBe('notes');
    expect(swipeTarget('notes', 'l', 80, 0, 200), '随手记往下一个回到今天').toBe('today');
    for (const r of ['today', 'calendar', 'cal', 'todos', 'notes']) expect(swipeTarget(r, 'r', -80, 0, 200), `${r} 右边往左划进设置（负责人 11-19）`).toBe('settings');
  });
  it('方向不对（右边那条往右划、左边那条往左划）不切', () => {
    expect(swipeTarget('today', 'r', 80, 0, 200)).toBeNull();
    expect(swipeTarget('today', 'l', -80, 0, 200)).toBeNull();
  });
  it('二级页（编辑、设置、纪念日、隐私记）不切；日历翻过月（cal）还是日历主页面', () => {
    for (const r of ['edit', 'settings', 'settings-sub', 'anniv', 'vault']) expect(swipeTarget(r, 'r', -80, 0, 200)).toBeNull();
    for (const r of ['edit', 'settings-sub', 'anniv', 'vault']) expect(swipeTarget(r, 'l', 80, 0, 200)).toBeNull();
    expect(swipeTarget('settings', 'l', 80, 0, 200), '设置首页左边往右划退回').toBe('back');
    expect(swipeTarget('cal', 'l', 80, 0, 200)).toBe('todos');
  });
  it('太短、太斜、太慢都不切', () => {
    expect(swipeTarget('today', 'r', -(SWIPE_MIN_PX - 1), 0, 200)).toBeNull();
    expect(swipeTarget('today', 'r', -80, 65, 200), '横移不到竖移 1.25 倍').toBeNull();
    expect(swipeTarget('today', 'l', 103, 60, 200), '416 日志里被拒的那一下').toBe('calendar');
    expect(swipeTarget('today', 'r', -80, 0, SWIPE_MAX_MS + 1)).toBeNull();
  });
});

/** 搭一页：标题、输入框、底栏里的页签；extra 给了再加一个弹层 */
function page(extra = false): void {
  const el = (tag: string, id: string, attrs: Record<string, string> = {}): HTMLElement => {
    const e = document.createElement(tag);
    if (id) e.id = id;
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const main = el('main', '');
  const bar = el('nav', '', { 'data-testid': 'tabbar' });
  bar.append(el('a', 'tab'));
  main.append(el('h1', 'blank'), el('input', 'in'), bar);
  document.body.replaceChildren(main);
  if (extra) document.body.append(el('div', '', { role: 'dialog' }));
}
const byId = (id: string): HTMLElement => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`没有 #${id}`);
  return e;
};

describe('blockedAt：切页带里起手、但不切的地方', () => {
  afterEach(() => document.body.replaceChildren());
  it('输入框、底栏、弹层开着、焦点在输入框都不切；别处能切', () => {
    page();
    expect(blockedAt(byId('blank'))).toBeNull();
    expect(blockedAt(byId('in'))).toBe('input');
    expect(blockedAt(byId('tab'))).toBe('tabbar');
    (byId('in') as HTMLInputElement).focus();
    expect(blockedAt(byId('blank'))).toBe('kb');
    (byId('in') as HTMLInputElement).blur();
    page(true);
    expect(blockedAt(byId('blank'))).toBe('layer');
  });
});

describe('installTabSwipe：真的划一下', () => {
  let off: () => void = () => undefined;
  const W = window.innerWidth;
  const touch = (type: string, x: number, y: number, target: Element, ended = false): void => {
    const e = new Event(type, { bubbles: true });
    const p = { clientX: x, clientY: y };
    Object.defineProperty(e, 'touches', { value: ended ? [] : [p] });
    Object.defineProperty(e, 'changedTouches', { value: [p] });
    target.dispatchEvent(e);
  };
  const swipe = (x0: number, x1: number): void => {
    const t = byId('blank');
    touch('touchstart', x0, 200, t);
    touch('touchend', x1, 205, t, true);
  };
  beforeEach(() => {
    nav.to = [];
    page();
    off = installTabSwipe(document);
  });
  afterEach(() => {
    off();
    window.location.hash = '';
    document.body.replaceChildren();
  });
  it('左边那条往右划：今天 → 日历；右边那条往左划：压一条历史进设置', () => {
    window.location.hash = '#/today';
    swipe(10, 150);
    expect(nav.to).toEqual(['calendar']);
    swipe(W - 10, W - 150);
    expect(nav.to).toEqual(['calendar', 'push:settings']);
  });
  it(`中间区域（离两边 ${SIDE_PX} px 以外）起手不切`, () => {
    window.location.hash = '#/today';
    swipe(W / 2 + 80, W / 2 - 80);
    swipe(SIDE_PX + 1, SIDE_PX + 150);
    expect(nav.to).toEqual([]);
  });
  it('抬手前同一地址的历史换了一条（系统侧滑退掉打字条垫的那一条，hash 不变）：判 moved 不切（独立评审 11-19 高 2）', () => {
    window.location.hash = '#/today';
    const t = byId('blank');
    touch('touchstart', 10, 200, t);
    window.history.replaceState({ other: 1 }, '', window.location.href);
    touch('touchend', 150, 205, t, true);
    expect(nav.to).toEqual([]);
  });
  it('负责人 11-19：从待办详情退回待办页后右边往左划，系统“前进”先把页面带回那条待办——把这一条原地换成设置（不退回、不再等 popstate）', () => {
    window.history.replaceState({ lemoDepth: 0 }, '', '#/todos');
    const t = byId('blank');
    touch('touchstart', W - 10, 200, t);
    window.history.pushState({ lemoDepth: 1 }, '', '#/todo/x');
    touch('touchend', W - 150, 205, t, true);
    expect(nav.to).toEqual(['replace:settings']);
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(nav.to).toEqual(['replace:settings']);
    // 起手在详情页（不是主页面）、地址变了：照旧判 moved，不动
    window.history.replaceState({ lemoDepth: 1 }, '', '#/todo/y');
    touch('touchstart', W - 10, 200, t);
    window.history.replaceState({ lemoDepth: 0 }, '', '#/todos');
    touch('touchend', W - 150, 205, t, true);
    expect(nav.to).toEqual(['replace:settings']);
  });
  it('负责人 11-19 下午“修完还是进待办编辑”：iPhone 把系统“前进”当触摸取消、根本没有抬手——按下以后来了 popstate 就把这一条换成设置', () => {
    window.history.replaceState({ lemoDepth: 0 }, '', '#/todos');
    const t = byId('blank');
    touch('touchstart', W - 10, 200, t);
    touch('touchcancel', W - 30, 200, t, true);
    window.history.pushState({ lemoDepth: 1 }, '', '#/todo/x');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(nav.to).toEqual(['replace:settings']);
    // 左边那条起手、或者起手在详情页：来了 popstate 也不管
    nav.to = [];
    window.history.replaceState({ lemoDepth: 0 }, '', '#/todos');
    touch('touchstart', 10, 200, t);
    window.history.pushState({ lemoDepth: 1 }, '', '#/todo/x');
    window.dispatchEvent(new PopStateEvent('popstate'));
    touch('touchstart', W - 10, 200, t);
    window.history.pushState({ lemoDepth: 2 }, '', '#/todo/y');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(nav.to).toEqual([]);
  });
  it('负责人 11-19 傍晚“设置页自动闪退”：系统“前进”带回来的本来就是设置首页（之前从设置退回来过）——照收，不退回、不换', () => {
    window.history.replaceState({ lemoDepth: 0 }, '', '#/todos');
    const t = byId('blank');
    touch('touchstart', W - 10, 200, t);
    touch('touchcancel', W - 30, 200, t, true);
    window.history.pushState({ lemoDepth: 1 }, '', '#/settings');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(nav.to).toEqual([]);
    expect(window.location.hash).toBe('#/settings');
    // 抬手照送的那一种也一样
    window.history.replaceState({ lemoDepth: 0 }, '', '#/notes');
    touch('touchstart', W - 10, 200, t);
    window.history.pushState({ lemoDepth: 1 }, '', '#/settings');
    touch('touchend', W - 150, 205, t, true);
    expect(nav.to).toEqual([]);
  });
  it('设置首页：右边往左划不动；左边往右划退回（有上一页退一步，没有就原地换回今天、不退出 App）；设置子页都不管', () => {
    window.location.hash = '#/settings';
    swipe(W - 10, W - 150);
    expect(nav.to).toEqual([]);
    nav.back = true;
    swipe(10, 150);
    nav.back = false;
    swipe(10, 150);
    expect(nav.to).toEqual(['goBack', 'replace:today']);
    window.location.hash = '#/settings/calendar';
    swipe(10, 150);
    swipe(W - 10, W - 150);
    expect(nav.to).toEqual(['goBack', 'replace:today']);
  });
});
