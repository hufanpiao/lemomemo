// 下拉露出搜索框的手势（R-437；kit/hooks/usePullReveal.ts）：滚到顶往下拉过阈值才露出；横着拉、不在顶上、按在 data-nopull 里、页面外都不算；
// 滚轮在顶上继续往上滚也能露出（刚滚到顶的惯性不算）；露出后一直留着直到 close
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PULL_OPEN_PX, SETTLE_MS, usePullReveal, WHEEL_OPEN_PX } from '../usePullReveal.ts';

const fx = vi.hoisted(() => ({ logs: [] as string[] }));
vi.mock('../../../platform/run-log-api.ts', async (orig) => ({ ...(await orig<object>()), rlog: (l: string) => fx.logs.push(l) }));

function Host({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const pull = usePullReveal(ref, 'notes', enabled);
  return (
    <>
      <main ref={ref}>
        <p data-testid="in">list</p>
        <button type="button" data-nopull="" data-testid="handle">handle</button>
        <span data-testid="state">{pull.open ? 'open' : 'closed'}</span>
        <button type="button" data-testid="close" onClick={pull.close}>close</button>
      </main>
      <div data-testid="out">outside</div>
    </>
  );
}

const state = () => screen.getByTestId('state').textContent;
let scrollY = 0;
function drag(el: HTMLElement, dx: number, dy: number) {
  fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 100 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: 100 + dx / 2, clientY: 100 + dy / 2 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: 100 + dx, clientY: 100 + dy }] });
  fireEvent.touchEnd(el, { touches: [] });
}

beforeEach(() => {
  scrollY = 0;
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
  fx.logs.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('usePullReveal', () => {
  it('在顶上往下拉过阈值才露出，只记一次日志；露出后一直留着，close 才收起', () => {
    render(<Host />);
    drag(screen.getByTestId('in'), 0, PULL_OPEN_PX - 4);
    expect(state()).toBe('closed');
    drag(screen.getByTestId('in'), 0, PULL_OPEN_PX + 4);
    expect(state()).toBe('open');
    drag(screen.getByTestId('in'), 0, PULL_OPEN_PX + 4);
    expect(fx.logs).toEqual(['pull open notes via=touch']);
    fireEvent.click(screen.getByTestId('close'));
    expect(state()).toBe('closed');
    expect(fx.logs).toEqual(['pull open notes via=touch', 'pull close notes']);
  });

  it('横着拉（左右滑翻页、左滑行）、不在顶上、按在 data-nopull 里、按在页面外、关掉的都不露出', () => {
    const { unmount } = render(<Host />);
    drag(screen.getByTestId('in'), 120, PULL_OPEN_PX + 10);
    drag(screen.getByTestId('handle'), 0, 200);
    drag(screen.getByTestId('out'), 0, 200);
    scrollY = 40;
    drag(screen.getByTestId('in'), 0, 200);
    expect(state()).toBe('closed');
    unmount();
    scrollY = 0;
    render(<Host enabled={false} />);
    drag(screen.getByTestId('in'), 0, 200);
    expect(state()).toBe('closed');
    expect(fx.logs).toEqual([]);
  });

  it('滚轮：在顶上继续往上滚累计过阈值露出；刚滚到顶的惯性不算', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    render(<Host />);
    const el = screen.getByTestId('in');
    // 从下面滚上来：刚到顶
    scrollY = 300;
    act(() => void window.dispatchEvent(new Event('scroll')));
    scrollY = 0;
    act(() => void window.dispatchEvent(new Event('scroll')));
    fireEvent.wheel(el, { deltaY: -WHEEL_OPEN_PX * 2 });
    expect(state()).toBe('closed');
    now += SETTLE_MS + 10;
    fireEvent.wheel(el, { deltaY: -WHEEL_OPEN_PX / 2 });
    now += 20;
    fireEvent.wheel(el, { deltaY: 40 });
    now += 20;
    fireEvent.wheel(el, { deltaY: -WHEEL_OPEN_PX / 2 });
    expect(state()).toBe('closed');
    now += 20;
    fireEvent.wheel(el, { deltaY: -WHEEL_OPEN_PX / 2 - 1 });
    expect(state()).toBe('open');
    expect(fx.logs).toEqual(['pull open notes via=wheel']);
  });
});
