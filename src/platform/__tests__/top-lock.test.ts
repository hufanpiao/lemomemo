// 所有页面顶部固定（R-488，platform/top-lock.ts）：在页顶除了往上推都拦下默认（竖拉、斜拉、边缘横划换页，iOS 不把整页拽下来）；往上推、不在顶上、
// 按在里面竖着还能往上滚或能横着滚的框里都放行；一下手势只在第一次 touchmove 定一次。真机回弹拦没拦住这里测不了，只能 iPhone 看
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTopLock, pullsDown } from '../top-lock.ts';

const logs = vi.hoisted(() => [] as string[]);
vi.mock('../run-log-api.ts', async (orig) => ({ ...(await orig<object>()), rlog: (l: string) => logs.push(l) }));

let scrollY = 0;
let off: () => void = () => undefined;

const touch = (type: string, target: EventTarget, x: number, y: number): boolean => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] });
  target.dispatchEvent(e);
  return e.defaultPrevented;
};
/** 按下 (100,100)，依次移到每个 [dx, dy]；返回每一下 move 被没被拦 */
const pull = (target: EventTarget, ...moves: [number, number][]): boolean[] => {
  touch('touchstart', target, 100, 100);
  const out = moves.map(([dx, dy]) => touch('touchmove', target, 100 + dx, 100 + dy));
  touch('touchend', target, 0, 0);
  return out;
};
const box = (style: Partial<CSSStyleDeclaration>, size: Record<string, number>): HTMLElement => {
  const el = document.createElement('div');
  Object.assign(el.style, style);
  for (const [k, v] of Object.entries(size)) Object.defineProperty(el, k, { configurable: true, value: v });
  const inner = document.createElement('p');
  el.append(inner);
  document.body.append(el);
  return el;
};

beforeEach(() => {
  scrollY = 0;
  logs.length = 0;
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
  off = installTopLock();
});
afterEach(() => {
  off();
  document.body.replaceChildren();
});

describe('installTopLock', () => {
  it('页顶往下拉、斜拉、横划（边缘右滑换页）都拦下（整下都拦）；往上推、不在顶上放行', () => {
    expect(pull(document.body, [0, 30], [0, 10])).toEqual([true, true]);
    expect(pull(document.body, [0, -30])).toEqual([false]);
    expect(pull(document.body, [40, 20])).toEqual([true]);
    expect(pull(document.body, [16, 30])).toEqual([true]);
    expect(pull(document.body, [112, 40])).toEqual([true]);
    expect(pull(document.body, [-40, -10])).toEqual([true]);
    expect(pull(document.body, [5, -30])).toEqual([false]);
    scrollY = 10;
    expect(pull(document.body, [0, 30])).toEqual([false]);
  });

  it('第一下定了放行，后面变成往下拉也不再拦（iOS 原生滚动已经接手）；第一下没位移不算数', () => {
    expect(pull(document.body, [0, -5], [0, 80])).toEqual([false, false]);
    expect(pull(document.body, [0, 0], [1, 1])).toEqual([false, true]);
  });

  it('和下拉搜索同一个“往下拉”门槛', () => {
    expect(pullsDown(0, 10)).toBe(true);
    expect(pullsDown(4, 10)).toBe(true);
    expect(pullsDown(5, 10)).toBe(false);
    expect(pullsDown(0, 0)).toBe(false);
  });

  it('按在竖着还能往上滚的框里放行，滚到它自己顶上照拦；能横着滚的框（分类胶囊行）放行', () => {
    const v = box({ overflowY: 'auto' }, { scrollHeight: 500, clientHeight: 100 });
    v.scrollTop = 50;
    expect(pull(v.firstChild as Element, [0, 30])).toEqual([false]);
    v.scrollTop = 0;
    expect(pull(v.firstChild as Element, [0, 30])).toEqual([true]);
    const h = box({ overflowX: 'auto' }, { scrollWidth: 800, clientWidth: 300 });
    expect(pull(h.firstChild as Element, [2, 3])).toEqual([false]);
  });

  it('运行日志：只记在顶上不是往上推的那一下怎么定的（拦了 / 交给里面的框），带位移；往上推不记', () => {
    pull(document.body, [0, 30], [0, 40]);
    pull(document.body, [0, -30]);
    const v = box({ overflowY: 'auto' }, { scrollHeight: 500, clientHeight: 100 });
    v.scrollTop = 50;
    pull(v.firstChild as Element, [0, 30]);
    expect(logs).toEqual(['toplock block dx=0 dy=30 y=0', 'toplock pass inner dx=0 dy=30 y=0']);
  });

  it('装两次只生效一份；卸掉以后不再拦', () => {
    const second = installTopLock();
    second();
    expect(pull(document.body, [0, 30])).toEqual([true]);
    off();
    off = () => undefined;
    expect(pull(document.body, [0, 30])).toEqual([false]);
  });
});
