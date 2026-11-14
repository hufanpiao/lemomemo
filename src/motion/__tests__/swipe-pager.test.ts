// 左右滑动翻页（B2 FA-3，架构 5.12 第 3 点）：先竖着动交给滚动、左边缘 20 px 让给系统返回手势、松手横移 60 px 才翻；
// 跟手只写 DOM 的 transform（不让页面重画，R-420 审查第 3 条）、松手滑到位；翻不动（onPage 返回 false）按“不够”滑回原位（第 1 条）。
// 锁方向、避让、跟手、吞点按在 hdrag.ts（和 kit 左滑行共用）；这里直接调 bind 上的四个处理函数测
// 真浏览器里逐帧的位移（新的一页真的从那一侧滑进来）由 tests/e2e/r420-swipe-taps.spec.ts 在 chromium、webkit 上量
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDGE_PX, inEdge, lockOf, SLOP_PX } from '../hdrag.ts';
import { enterOffset, swipeResult, TRIGGER_PX, useSwipePager } from '../swipe-pager.ts';

describe('swipe-pager 判断', () => {
  it('数字照架构 5.12：左边缘 20 px、横移 60 px；起滑距离 10 px（和左滑行同一个）', () => {
    expect(EDGE_PX).toBe(20);
    expect(TRIGGER_PX).toBe(60);
    expect(SLOP_PX).toBe(10);
  });

  it('动得太少不锁；横向大于竖向才算横滑，否则算竖滑（交给滚动）', () => {
    expect(lockOf(5, 3)).toBe('none');
    expect(lockOf(30, 10)).toBe('h');
    expect(lockOf(-30, 10)).toBe('h');
    expect(lockOf(15, 12)).toBe('h');
    expect(lockOf(12, 15)).toBe('v');
    expect(lockOf(2, 20)).toBe('v');
  });

  it('只有左边缘起手的不管（iPhone 侧滑返回）', () => {
    expect(inEdge(EDGE_PX - 1)).toBe(true);
    expect(inEdge(EDGE_PX)).toBe(false);
    expect(inEdge(380)).toBe(false);
  });

  it('松手：向左滑够 60 是下一页，向右是上一页；不够不翻', () => {
    expect(swipeResult(-TRIGGER_PX)).toBe(1);
    expect(swipeResult(TRIGGER_PX)).toBe(-1);
    expect(swipeResult(TRIGGER_PX - 1)).toBe(0);
    expect(swipeResult(-(TRIGGER_PX - 1))).toBe(0);
  });

  it('新的一页从拖出的那一侧接着滑进来', () => {
    expect(enterOffset(1, -80, 390)).toBe(310);
    expect(enterOffset(-1, 80, 390)).toBe(-310);
  });
});

type Bind = ReturnType<typeof useSwipePager>['bind'];
type Ev = Parameters<Bind['onPointerDown']>[0];

/** 挂着手势的那一块：真元素，宽 390；记下写过的每一个 transform（看新的一页从哪儿滑进来） */
function makePager() {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({ width: 390 }) as DOMRect;
  el.setPointerCapture = vi.fn();
  const cell = document.createElement('button');
  el.append(cell);
  document.body.append(el);
  const writes: string[] = [];
  const style = el.style;
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(style), 'transform')?.set;
  Object.defineProperty(style, 'transform', {
    configurable: true,
    get: () => style.getPropertyValue('transform'),
    set: (v: string) => {
      writes.push(v);
      if (set) set.call(style, v);
      else style.setProperty('transform', v);
    },
  });
  return { el, cell, writes };
}

const ev = (el: HTMLElement, o: Partial<{ pointerType: string; isPrimary: boolean; pointerId: number; clientX: number; clientY: number }>): Ev =>
  ({ pointerType: 'touch', isPrimary: true, pointerId: 1, button: 0, clientX: 0, clientY: 0, currentTarget: el, ...o }) as unknown as Ev;
const click = (el: Element): boolean => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));

