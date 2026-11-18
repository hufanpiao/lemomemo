// 四个主页面从屏幕左右两边往里划切页签（负责人 11-18：只在左右两边触发、两头循环、二级页不切）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Router from '../router.ts';

const nav = vi.hoisted(() => ({ to: [] as string[] }));
vi.mock('../router.ts', async (orig) => ({ ...(await orig<typeof Router>()), navigateTab: (n: string) => nav.to.push(n) }));

import { SIDE_PX } from '../../motion/gestures.ts';
import { blockedAt, installTabSwipe, swipeTarget, SWIPE_MAX_MS, SWIPE_MIN_PX } from '../tab-swipe.ts';

describe('swipeTarget：划完去哪个页签', () => {
  it('左边那条往右划（负责人说的“左滑”）去下一个：今天 → 日历 → 待办 → 随手记 → 今天；右边那条往左划去上一个', () => {
    expect(swipeTarget('today', 'l', 80, 0, 200)).toBe('calendar');
    expect(swipeTarget('calendar', 'l', 80, 0, 200)).toBe('todos');
    expect(swipeTarget('todos', 'l', 80, 0, 200)).toBe('notes');
    expect(swipeTarget('notes', 'l', 80, 0, 200), '随手记往下一个回到今天').toBe('today');
    expect(swipeTarget('todos', 'r', -80, 0, 200)).toBe('calendar');
    expect(swipeTarget('today', 'r', -80, 0, 200), '今天往上一个到随手记').toBe('notes');
  });
  it('方向不对（右边那条往右划、左边那条往左划）不切', () => {
    expect(swipeTarget('today', 'r', 80, 0, 200)).toBeNull();
    expect(swipeTarget('today', 'l', -80, 0, 200)).toBeNull();
  });
  it('二级页（编辑、设置、纪念日、隐私记）不切；日历翻过月（cal）还是日历主页面', () => {
    for (const r of ['edit', 'settings', 'anniv', 'vault']) expect(swipeTarget(r, 'r', -80, 0, 200)).toBeNull();
    expect(swipeTarget('cal', 'l', 80, 0, 200)).toBe('todos');
    expect(swipeTarget('cal', 'r', -80, 0, 200)).toBe('today');
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
  it('左边那条往右划：今天 → 日历；右边那条往左划：今天 → 随手记（循环）', () => {
    window.location.hash = '#/today';
    swipe(10, 150);
    expect(nav.to).toEqual(['calendar']);
    swipe(W - 10, W - 150);
    expect(nav.to).toEqual(['calendar', 'notes']);
  });
  it(`中间区域（离两边 ${SIDE_PX} px 以外）起手不切`, () => {
    window.location.hash = '#/today';
    swipe(W / 2 + 80, W / 2 - 80);
    swipe(SIDE_PX + 1, SIDE_PX + 150);
    expect(nav.to).toEqual([]);
  });
  it('设置页上划不切', () => {
    window.location.hash = '#/settings';
    swipe(W - 10, W - 150);
    expect(nav.to).toEqual([]);
  });
});
