// 左右滑动翻页（B2 FA-3，架构 5.12 第 3 点）：先竖着动交给滚动、左边缘 20 px 让给系统返回手势、松手横移 60 px 才翻；
// 跟手、松手滑到位；hook 的状态机直接调四个处理函数测（代码审查 L8）
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDGE_PX, enterOffset, inEdge, lockOf, swipeResult, TRIGGER_PX, useSwipePager } from '../swipe-pager.ts';

describe('swipe-pager 判断', () => {
  it('数字照架构 5.12：左边缘 20 px、横移 60 px', () => {
    expect(EDGE_PX).toBe(20);
    expect(TRIGGER_PX).toBe(60);
  });

  it('动得太少不锁；横向大于竖向才算横滑，否则算竖滑（交给滚动）', () => {
    expect(lockOf(5, 3)).toBe('none');
    expect(lockOf(30, 10)).toBe('x');
    expect(lockOf(-30, 10)).toBe('x');
    expect(lockOf(15, 12)).toBe('x');
    expect(lockOf(12, 15)).toBe('y');
    expect(lockOf(2, 20)).toBe('y');
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

type Ev = Parameters<ReturnType<typeof useSwipePager>['onPointerDown']>[0];
/** 挂着手势的那一块：真元素（滑过之后吞 click 只吞落在它里面的），宽 390 */
const pager = document.createElement('div');
pager.getBoundingClientRect = () => ({ width: 390 }) as DOMRect;
const cell = document.createElement('button');
pager.append(cell);
document.body.append(pager);
const ev = (o: Partial<{ pointerType: string; isPrimary: boolean; pointerId: number; clientX: number; clientY: number }>): Ev =>
  ({ pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 0, clientY: 0, currentTarget: pager, ...o }) as unknown as Ev;

describe('useSwipePager 状态机', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('data-rm');
  });

  function setup() {
    const onPage = vi.fn();
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((f: FrameRequestCallback) => {
      f(0);
      return 1;
    });
    const h = renderHook(() => useSwipePager(onPage));
    return { onPage, raf, h };
  }

  it('横滑跟手，松手够了翻下一页，然后从右边滑回 0（带过渡）', () => {
    const { onPage, h } = setup();
    act(() => h.result.current.onPointerDown(ev({ clientX: 200, clientY: 100 })));
    act(() => h.result.current.onPointerMove(ev({ clientX: 170, clientY: 102 })));
    expect(h.result.current.offset).toBe(-30);
    expect(h.result.current.settling).toBe(false);
    act(() => h.result.current.onPointerUp(ev({ clientX: 120, clientY: 104 })));
    expect(onPage).toHaveBeenCalledWith(1);
    expect(h.result.current.offset).toBe(0);
    expect(h.result.current.settling).toBe(true);
  });

  it('先竖着动：锁成竖滑，之后再横移也不翻、不跟手', () => {
    const { onPage, h } = setup();
    act(() => h.result.current.onPointerDown(ev({ clientX: 200, clientY: 100 })));
    act(() => h.result.current.onPointerMove(ev({ clientX: 202, clientY: 130 })));
    act(() => h.result.current.onPointerMove(ev({ clientX: 100, clientY: 130 })));
    expect(h.result.current.offset).toBe(0);
    act(() => h.result.current.onPointerUp(ev({ clientX: 100, clientY: 130 })));
    expect(onPage).not.toHaveBeenCalled();
  });

  it('pointerId 不一致不算；鼠标不算；左边缘起手不算', () => {
    const { onPage, h } = setup();
    act(() => h.result.current.onPointerDown(ev({ clientX: 200 })));
    act(() => h.result.current.onPointerUp(ev({ pointerId: 2, clientX: 100 })));
    act(() => h.result.current.onPointerDown(ev({ pointerType: 'mouse', clientX: 200 })));
    act(() => h.result.current.onPointerUp(ev({ pointerType: 'mouse', clientX: 50 })));
    act(() => h.result.current.onPointerDown(ev({ clientX: 10 })));
    act(() => h.result.current.onPointerUp(ev({ clientX: 200 })));
    expect(onPage).not.toHaveBeenCalled();
  });

  it('cancel：丢掉这一下，滑回原位', () => {
    const { onPage, h } = setup();
    act(() => h.result.current.onPointerDown(ev({ clientX: 200 })));
    act(() => h.result.current.onPointerMove(ev({ clientX: 150 })));
    act(() => h.result.current.onPointerCancel());
    expect(h.result.current.offset).toBe(0);
    act(() => h.result.current.onPointerUp(ev({ clientX: 50 })));
    expect(onPage).not.toHaveBeenCalled();
  });

  it('滑过以后紧跟的那次 click 被吞掉（不会翻页的同时点中格子）；下一次正常', () => {
    const { h } = setup();
    act(() => h.result.current.onPointerDown(ev({ clientX: 200 })));
    act(() => h.result.current.onPointerMove(ev({ clientX: 120 })));
    act(() => h.result.current.onPointerUp(ev({ clientX: 120 })));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    cell.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    const click2 = new MouseEvent('click', { bubbles: true, cancelable: true });
    cell.dispatchEvent(click2);
    expect(click2.defaultPrevented).toBe(false);
  });

  it('滑过以后没等到 click、又按下了：这一次的 click 是真点（不再吞）', () => {
    const { h } = setup();
    act(() => h.result.current.onPointerDown(ev({ clientX: 200 })));
    act(() => h.result.current.onPointerMove(ev({ clientX: 120 })));
    act(() => h.result.current.onPointerUp(ev({ clientX: 120 })));
    cell.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    cell.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it('减少动态效果：不跟手，松手直接翻', () => {
    document.documentElement.setAttribute('data-rm', '1');
    const { onPage, h } = setup();
    act(() => h.result.current.onPointerDown(ev({ clientX: 200 })));
    act(() => h.result.current.onPointerMove(ev({ clientX: 120 })));
    expect(h.result.current.offset).toBe(0);
    act(() => h.result.current.onPointerUp(ev({ clientX: 120 })));
    expect(onPage).toHaveBeenCalledWith(1);
    expect(h.result.current.offset).toBe(0);
  });
});