describe('useSwipePager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('data-rm');
    document.body.replaceChildren();
  });

  function setup(turns = true) {
    const onPage = vi.fn((_dir: -1 | 1) => turns);
    let renders = 0;
    const h = renderHook(() => {
      renders++;
      return useSwipePager(onPage);
    });
    const p = makePager();
    h.result.current.bind.ref.current = p.el;
    const b = (): Bind => h.result.current.bind;
    return { onPage, h, b, ...p, renders: () => renders };
  }

  it('横滑跟手只写 transform、不重画；锁成横滑后抓住指针；松手够了翻下一页，新的一页从右边（拖出的那一侧）带过渡滑回 0', () => {
    const { onPage, b, el, writes, renders } = setup();
    act(() => b().onPointerDown(ev(el, { clientX: 200, clientY: 100 })));
    const before = renders();
    for (const x of [190, 180, 170]) act(() => b().onPointerMove(ev(el, { clientX: x, clientY: 102 })));
    expect(renders() - before, '跟手不让用它的页面重画').toBe(0);
    expect(el.setPointerCapture).toHaveBeenCalledWith(1);
    expect(el.style.transform).toBe('translateX(-30px)');
    expect(el.dataset['snap']).toBeUndefined();
    act(() => b().onPointerUp(ev(el, { clientX: 120, clientY: 104 })));
    expect(onPage).toHaveBeenCalledWith(1);
    expect(writes.at(-2)).toBe(`translateX(${390 - 80}px)`);
    expect(el.style.transform).toBe('');
    expect(el.dataset['snap']).toBe('');
  });

  it('翻不动（onPage 返回 false，到了范围边上）：按“不够”滑回原位，不从右边整页滑进来', () => {
    const { onPage, b, el, writes } = setup(false);
    act(() => b().onPointerDown(ev(el, { clientX: 200, clientY: 100 })));
    act(() => b().onPointerMove(ev(el, { clientX: 150, clientY: 100 })));
    act(() => b().onPointerUp(ev(el, { clientX: 100, clientY: 100 })));
    expect(onPage).toHaveBeenCalledWith(1);
    expect(writes.filter((w) => /translateX\(\d/.test(w)), '没有往右边放过').toEqual([]);
    expect(el.style.transform).toBe('');
    expect(el.dataset['snap']).toBe('');
  });

  it('先竖着动：锁成竖滑，之后再横移也不翻、不跟手', () => {
    const { onPage, b, el } = setup();
    act(() => b().onPointerDown(ev(el, { clientX: 200, clientY: 100 })));
    act(() => b().onPointerMove(ev(el, { clientX: 202, clientY: 130 })));
    act(() => b().onPointerMove(ev(el, { clientX: 100, clientY: 130 })));
    expect(el.style.transform).toBe('');
    act(() => b().onPointerUp(ev(el, { clientX: 100, clientY: 130 })));
    expect(onPage).not.toHaveBeenCalled();
  });

  it('pointerId 不一致不算；鼠标不算（电脑上用按钮和键盘翻）；左边缘起手不算', () => {
    const { onPage, b, el } = setup();
    act(() => b().onPointerDown(ev(el, { clientX: 200 })));
    act(() => b().onPointerUp(ev(el, { pointerId: 2, clientX: 100 })));
    act(() => b().onPointerDown(ev(el, { pointerType: 'mouse', clientX: 200 })));
    act(() => b().onPointerUp(ev(el, { pointerType: 'mouse', clientX: 50 })));
    act(() => b().onPointerDown(ev(el, { clientX: 10 })));
    act(() => b().onPointerUp(ev(el, { clientX: 200 })));
    expect(onPage).not.toHaveBeenCalled();
  });

  it('cancel：丢掉这一下，滑回原位', () => {
    const { onPage, b, el } = setup();
    act(() => b().onPointerDown(ev(el, { clientX: 200 })));
    act(() => b().onPointerMove(ev(el, { clientX: 150 })));
    act(() => b().onPointerCancel(ev(el, { clientX: 150 })));
    expect(el.style.transform).toBe('');
    act(() => b().onPointerUp(ev(el, { clientX: 50 })));
    expect(onPage).not.toHaveBeenCalled();
  });

  it('滑过以后紧跟的那次 click 被吞掉（不会翻页的同时点中格子）；下一次正常；没等到 click 又按下了，这一次的 click 是真点', () => {
    const { b, el, cell } = setup();
    act(() => b().onPointerDown(ev(el, { clientX: 200 })));
    act(() => b().onPointerMove(ev(el, { clientX: 120 })));
    act(() => b().onPointerUp(ev(el, { clientX: 120 })));
    expect(click(cell)).toBe(false);
    expect(click(cell)).toBe(true);
    act(() => b().onPointerDown(ev(el, { clientX: 200 })));
    act(() => b().onPointerMove(ev(el, { clientX: 120 })));
    act(() => b().onPointerUp(ev(el, { clientX: 120 })));
    cell.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(click(cell)).toBe(true);
  });

  it('减少动态效果：不跟手，松手直接翻，不放到旁边', () => {
    document.documentElement.setAttribute('data-rm', '1');
    const { onPage, b, el, writes } = setup();
    act(() => b().onPointerDown(ev(el, { clientX: 200 })));
    act(() => b().onPointerMove(ev(el, { clientX: 120 })));
    expect(el.style.transform).toBe('');
    act(() => b().onPointerUp(ev(el, { clientX: 120 })));
    expect(onPage).toHaveBeenCalledWith(1);
    expect(writes.every((w) => w === '')).toBe(true);
  });

  it('按钮翻页 slideIn：新的一页先放到那一侧（不带过渡）、再带过渡滑到 0；减少动态效果时什么都不做', () => {
    const { h, el, writes } = setup();
    act(() => h.result.current.slideIn(-1));
    expect(writes).toEqual(['translateX(-390px)', '']);
    expect(el.dataset['snap']).toBe('');
    writes.length = 0;
    document.documentElement.setAttribute('data-rm', '1');
    h.rerender();
    act(() => h.result.current.slideIn(1));
    expect(writes).toEqual([]);
  });
});
