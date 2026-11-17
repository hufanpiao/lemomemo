// 下拉露出搜索框（R-437；kit/hooks/usePullReveal.ts + kit/components/PullSlot.tsx）：
// • 手势：滚到顶往下拉过阈值才露出；横着拉、不在顶上、按在 data-nopull / fixed / 真能滚的元素里、页面外都不算
// • 滚轮：到顶后先断开 WHEEL_GAP_MS 才累计（惯性冲到顶的那一串不算）；按着 Ctrl、横向为主的不算
// • 键盘：“搜索本页”平时在、露出后不画，点了 via=key；收起后焦点回到它
// • 就地筛（R-447）：默认列表留着、foot 打了字才挂，shows / markQ 跟着 setFound；inPlace=false（日历）打了字列表只藏不卸
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PullSlot } from '../../components/PullSlot.tsx';
import { PULL_OPEN_PX, usePullReveal, WHEEL_GAP_MS, WHEEL_OPEN_PX } from '../usePullReveal.ts';

const fx = vi.hoisted(() => ({ logs: [] as string[] }));
vi.mock('../../../platform/run-log-api.ts', async (orig) => ({ ...(await orig<object>()), rlog: (l: string) => fx.logs.push(l) }));

/** 列表里有状态的一块：只藏不卸的话，数字留着 */
function Counter() {
  const [n, setN] = useState(0);
  return (
    <button type="button" data-testid="counter" onClick={() => setN(n + 1)}>
      {n}
    </button>
  );
}

function Host({ enabled = true, inPlace = true }: { enabled?: boolean; inPlace?: boolean }) {
  const pull = usePullReveal('notes', enabled);
  return (
    <>
      <main ref={pull.ref}>
        <PullSlot
          pull={pull}
          keyLabel="搜索本页"
          inPlace={inPlace}
          search={(part) =>
            part === 'head' ? (
              <input
                data-testid="q"
                value={pull.q}
                onChange={(e) => pull.setQ(e.target.value)}
                onKeyDown={(e) => (e.key === 'Escape' ? pull.close() : undefined)}
              />
            ) : (
              <p data-testid="foot">foot</p>
            )
          }
        >
          <p data-testid="in">list</p>
          <Counter />
          <button type="button" data-nopull="" data-testid="handle">handle</button>
          <div data-testid="drawer" style={{ position: 'fixed' }}>
            <p data-testid="in-drawer">drawer</p>
          </div>
          <div data-testid="box" style={{ overflowY: 'auto' }}>
            <p data-testid="in-box">box</p>
          </div>
        </PullSlot>
        <span data-testid="state">{pull.open ? `open ${pull.via}` : 'closed'}</span>
        <button type="button" data-testid="found" onClick={() => pull.setFound({ q: '牛', ids: new Set(['a']) })}>found</button>
        <span data-testid="shows">{`${pull.shows('a')} ${pull.shows('b')} ${pull.markQ}`}</span>
      </main>
      <div data-testid="out">outside</div>
    </>
  );
}

const state = () => screen.getByTestId('state').textContent;
let scrollY = 0;
let now = 1000;
function drag(el: HTMLElement, dx: number, dy: number) {
  fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 100 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: 100 + dx / 2, clientY: 100 + dy / 2 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: 100 + dx, clientY: 100 + dy }] });
  fireEvent.touchEnd(el, { touches: [] });
}
function wheel(el: HTMLElement, init: WheelEventInit, after = 20) {
  now += after;
  fireEvent.wheel(el, init);
}
/** jsdom 不排版：手动给框一个比内容矮的高度，让它“真能滚” */
function makeScrollable(el: HTMLElement) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 500 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 });
}

