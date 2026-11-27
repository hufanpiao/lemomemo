// 看图页缩放（hooks/useZoomPan.ts）：倍数和边界的算法；捏合、拖动、双击，以及放大时不换张、1 倍时照常换张
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampView, useZoomPan, zoomAround, type ZoomBox } from '../hooks/useZoomPan.ts';

const BOX: ZoomBox = { vw: 400, vh: 600, iw: 400, ih: 300 };

describe('缩放算法', () => {
  it('倍数夹在 1～4', () => {
    expect(clampView({ s: 0.5, x: 0, y: 0 }, BOX).s).toBe(1);
    expect(clampView({ s: 9, x: 0, y: 0 }, BOX).s).toBe(4);
  });
  it('拖不出图片边界；图比取景框小的方向保持居中', () => {
    expect(clampView({ s: 2, x: 999, y: 999 }, BOX)).toEqual({ s: 2, x: 200, y: 0 });
    expect(clampView({ s: 4, x: -9999, y: -9999 }, BOX)).toEqual({ s: 4, x: -600, y: -300 });
  });
  it('以两指中点为中心：中点下面那一点缩放后还在原位', () => {
    const at = { x: 100, y: 50 };
    const v = zoomAround({ s: 1, x: 0, y: 0 }, 2, at, { ...BOX, ih: 500 });
    expect(v).toEqual({ s: 2, x: -100, y: -50 });
    expect((at.x - v.x) / v.s).toBe(at.x);
  });
});

function Stage({ onSwipe }: { onSwipe: (d: 1 | -1) => void }) {
  const z = useZoomPan('a', onSwipe);
  return (
    <div data-testid="stage" onPointerDown={z.onPointerDown} onPointerMove={z.onPointerMove} onPointerUp={z.onPointerUp} onPointerCancel={z.onPointerCancel}>
      <div ref={z.frame}>
        <div ref={z.layer} data-testid="layer">
          <img alt="" />
        </div>
      </div>
    </div>
  );
}

function setup() {
  const onSwipe = vi.fn();
  render(<Stage onSwipe={onSwipe} />);
  const img = document.querySelector('img') as HTMLImageElement;
  Object.defineProperty(img, 'offsetWidth', { value: 400 });
  Object.defineProperty(img, 'offsetHeight', { value: 300 });
  const frame = screen.getByTestId('layer').parentElement as HTMLElement;
  Object.defineProperty(frame, 'clientWidth', { value: 400 });
  Object.defineProperty(frame, 'clientHeight', { value: 600 });
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
  const stage = screen.getByTestId('stage');
  const ev = (pointerId: number, clientX: number, clientY: number, isPrimary = pointerId === 1) => ({ pointerId, clientX, clientY, isPrimary, button: 0 });
  const pinch = () => {
    fireEvent.pointerDown(stage, ev(1, 150, 300));
    fireEvent.pointerDown(stage, ev(2, 250, 300));
    fireEvent.pointerMove(stage, ev(1, 100, 300));
    fireEvent.pointerMove(stage, ev(2, 300, 300));
    fireEvent.pointerUp(stage, ev(2, 300, 300));
    fireEvent.pointerUp(stage, ev(1, 100, 300));
  };
  return { onSwipe, stage, ev, pinch, layer: screen.getByTestId('layer') };
}

describe('useZoomPan 手势', () => {
  afterEach(cleanup);

  it('捏合放大；放大时横滑只拖图、不换张，且拖不出边界', () => {
    const { onSwipe, stage, ev, pinch, layer } = setup();
    pinch();
    expect(layer.style.transform).toBe('translate(0px, 0px) scale(2)');
    fireEvent.pointerDown(stage, ev(1, 200, 300));
    fireEvent.pointerMove(stage, ev(1, 900, 300));
    fireEvent.pointerUp(stage, ev(1, 900, 300));
    expect(layer.style.transform).toBe('translate(200px, 0px) scale(2)');
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('捏合结束不算横滑；1 倍时单指横滑照常换张', () => {
    const { onSwipe, stage, ev } = setup();
    fireEvent.pointerDown(stage, ev(1, 100, 300));
    fireEvent.pointerDown(stage, ev(2, 110, 300));
    fireEvent.pointerUp(stage, ev(2, 110, 300));
    fireEvent.pointerUp(stage, ev(1, 300, 300));
    expect(onSwipe).not.toHaveBeenCalled();
    fireEvent.pointerDown(stage, ev(1, 300, 300));
    fireEvent.pointerUp(stage, ev(1, 100, 300));
    expect(onSwipe).toHaveBeenCalledWith(1);
  });

  it('双击在 1 倍和 2.5 倍之间切换', () => {
    const { stage, ev, layer } = setup();
    const tap = () => {
      fireEvent.pointerDown(stage, ev(1, 200, 300));
      fireEvent.pointerUp(stage, ev(1, 200, 300));
    };
    tap();
    tap();
    expect(layer.style.transform).toContain('scale(2.5)');
    tap();
    tap();
    expect(layer.style.transform).toBe('');
  });
});
