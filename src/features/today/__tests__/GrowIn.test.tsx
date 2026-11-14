// GrowIn（设计复审 今天页待办 第二轮 J1）：晚到的“错过 N 条提醒”一行不一下子把页面往下推。
// jsdom 没有 ResizeObserver、不算布局：这里装一个替身，里面那层的高度由测试给（h），触发 trigger() 当作“里面的高度变了”
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GROW_QUIET_MS, GrowIn, resetGrowPointerForTest } from '../ui/GrowIn.tsx';

let h = 0;
const observers: (() => void)[] = [];
class FakeRO {
  private readonly cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe(): void {
    observers.push(this.cb);
  }
  disconnect(): void {}
}
const trigger = async (): Promise<void> => {
  await act(async () => {
    for (const cb of observers) cb();
  });
};
const sleep = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));
let scrollY = 0;
let anchored = false;

beforeEach(() => {
  h = 0;
  scrollY = 0;
  anchored = false;
  observers.length = 0;
  resetGrowPointerForTest();
  vi.stubGlobal('ResizeObserver', FakeRO);
  // 里面那层（className 带 missed）的高度由测试给；外层不量
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return String(this.className).includes('missed') ? h : 0;
  });
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
  // 外层下沿在屏幕上的位置：默认没有滚动锚定（Safari），跟着外层高度和滚动位置走；anchored 时浏览器自己补，下沿不动
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const bottom = anchored ? 0 : (Number.parseFloat(this.style.height) || 0) - scrollY;
    return { bottom, top: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  delete document.documentElement.dataset['rm'];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.documentElement.dataset['rm'];
});

const mount = () => render(<GrowIn testId="g"><button type="button">错过 1 条提醒</button></GrowIn>);
const outer = () => screen.getByTestId('g');

describe('GrowIn', () => {
  it('第一次画出来之前就有内容：直接到位，不过渡，放开溢出', () => {
    h = 52;
    mount();
    expect(outer().style.height).toBe('52px');
    expect(outer().dataset['anim']).toBe('off');
    expect(outer().hasAttribute('data-settled')).toBe(true);
  });

  it('画出来以后才有：过渡到新高度；过渡完才放开溢出', async () => {
    mount();
    h = 52;
    await trigger();
    expect(outer().style.height).toBe('52px');
    expect(outer().dataset['anim']).toBe('on');
    expect(outer().hasAttribute('data-settled')).toBe(false);
    await act(async () => {
      outer().dispatchEvent(new Event('transitionend', { bubbles: true }));
    });
    expect(outer().hasAttribute('data-settled')).toBe(true);
  });

  it('已经到位的再变高（比如从 1 条变 2 条）：变的过程中重新裁掉溢出，到位后再放开', async () => {
    h = 52;
    mount();
    expect(outer().hasAttribute('data-settled')).toBe(true);
    h = 96;
    await trigger();
    expect(outer().style.height).toBe('96px');
    expect(outer().hasAttribute('data-settled')).toBe(false);
    await act(async () => {
      outer().dispatchEvent(new Event('transitionend', { bubbles: true }));
    });
    expect(outer().hasAttribute('data-settled')).toBe(true);
  });

  it('手指按着：先不动；抬手以后再静约 600 ms 才展开', async () => {
    mount();
    window.dispatchEvent(new Event('pointerdown'));
    h = 52;
    await trigger();
    await sleep(250);
    expect(outer().style.height).not.toBe('52px');
    window.dispatchEvent(new Event('pointerup'));
    await sleep(GROW_QUIET_MS - 250);
    expect(outer().style.height).not.toBe('52px');
    await sleep(400);
    expect(outer().style.height).toBe('52px');
    expect(outer().dataset['anim']).toBe('on');
  });

  it('按着时切走窗口（抬起丢了）：blur、visibilitychange 把“按着”清零，不一直卡住', async () => {
    mount();
    for (const fire of [() => window.dispatchEvent(new Event('blur')), () => document.dispatchEvent(new Event('visibilitychange'))]) {
      resetGrowPointerForTest();
      window.dispatchEvent(new Event('pointerdown'));
      h = h === 52 ? 0 : 52;
      await trigger();
      await sleep(250);
      expect(outer().style.height).not.toBe(`${h}px`);
      fire();
      await sleep(250);
      expect(outer().style.height).toBe(`${h}px`);
    }
  });

  it('页面已经往下滚过：直接到位，同时把滚动位置补上同样的高度；收起时补回去', async () => {
    const by = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    mount();
    scrollY = 300;
    h = 52;
    await trigger();
    expect(outer().style.height).toBe('52px');
    expect(outer().dataset['anim']).toBe('off');
    expect(by).toHaveBeenCalledWith(0, 52);
    h = 0;
    await trigger();
    expect(outer().style.height).toBe('0px');
    expect(by).toHaveBeenLastCalledWith(0, -52);
  });

  it('浏览器自己有滚动锚定（Chromium）：下沿没挪，不重复补（J1 验收第一次跑出来补了两次）', async () => {
    const by = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    anchored = true;
    mount();
    scrollY = 300;
    h = 52;
    await trigger();
    expect(outer().style.height).toBe('52px');
    expect(by).not.toHaveBeenCalled();
  });

  it('没滚过的页面不动滚动位置；收起（别处已处理）同样过渡', async () => {
    const by = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    mount();
    h = 52;
    await trigger();
    h = 0;
    await trigger();
    expect(outer().style.height).toBe('0px');
    expect(outer().dataset['anim']).toBe('on');
    expect(by).not.toHaveBeenCalled();
  });

  it('减少动态效果（data-rm）：直接到位', async () => {
    document.documentElement.dataset['rm'] = '1';
    mount();
    h = 52;
    await trigger();
    expect(outer().style.height).toBe('52px');
    expect(outer().dataset['anim']).toBe('off');
  });
});