beforeEach(() => {
  scrollY = 0;
  now = 1000;
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  fx.logs.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('usePullReveal 手势', () => {
  it('在顶上往下拉过阈值才露出，只记一次日志；露出后一直留着，Esc 才收起', () => {
    render(<Host />);
    drag(screen.getByTestId('in'), 0, PULL_OPEN_PX - 4);
    expect(state()).toBe('closed');
    drag(screen.getByTestId('in'), 0, PULL_OPEN_PX + 4);
    expect(state()).toBe('open touch');
    drag(screen.getByTestId('in'), 0, PULL_OPEN_PX + 4);
    expect(fx.logs).toEqual(['pull open notes via=touch']);
    fireEvent.keyDown(screen.getByTestId('q'), { key: 'Escape' });
    expect(state()).toBe('closed');
    expect(fx.logs).toEqual(['pull open notes via=touch', 'pull close notes']);
  });

  it('横着拉、不在顶上、data-nopull、fixed 的抽屉、真能滚的框、页面外、关掉的都不露出', () => {
    const { unmount } = render(<Host />);
    makeScrollable(screen.getByTestId('box'));
    drag(screen.getByTestId('in'), 120, PULL_OPEN_PX + 10);
    drag(screen.getByTestId('handle'), 0, 200);
    drag(screen.getByTestId('in-drawer'), 0, 200);
    drag(screen.getByTestId('in-box'), 0, 200);
    drag(screen.getByTestId('out'), 0, 200);
    scrollY = 40;
    drag(screen.getByTestId('in'), 0, 200);
    expect(state()).toBe('closed');
    unmount();
    scrollY = 0;
    render(<Host enabled={false} />);
    expect(screen.queryByTestId('pull-key')).toBeNull();
    drag(screen.getByTestId('in'), 0, 200);
    expect(state()).toBe('closed');
    expect(fx.logs).toEqual([]);
  });

  it('overflow-y:auto 但内容不够高（不能滚）的框照样算页面本身', () => {
    render(<Host />);
    drag(screen.getByTestId('in-box'), 0, PULL_OPEN_PX + 4);
    expect(state()).toBe('open touch');
  });
});

describe('usePullReveal 滚轮', () => {
  it('从下面一路滚上来、惯性冲到顶的那一串不算；断开 WHEEL_GAP_MS 以后再往上滚，累计过阈值才露出', () => {
    render(<Host />);
    const el = screen.getByTestId('in');
    scrollY = 300;
    wheel(el, { deltaY: -100 });
    scrollY = 0;
    // 惯性：间隔很短，累计远超阈值也不算
    for (let i = 0; i < 10; i++) wheel(el, { deltaY: -WHEEL_OPEN_PX });
    expect(state()).toBe('closed');
    // 断开以后：先滚一半、往下滚一下清零、再一半，不够
    wheel(el, { deltaY: -WHEEL_OPEN_PX / 2 }, WHEEL_GAP_MS + 10);
    wheel(el, { deltaY: 40 });
    wheel(el, { deltaY: -WHEEL_OPEN_PX / 2 });
    expect(state()).toBe('closed');
    wheel(el, { deltaY: -WHEEL_OPEN_PX / 2 - 1 });
    expect(state()).toBe('open wheel');
    expect(fx.logs).toEqual(['pull open notes via=wheel']);
  });

  it('按着 Ctrl（触控板双指缩放）、横向为主、在抽屉或能滚的框里滚，都不算', () => {
    render(<Host />);
    makeScrollable(screen.getByTestId('box'));
    const el = screen.getByTestId('in');
    wheel(el, { deltaY: -WHEEL_OPEN_PX * 2, ctrlKey: true }, WHEEL_GAP_MS + 10);
    wheel(el, { deltaY: -WHEEL_OPEN_PX * 2, deltaX: -WHEEL_OPEN_PX * 3 }, WHEEL_GAP_MS + 10);
    wheel(screen.getByTestId('in-drawer'), { deltaY: -WHEEL_OPEN_PX * 2 }, WHEEL_GAP_MS + 10);
    wheel(screen.getByTestId('in-box'), { deltaY: -WHEEL_OPEN_PX * 2 }, WHEEL_GAP_MS + 10);
    expect(state()).toBe('closed');
    expect(fx.logs).toEqual([]);
  });

  it('按行滚（deltaMode=1）按每行 16px 算', () => {
    render(<Host />);
    const el = screen.getByTestId('in');
    wheel(el, { deltaY: -4, deltaMode: 1 }, WHEEL_GAP_MS + 10);
    expect(state()).toBe('closed');
    wheel(el, { deltaY: -4, deltaMode: 1 });
    expect(state()).toBe('open wheel');
  });
});

describe('PullSlot', () => {
  it('“搜索本页”：点了 via=key、露出时不画；Esc 收起后焦点回到它', () => {
    render(<Host />);
    fireEvent.click(screen.getByTestId('pull-key'));
    expect(state()).toBe('open key');
    expect(fx.logs).toEqual(['pull open notes via=key']);
    expect(screen.queryByTestId('pull-key')).toBeNull();
    fireEvent.keyDown(screen.getByTestId('q'), { key: 'Escape' });
    expect(state()).toBe('closed');
    expect(document.activeElement).toBe(screen.getByTestId('pull-key'));
  });

  it('就地筛（默认）：打了字列表留着、列表下面挂 foot；shows、markQ 跟着 setFound，清空、收起都复原', () => {
    render(<Host />);
    fireEvent.click(screen.getByTestId('pull-key'));
    expect(screen.queryByTestId('foot')).toBeNull();
    fireEvent.click(screen.getByTestId('found'));
    // 没打字：什么都不藏
    expect(screen.getByTestId('shows').textContent).toBe('true true ');
    fireEvent.change(screen.getByTestId('q'), { target: { value: '牛奶' } });
    expect(screen.getByTestId('pull-keep').hidden).toBe(false);
    expect(screen.getByTestId('foot')).toBeTruthy();
    expect(screen.getByTestId('shows').textContent).toBe('true false 牛');
    fireEvent.change(screen.getByTestId('q'), { target: { value: '' } });
    expect(screen.getByTestId('shows').textContent).toBe('true true ');
    fireEvent.change(screen.getByTestId('q'), { target: { value: '牛奶' } });
    fireEvent.keyDown(screen.getByTestId('q'), { key: 'Escape' });
    expect(screen.getByTestId('shows').textContent).toBe('true true ');
    expect(screen.queryByTestId('foot')).toBeNull();
  });

  it('inPlace=false（日历）：打了字列表只藏不卸（里面的状态留着），清空后原样回来', () => {
    render(<Host inPlace={false} />);
    fireEvent.click(screen.getByTestId('counter'));
    fireEvent.click(screen.getByTestId('pull-key'));
    expect(screen.getByTestId('pull-keep').hidden).toBe(false);
    fireEvent.change(screen.getByTestId('q'), { target: { value: '  ' } });
    expect(screen.getByTestId('pull-keep').hidden).toBe(false);
    fireEvent.change(screen.getByTestId('q'), { target: { value: '牛奶' } });
    expect(screen.getByTestId('pull-keep').hidden).toBe(true);
    fireEvent.change(screen.getByTestId('q'), { target: { value: '' } });
    expect(screen.getByTestId('pull-keep').hidden).toBe(false);
    expect(screen.getByTestId('counter').textContent).toBe('1');
  });
});
