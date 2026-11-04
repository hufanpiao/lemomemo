// 上下拖动收起（drag-collapse.ts；月历上拖收起，线框 s3、架构 17.2、R-326）：纯函数 + hook
// 跟手、松手按位置 / 速度吸附、可中断、横向先动的不算、左边 20 px 不接、减少动态效果直接切换、键盘 toggle
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bezierAt, dragProgress, FLICK_PX_PER_MS, SNAP_FRAC, snapTarget, useDragCollapse } from '../drag-collapse.ts';
import { ease } from '../tokens.ts';

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.rm;
});

const ptr = (y: number, timeStamp: number, x = 100) => ({ pointerId: 1, isPrimary: true, clientX: x, clientY: y, timeStamp });

describe('纯函数', () => {
  it('dragProgress：往上拖（dy 为负）变大，夹在 0～1；range 不是正数时不动', () => {
    expect(dragProgress(0, -50, 200)).toBe(0.25);
    expect(dragProgress(0, -400, 200)).toBe(1);
    expect(dragProgress(1, 100, 200)).toBe(0.5);
    expect(dragProgress(0, 30, 200)).toBe(0);
    expect(dragProgress(0.3, -50, 0)).toBe(0.3);
  });

  it('snapTarget：甩得够快按方向，否则过半收起、不过半弹回', () => {
    expect(snapTarget(0.1, -FLICK_PX_PER_MS)).toBe(1);
    expect(snapTarget(0.9, FLICK_PX_PER_MS)).toBe(0);
    expect(snapTarget(SNAP_FRAC, 0)).toBe(1);
    expect(snapTarget(SNAP_FRAC - 0.01, 0.1)).toBe(0);
  });

  it('bezierAt：两端 0、1，中间单调；ease.out 前快后慢', () => {
    expect(bezierAt(ease.out, 0)).toBe(0);
    expect(bezierAt(ease.out, 1)).toBe(1);
    expect(bezierAt(ease.out, 0.5)).toBeGreaterThan(0.8);
    expect(bezierAt(ease.out, 0.25)).toBeLessThan(bezierAt(ease.out, 0.5));
  });
});

