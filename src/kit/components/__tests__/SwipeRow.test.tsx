// SwipeRow：左滑露出操作的列表行（kit）。jsdom 量不出宽度：操作区宽度用 offsetWidth 桩成 144；
// 真浏览器里的手势（含竖着滚列表不误触发）由 tests/e2e/b5-anniv.spec.ts 在 chromium、webkit 上跑
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SwipeRow } from '../SwipeRow.tsx';

afterEach(cleanup);

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(144);
  // jsdom 没有指针捕获
  HTMLElement.prototype.setPointerCapture = () => undefined;
});

function row(id: string, onEdit = vi.fn(), onDel = vi.fn(), onOpen = vi.fn()) {
  return (
    <SwipeRow
      data-testid={id}
      actions={[
        { key: 'edit', label: '编辑', onClick: onEdit, testId: `${id}-edit` },
        { key: 'del', label: '删除', danger: true, onClick: onDel, testId: `${id}-del` },
      ]}
    >
      <button type="button" onClick={onOpen} data-testid={`${id}-main`}>
        行
      </button>
    </SwipeRow>
  );
}

const face = (id: string): HTMLElement => screen.getByTestId(`${id}-main`).parentElement as HTMLElement;

function swipe(el: HTMLElement, dx: number, dy = 0): void {
  fireEvent.pointerDown(el, { pointerId: 1, isPrimary: true, clientX: 200, clientY: 20, button: 0, pointerType: 'touch' });
  fireEvent.pointerMove(el, { pointerId: 1, isPrimary: true, clientX: 200 + dx / 2, clientY: 20 + dy / 2, pointerType: 'touch' });
  fireEvent.pointerMove(el, { pointerId: 1, isPrimary: true, clientX: 200 + dx, clientY: 20 + dy, pointerType: 'touch' });
  fireEvent.pointerUp(el, { pointerId: 1, isPrimary: true, clientX: 200 + dx, clientY: 20 + dy, pointerType: 'touch' });
}

describe('SwipeRow', () => {
  it('收着时操作按钮 inert、读屏读不到；左滑过一半停在露出，按钮可点', () => {
    const onDel = vi.fn();
    render(row('a', vi.fn(), onDel));
    const acts = screen.getByTestId('a-del').parentElement as HTMLElement;
    expect(acts.hasAttribute('inert')).toBe(true);
    expect(acts.getAttribute('aria-hidden')).toBe('true');
    swipe(face('a'), -100);
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBe('open');
    expect(face('a').style.transform).toBe('translateX(-144px)');
    expect(acts.hasAttribute('inert')).toBe(false);
    fireEvent.click(screen.getByTestId('a-del'));
    expect(onDel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBeNull();
  });

  it('没拉过一半收回；滑完紧跟的 click 吞掉、不进编辑', () => {
    const onOpen = vi.fn();
    render(row('a', vi.fn(), vi.fn(), onOpen));
    swipe(face('a'), -40);
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBeNull();
    expect(face('a').style.transform).toBe('');
    fireEvent.click(screen.getByTestId('a-main'));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('竖着走得多（滚列表）：不滑、不吞点击', () => {
    const onOpen = vi.fn();
    render(row('a', vi.fn(), vi.fn(), onOpen));
    swipe(face('a'), -30, 80);
    expect(face('a').style.transform).toBe('');
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBeNull();
    fireEvent.click(screen.getByTestId('a-main'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('一次只露一行；点别处、按 Esc 收起；点露着那行的行面只收起、不进编辑', () => {
    const onOpen = vi.fn();
    render(
      <>
        {row('a', vi.fn(), vi.fn(), onOpen)}
        {row('b')}
      </>,
    );
    swipe(face('a'), -100);
    swipe(face('b'), -100);
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBeNull();
    expect(screen.getByTestId('b').getAttribute('data-swipe')).toBe('open');
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.getByTestId('b').getAttribute('data-swipe')).toBeNull();
    swipe(face('a'), -100);
    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBeNull();
    swipe(face('a'), -100);
    fireEvent.pointerDown(screen.getByTestId('a-main'), { pointerId: 2, isPrimary: true, button: 0 });
    fireEvent.click(screen.getByTestId('a-main'));
    expect(screen.getByTestId('a').getAttribute('data-swipe')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('disabled（只读行）：滑不动', () => {
    render(
      <SwipeRow data-testid="r" disabled actions={[{ key: 'x', label: 'x', onClick: vi.fn() }]}>
        <span data-testid="r-main">行</span>
      </SwipeRow>,
    );
    swipe(face('r'), -100);
    expect(screen.getByTestId('r').getAttribute('data-swipe')).toBeNull();
  });
});
