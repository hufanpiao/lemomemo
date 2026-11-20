// 下拉露出搜索框（R-437；kit/hooks/usePullReveal.ts + kit/components/PullSlot.tsx）：
// • 手势（R-488）：滚到顶往下拉，占位框跟手长出，松手过半才露出；横着拉、不在顶上、按在 data-nopull / fixed / 真能滚的元素里、页面外都不算
// • 滚轮：到顶后先断开 WHEEL_GAP_MS 才累计（惯性冲到顶的那一串不算）；按着 Ctrl、横向为主的不算
// • 键盘：“搜索本页”平时在、露出后不画，点了 via=key；收起后焦点回到它
// • 就地筛（R-447）：默认列表留着、foot 打了字才挂，shows / markQ 跟着 setFound；inPlace=false（日历）打了字列表只藏不卸
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PullSlot } from '../../components/PullSlot.tsx';
import { PULL_FOLLOW, PULL_H, PULL_OPEN_PX, SETTLE_MS, STILL_MS, usePullReveal, WHEEL_GAP_MS, WHEEL_OPEN_PX } from '../usePullReveal.ts';

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
const scrollBy = vi.fn();
function drag(el: HTMLElement, dx: number, dy: number) {
  fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 100 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: 100 + dx / 2, clientY: 100 + dy / 2 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: 100 + dx, clientY: 100 + dy }] });
  fireEvent.touchEnd(el, { touches: [] });
  // 松手过半：占位框先补满 SETTLE_MS 再换真框
  act(() => vi.advanceTimersByTime(SETTLE_MS));
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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  scrollBy.mockClear();
  window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
  fx.logs.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
    // 没拉到门槛那一次记下最远距离（负责人 11-17 晚：门槛按日志里的数调）
    expect(fx.logs).toEqual([`pull short notes dy=${PULL_OPEN_PX - 4}`, 'pull open notes via=touch']);
    fireEvent.keyDown(screen.getByTestId('q'), { key: 'Escape' });
    expect(state()).toBe('closed');
    expect(fx.logs.slice(1)).toEqual(['pull open notes via=touch', 'pull close notes']);
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
    // 只许有“没拉到”的距离记录，不许露出
    expect(fx.logs.filter((s) => !s.startsWith('pull short '))).toEqual([]);
  });

  // R-488（负责人 11-20 选“跟手拉出：拉多少露多少，过半松手展开，不到一半缩回”）
  it('占位框跟手长出（手指 × PULL_FOLLOW，最多 PULL_H），拉着时不打开、松手过半才打开；不到一半缩回 0', () => {
    render(<Host />);
    const el = screen.getByTestId('in');
    const ghost = () => screen.getByTestId('pull-ghost');
    fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchMove(el, { touches: [{ clientX: 100, clientY: 120 }] });
    expect(ghost().style.getPropertyValue('--pull-g')).toBe(`${20 * PULL_FOLLOW}px`);
    expect(ghost().hasAttribute('data-drag')).toBe(true);
    fireEvent.touchMove(el, { touches: [{ clientX: 100, clientY: 400 }] });
    expect(ghost().style.getPropertyValue('--pull-g')).toBe(`${PULL_H}px`);
    expect(ghost().style.getPropertyValue('--pull-o')).toBe('1');
    expect(state()).toBe('closed');
    // 拉回去一点再松手：只看松手那一刻长了多少
    fireEvent.touchMove(el, { touches: [{ clientX: 100, clientY: 110 }] });
    fireEvent.touchEnd(el, { touches: [] });
    expect(state()).toBe('closed');
    expect(ghost().style.getPropertyValue('--pull-g')).toBe('0px');
    expect(ghost().hasAttribute('data-drag')).toBe(false);
    // 过半松手：占位框先补满到 PULL_H，SETTLE_MS 以后才换真框（整块评审第 2 条）
    fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchMove(el, { touches: [{ clientX: 100, clientY: 100 + PULL_OPEN_PX }] });
    fireEvent.touchEnd(el, { touches: [] });
    expect(ghost().style.getPropertyValue('--pull-g')).toBe(`${PULL_H}px`);
    expect(state()).toBe('closed');
    act(() => vi.advanceTimersByTime(SETTLE_MS));
    expect(state()).toBe('open touch');
    expect(screen.queryByTestId('pull-ghost')).toBeNull();
  });

  it('拉满了（框已长到 PULL_H）松手当场换真框，不等', () => {
    render(<Host />);
    const el = screen.getByTestId('in');
    fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchMove(el, { touches: [{ clientX: 100, clientY: 300 }] });
    fireEvent.touchEnd(el, { touches: [] });
    expect(state()).toBe('open touch');
  });

  it('露出了、没打字：页面往上滚，搜索框按滚动量慢慢淡出；滚走 PULL_H、滚动停下 STILL_MS 才收起，焦点不跳；打了字就不收（负责人 11-20“慢慢收进去”）', () => {
    render(<Host />);
    drag(screen.getByTestId('in'), 0, PULL_OPEN_PX);
    expect(state()).toBe('open touch');
    const head = (): HTMLElement => screen.getByTestId('pull-head');
    scrollY = PULL_H / 2;
    fireEvent.scroll(window);
    expect(head().style.opacity).toBe('0.5');
    scrollY = PULL_H;
    fireEvent.scroll(window);
    expect(head().style.opacity).toBe('0');
    act(() => vi.advanceTimersByTime(STILL_MS));
    // 正好 PULL_H：还算露着的范围，不收
    expect(state()).toBe('open touch');
    scrollY = PULL_H + 1;
    fireEvent.scroll(window);
    // 还在滚（没停够 STILL_MS）：不卸，不在惯性滚动途中挪页面
    act(() => vi.advanceTimersByTime(STILL_MS - 1));
    expect(state()).toBe('open touch');
    expect(scrollBy).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(state()).toBe('closed');
    expect(document.activeElement).not.toBe(screen.getByTestId('pull-key'));
    // 抽走的那 PULL_H 同一帧补回去，手指下的内容不跳（整块评审第 3 条）
    expect(scrollBy).toHaveBeenCalledWith(0, -PULL_H);
    scrollY = 0;
    drag(screen.getByTestId('in'), 0, PULL_OPEN_PX);
    fireEvent.change(screen.getByTestId('q'), { target: { value: '牛奶' } });
    scrollY = 300;
    fireEvent.scroll(window);
    expect(state()).toBe('open touch');
  });

  it('页面已经滚走、那次 scroll 事件还没派发时，停稳计时到点不卸：等 scroll 事件来了淡到 0、再停稳才收（11-20 e2e webkit 慢帧下 0.5 直接卸掉）', () => {
    render(<Host />);
    drag(screen.getByTestId('in'), 0, PULL_OPEN_PX);
    const head = (): HTMLElement => screen.getByTestId('pull-head');
    scrollY = PULL_H / 2;
    fireEvent.scroll(window);
    expect(head().style.opacity).toBe('0.5');
    // 滚到 300，但 scroll 事件要等下一帧，这期间上一次的停稳计时先到点
    scrollY = 300;
    act(() => vi.advanceTimersByTime(STILL_MS));
    expect(state()).toBe('open touch');
    expect(scrollBy).not.toHaveBeenCalled();
    fireEvent.scroll(window);
    expect(head().style.opacity).toBe('0');
    act(() => vi.advanceTimersByTime(STILL_MS));
    expect(state()).toBe('closed');
    expect(scrollBy).toHaveBeenCalledWith(0, -PULL_H);
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
    // 只打了标点、空白：没有可查的词，不算在搜，什么都不藏、不挂 foot（评审第 3 条）
    fireEvent.change(screen.getByTestId('q'), { target: { value: '， #' } });
    expect(screen.getByTestId('shows').textContent).toBe('true true ');
    expect(screen.queryByTestId('foot')).toBeNull();
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