describe('useDragCollapse', () => {
  it('跟手：往上拖一半进度 0.5；慢慢松手过半 → 收起，回调 true，补间到 1', async () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useDragCollapse(false, onChange, () => 200));
    act(() => result.current.onPointerDown(ptr(300, 0)));
    act(() => result.current.onPointerMove(ptr(280, 100)));
    act(() => result.current.onPointerMove(ptr(200, 2000)));
    expect(result.current.progress).toBe(0.5);
    act(() => result.current.onPointerUp(ptr(195, 2100)));
    expect(onChange).toHaveBeenCalledWith(true);
    await waitFor(() => expect(result.current.progress).toBe(1));
    expect(result.current.moving).toBe(false);
  });

  it('拖得不到一半、慢慢松手：弹回展开，不调回调', async () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useDragCollapse(false, onChange, () => 200));
    act(() => result.current.onPointerDown(ptr(300, 0)));
    act(() => result.current.onPointerMove(ptr(260, 1000)));
    act(() => result.current.onPointerUp(ptr(260, 2000)));
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.progress).toBe(0));
  });

  it('往上一甩（速度够快）：没过半也收起', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useDragCollapse(false, onChange, () => 400));
    act(() => result.current.onPointerDown(ptr(300, 0)));
    act(() => result.current.onPointerMove(ptr(288, 10)));
    act(() => result.current.onPointerMove(ptr(260, 20)));
    act(() => result.current.onPointerUp(ptr(258, 22)));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('横向先动的不算（让给左右翻页）；从屏幕左边 20 px 起手的不接（让给系统返回）', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useDragCollapse(false, onChange, () => 200));
    act(() => result.current.onPointerDown(ptr(300, 0, 100)));
    act(() => result.current.onPointerMove(ptr(298, 10, 140)));
    act(() => result.current.onPointerMove(ptr(100, 20, 150)));
    expect(result.current.progress).toBe(0);
    act(() => result.current.onPointerUp(ptr(100, 30, 150)));
    expect(onChange).not.toHaveBeenCalled();

    act(() => result.current.onPointerDown(ptr(300, 0, 10)));
    act(() => result.current.onPointerMove(ptr(100, 20, 10)));
    act(() => result.current.onPointerUp(ptr(100, 30, 10)));
    expect(result.current.progress).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('可中断：补间途中再按住，从当前进度接着拖', async () => {
    let collapsed = false;
    const { result, rerender } = renderHook(() => useDragCollapse(collapsed, () => undefined, () => 200));
    collapsed = true;
    rerender();
    await waitFor(() => expect(result.current.progress).toBeGreaterThan(0));
    act(() => result.current.onPointerDown(ptr(300, 0)));
    const from = result.current.progress;
    expect(from).toBeLessThan(1);
    act(() => result.current.onPointerMove(ptr(320, 10)));
    act(() => result.current.onPointerMove(ptr(320, 400)));
    expect(result.current.progress).toBeCloseTo(Math.max(0, from - 0.1), 5);
  });

  it('拖过以后那一下点击被吞掉（免得又当成点了按钮切换）', () => {
    const { result } = renderHook(() => useDragCollapse(false, () => undefined, () => 200));
    act(() => result.current.onPointerDown(ptr(300, 0)));
    act(() => result.current.onPointerMove(ptr(250, 1000)));
    act(() => result.current.onPointerUp(ptr(250, 2000)));
    const e = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent<HTMLElement>;
    result.current.onClickCapture(e);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('键盘、读屏、点按：toggle 调回调（取反）', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useDragCollapse(true, onChange, () => 200));
    act(() => result.current.toggle());
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('减少动态效果：拖的时候不跟手，状态变了直接到位、没有补间', () => {
    document.documentElement.dataset.rm = '1';
    let collapsed = false;
    const onChange = vi.fn((v: boolean) => {
      collapsed = v;
    });
    const { result, rerender } = renderHook(() => useDragCollapse(collapsed, onChange, () => 200));
    act(() => result.current.onPointerDown(ptr(300, 0)));
    act(() => result.current.onPointerMove(ptr(150, 2000)));
    expect(result.current.progress).toBe(0);
    act(() => result.current.onPointerUp(ptr(150, 3000)));
    expect(onChange).toHaveBeenCalledWith(true);
    rerender();
    expect(result.current.progress).toBe(1);
    expect(result.current.moving).toBe(false);
  });

  it('补间途中按住又被取消、或按住没拖就松手：回到页面记的状态，不按按下时的进度吸附（代码复审 R1）', () => {
    let now = 0;
    const q: FrameRequestCallback[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => q.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => q.splice(0));
    const run = (at: number) => act(() => {
      now = at;
      for (let n = 0; q.length > 0 && n < 50; n++) q.shift()?.(now);
    });
    let collapsed = false;
    const onChange = vi.fn();
    const { result, rerender } = renderHook(() => useDragCollapse(collapsed, onChange, () => 200));
    collapsed = true;
    rerender();
    act(() => {
      now = 10;
      q.shift()?.(now);
    });
    expect(result.current.progress).toBeGreaterThan(0);
    expect(result.current.progress).toBeLessThan(0.5);
    act(() => result.current.onPointerDown(ptr(300, 20)));
    act(() => result.current.onPointerCancel());
    run(10_000);
    expect(result.current.progress).toBe(1);
    // 再来一次：状态改回展开、补间走一点（进度过半）时按住没拖就松手 → 回到 0
    collapsed = false;
    rerender();
    act(() => {
      now = 10_010;
      q.shift()?.(now);
    });
    expect(result.current.progress).toBeGreaterThan(0.5);
    act(() => result.current.onPointerDown(ptr(300, 30)));
    act(() => result.current.onPointerUp(ptr(300, 40)));
    run(20_000);
    expect(result.current.progress).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
