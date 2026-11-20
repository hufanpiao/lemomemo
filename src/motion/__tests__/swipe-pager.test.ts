// 左右滑动翻页（B2 FA-3，架构 5.12 第 3 点；R-457 原地淡换）：先竖着动交给滚动、左边缘 20 px 让给系统返回手势、松手横移 60 px 才翻；
// 跟手只写 DOM 的 transform（不让页面重画，R-420 审查第 3 条），只走一小段（followX）；翻成了原地淡换（flip 拍副本淡出），翻不动（onPage 返回 false）带过渡回原位（第 1 条）。
// 锁方向、避让、跟手、吞点按在 hdrag.ts（和 kit 左滑行共用）；这里直接调 bind 上的四个处理函数测
// 真浏览器里的淡换（副本叠在原位淡出、新的一页淡入）由 e2e 在 chromium、webkit 上看
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDGE_PX, inEdge, lockOf } from '../hdrag.ts';
import { dur, TAP_SLOP_PX } from '../tokens.ts';
import { flipMs, FOLLOW_MAX_PX, followX, swipeResult, TRIGGER_PX, useSwipePager } from '../swipe-pager.ts';

describe('swipe-pager 判断', () => {
  it('数字照架构 5.12：左边缘 20 px、横移 60 px；起滑距离 10 px（和左滑行同一个）', () => {
    expect(EDGE_PX).toBe(20);
    expect(TRIGGER_PX).toBe(60);
    expect(TAP_SLOP_PX).toBe(10);
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

  it('跟手只走一小段：手指横移的 0.15 倍、最多 16 px（R-457 方案 C）', () => {
    expect(followX(-30)).toBeCloseTo(-4.5);
    expect(followX(40)).toBeCloseTo(6);
    expect(followX(-500)).toBe(-FOLLOW_MAX_PX);
    expect(followX(500)).toBe(FOLLOW_MAX_PX);
  });

  it('翻页时长：--dur-ui 的 4 倍（负责人原话“放慢4倍”）；减少动态效果时只留 --dur-ui', () => {
    expect(flipMs(false)).toBeCloseTo(dur.ui * 4000);
    expect(flipMs(true)).toBeCloseTo(dur.ui * 1000);
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
    Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  });

  function setup(turns = true) {
    const onPage = vi.fn((_dir: -1 | 1, _via: 'swipe' | 'btn') => turns);
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

  it('横滑跟手只写 transform、不重画、只走一小段；锁成横滑后抓住指针；松手够了翻下一页，直接回到 0（不再整页滑进来）', () => {
    const { onPage, b, el, writes, renders } = setup();
    act(() => b().onPointerDown(ev(el, { clientX: 200, clientY: 100 })));
    const before = renders();
    for (const x of [190, 180, 170]) act(() => b().onPointerMove(ev(el, { clientX: x, clientY: 102 })));
    expect(renders() - before, '跟手不让用它的页面重画').toBe(0);
    expect(el.setPointerCapture).toHaveBeenCalledWith(1);
    expect(el.style.transform).toBe('translateX(-4.5px)');
    expect(el.dataset['snap']).toBeUndefined();
    act(() => b().onPointerUp(ev(el, { clientX: 120, clientY: 104 })));
    expect(onPage).toHaveBeenCalledWith(1, 'swipe');
    expect(writes.filter((w) => Math.abs(parseFloat(w.slice(11)) || 0) > FOLLOW_MAX_PX), '没有整页位移').toEqual([]);
    expect(el.style.transform).toBe('');
    expect(el.dataset['snap']).toBeUndefined();
  });

  it('翻不动（onPage 返回 false，到了范围边上）：按“不够”滑回原位，不从右边整页滑进来', () => {
    const { onPage, b, el, writes } = setup(false);
    act(() => b().onPointerDown(ev(el, { clientX: 200, clientY: 100 })));
    act(() => b().onPointerMove(ev(el, { clientX: 150, clientY: 100 })));
    act(() => b().onPointerUp(ev(el, { clientX: 100, clientY: 100 })));
    expect(onPage).toHaveBeenCalledWith(1, 'swipe');
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
    expect(onPage).toHaveBeenCalledWith(1, 'swipe');
    expect(writes.every((w) => w === '')).toBe(true);
  });

  it('按钮翻页 flip：拍一份副本叠在原位（去掉测试标记、aria-hidden、inert）、新的一页淡入；翻不动时副本收掉', () => {
    const { h, el, onPage } = setup();
    el.dataset['testid'] = 'cal-grid';
    const anims: { kf: Keyframe[]; o: KeyframeAnimationOptions }[] = [];
    const fake = (kf: Keyframe[], o: KeyframeAnimationOptions) => {
      anims.push({ kf, o });
      return { cancel: vi.fn(), finished: new Promise(() => undefined) } as unknown as Animation;
    };
    HTMLElement.prototype.animate = fake as unknown as HTMLElement['animate'];
    let ok = false;
    act(() => {
      ok = h.result.current.flip(-1, 'btn');
    });
    expect(ok).toBe(true);
    expect(onPage).toHaveBeenCalledWith(-1, 'btn');
    const ghost = el.previousElementSibling as HTMLElement;
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.inert).toBe(true);
    expect(ghost.dataset['testid']).toBeUndefined();
    expect(anims.map((a) => a.o.duration)).toEqual([flipMs(false), flipMs(false)]);
    expect(anims[0]?.kf.at(-1)?.opacity).toBe(0);
    expect(anims[1]?.kf.at(-1)?.opacity).toBe(1);
    // 减少动态效果：只淡入淡出、--dur-ui，不模糊
    document.documentElement.setAttribute('data-rm', '1');
    h.rerender();
    anims.length = 0;
    act(() => void h.result.current.flip(1, 'btn'));
    expect(document.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
    expect(anims.map((a) => a.o.duration)).toEqual([flipMs(true), flipMs(true)]);
    expect(anims.every((a) => a.kf.every((k) => k.filter === undefined))).toBe(true);
  });

  it('flip 翻不动（onPage 返回 false）：副本收掉，画面不动', () => {
    const { h, el } = setup(false);
    HTMLElement.prototype.animate = vi.fn() as unknown as HTMLElement['animate'];
    let ok = true;
    act(() => {
      ok = h.result.current.flip(1, 'btn');
    });
    expect(ok).toBe(false);
    expect(el.previousElementSibling?.getAttribute('aria-hidden') ?? null, '没留下副本').toBeNull();
    expect(HTMLElement.prototype.animate).not.toHaveBeenCalled();
  });
});
