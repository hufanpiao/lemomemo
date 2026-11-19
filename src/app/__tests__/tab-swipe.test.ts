// 左右两条切页带里的横划：四个主页面切页签、右边往左划进设置（负责人 11-18、11-19）；别的页左边往右划是 App 自己的返回（R-487）
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
import { parseHash } from '../router.ts';
import { blockedAt, installTabSwipe, isEdgeBack, parentOf, swipeTarget, SWIPE_MAX_MS, SWIPE_MIN_PX } from '../tab-swipe.ts';

describe('swipeTarget：主页面上划完去哪', () => {
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
  it('不是主页面不切；日历翻过月（cal）还是日历主页面', () => {
    for (const r of ['todo', 'settings', 'anniv', 'vault']) expect(swipeTarget(r, 'l', 80, 0, 200)).toBeNull();
    expect(swipeTarget('cal', 'l', 80, 0, 200)).toBe('todos');
  });
  it('太短、太斜、太慢都不切', () => {
    expect(swipeTarget('today', 'r', -(SWIPE_MIN_PX - 1), 0, 200)).toBeNull();
    expect(swipeTarget('today', 'r', -80, 65, 200), '横移不到竖移 1.25 倍').toBeNull();
    expect(swipeTarget('today', 'l', 103, 60, 200), '416 日志里被拒的那一下').toBe('calendar');
    expect(swipeTarget('today', 'r', -80, 0, SWIPE_MAX_MS + 1)).toBeNull();
  });
});

describe('别的页的返回（R-487）', () => {
  it('isEdgeBack：只认左边那条往右划，够长、够横，不限时长', () => {
    expect(isEdgeBack('l', SWIPE_MIN_PX, 0)).toBe(true);
    expect(isEdgeBack('l', SWIPE_MIN_PX - 1, 0)).toBe(false);
    expect(isEdgeBack('l', 80, 65)).toBe(false);
    expect(isEdgeBack('r', -80, 0)).toBe(false);
  });
  it('parentOf：直接打开时回父级', () => {
    const p = (h: string): string | null => parentOf(parseHash(h));
    expect(p('#/todo/x')).toBe('todos');
    expect(p('#/event/x')).toBe('calendar');
    expect(p('#/note/x')).toBe('notes');
    expect(p('#/vault')).toBe('notes');
    expect(p('#/settings/remind/dnd')).toBe('settings');
    expect(p('#/settings')).toBe('today');
    expect(p('#/remind/todo/x')).toBe('today');
    expect(p('#/anniv')).toBeNull();
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

describe('blockedAt：主页面上切页带里起手、但不切的地方', () => {
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
  const swipe = (x0: number, x1: number, id = 'blank'): void => {
    const t = byId(id);
    touch('touchstart', x0, 200, t);
    touch('touchend', x1, 205, t, true);
  };
  beforeEach(() => {
    nav.to = [];
    nav.back = false;
    page();
    off = installTabSwipe(document);
  });
  afterEach(() => {
    off();
    window.location.hash = '';
    document.body.replaceChildren();
  });
  it('左边那条往右划：今天 → 日历；右边那条往左划进设置（压进返回栈）', () => {
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
  it('主页面上从输入框起手不切', () => {
    window.location.hash = '#/today';
    swipe(10, 150, 'in');
    expect(nav.to).toEqual([]);
  });
  it('抬手前地址变了：判 moved 不动', () => {
    window.location.hash = '#/today';
    const t = byId('blank');
    touch('touchstart', 10, 200, t);
    window.history.replaceState(null, '', '#/todos');
    touch('touchend', 150, 205, t, true);
    expect(nav.to).toEqual([]);
  });
  it('编辑页左边往右划：有上一页退一步，没有回父级；从输入框起手、焦点在输入框里、慢慢划都算', () => {
    window.location.hash = '#/todo/x';
    nav.back = true;
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(SWIPE_MAX_MS * 4);
    swipe(10, 150, 'in');
    vi.restoreAllMocks();
    nav.back = false;
    (byId('in') as HTMLInputElement).focus();
    swipe(10, 150);
    expect(nav.to).toEqual(['goBack', 'replace:todos']);
  });
  it('编辑页：右边往左划、太短、太斜不动；弹层开着不动', () => {
    window.location.hash = '#/todo/x';
    swipe(W - 10, W - 150);
    swipe(10, 10 + SWIPE_MIN_PX - 1);
    const t = byId('blank');
    touch('touchstart', 10, 200, t);
    touch('touchend', 90, 300, t, true);
    page(true);
    swipe(10, 150);
    expect(nav.to).toEqual([]);
  });
  it('设置首页：右边往左划不动；左边往右划退回（有上一页退一步，没有就回今天）；设置子页没栈时回设置首页', () => {
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
    expect(nav.to).toEqual(['goBack', 'replace:today', 'replace:settings']);
  });
  it('没有父级的页（纪念日）栈空时不动', () => {
    window.location.hash = '#/anniv';
    swipe(10, 150);
    expect(nav.to).toEqual([]);
  });
});
