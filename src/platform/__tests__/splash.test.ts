// 启动画面的收起（R-251、R-254）：hideSplash 淡出后移除 DOM、可以重复调用；兜底定时器一律按 220 ms + 余量；5 秒兜底（#root 首次绘制的口径见 root-paint.test.ts）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hideSplash, hideSplashAfter, isSplashShowing, SPLASH_FADE_MS, SPLASH_FADE_RM_MS,
  SPLASH_ID, SPLASH_MAX_MS,
} from '../splash.ts';

function mountSplash(): HTMLElement {
  const el = document.createElement('div');
  el.id = SPLASH_ID;
  el.className = 'lemo-splash';
  document.body.appendChild(el);
  return el;
}

function stubReducedMotion(on: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: on && q === '(prefers-reduced-motion: reduce)',
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  stubReducedMotion(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  delete document.documentElement.dataset['rm'];
});

describe('hideSplash', () => {
  it('加 .is-leaving 开始淡出，淡完从 DOM 移除', async () => {
    const el = mountSplash();
    expect(isSplashShowing()).toBe(true);
    let done = false;
    void hideSplash().then(() => (done = true));
    expect(el.classList.contains('is-leaving')).toBe(true);
    expect(isSplashShowing()).toBe(false);
    await vi.advanceTimersByTimeAsync(SPLASH_FADE_MS);
    expect(document.getElementById(SPLASH_ID)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
    expect(document.getElementById(SPLASH_ID)).toBeNull();
  });

  it('重复调用、并发调用：拿到同一个 Promise，只淡出一次；移除以后再调直接 resolve', async () => {
    mountSplash();
    const a = hideSplash();
    const b = hideSplash();
    expect(b).toBe(a);
    await vi.advanceTimersByTimeAsync(1000);
    await a;
    expect(document.getElementById(SPLASH_ID)).toBeNull();
    await expect(hideSplash()).resolves.toBeUndefined();
    await expect(hideSplash()).resolves.toBeUndefined();
  });

  it('页面里本来就没有启动画面：直接 resolve，不报错', async () => {
    await expect(hideSplash()).resolves.toBeUndefined();
    expect(isSplashShowing()).toBe(false);
  });

  it('transitionend（透明度）一到就移除，不等定时器；别的属性、子元素的 transitionend 不算', async () => {
    const el = mountSplash();
    const child = document.createElement('i');
    el.appendChild(child);
    const p = hideSplash();
    const ev = (prop: string) => Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: prop });
    el.dispatchEvent(ev('color'));
    child.dispatchEvent(ev('opacity'));
    expect(document.getElementById(SPLASH_ID)).not.toBeNull();
    el.dispatchEvent(ev('opacity'));
    await p;
    expect(document.getElementById(SPLASH_ID)).toBeNull();
  });

  it('减少动态效果（系统设置、data-rm="1"）：CSS 120 ms 淡完，transitionend 先到就当场移除；没来时兜底同样按 220 ms + 余量', async () => {
    stubReducedMotion(true);
    document.documentElement.dataset['rm'] = '1';
    const el = mountSplash();
    const p = hideSplash();
    const end = new Event('transitionend') as TransitionEvent;
    Object.defineProperty(end, 'propertyName', { value: 'opacity' });
    el.dispatchEvent(end);
    await p;
    expect(document.getElementById(SPLASH_ID)).toBeNull();

    mountSplash();
    void hideSplash();
    await vi.advanceTimersByTimeAsync(SPLASH_FADE_RM_MS + 100);
    expect(document.getElementById(SPLASH_ID)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(SPLASH_FADE_MS);
    expect(document.getElementById(SPLASH_ID)).toBeNull();
  });
});

describe('hideSplash 的边角', () => {
  it('transitionend 先到：当场移除，兜底定时器也清掉了', async () => {
    const el = mountSplash();
    const p = hideSplash();
    expect(vi.getTimerCount()).toBe(1);
    el.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName: 'opacity' }));
    await p;
    expect(vi.getTimerCount()).toBe(0);
    expect(document.getElementById(SPLASH_ID)).toBeNull();
  });

  it('splash.css 的 6 秒兜底已经把它淡掉（visibility: hidden）以后才调：不算还在显示，直接移除', async () => {
    const el = mountSplash();
    el.style.visibility = 'hidden';
    expect(isSplashShowing()).toBe(false);
    await hideSplash();
    expect(document.getElementById(SPLASH_ID)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('hideSplashAfter', () => {
  it('hideSplashAfter：默认 5 秒到点收起；取消了就不收', async () => {
    const el = mountSplash();
    hideSplashAfter(hideSplash);
    await vi.advanceTimersByTimeAsync(SPLASH_MAX_MS - 1);
    expect(el.classList.contains('is-leaving')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(el.classList.contains('is-leaving')).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);

    const el2 = mountSplash();
    const stop = hideSplashAfter(hideSplash, 100);
    stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(el2.classList.contains('is-leaving')).toBe(false);
  });
  it('到点调传进来的 hide（main.tsx 直接传 hideSplash），不自己直接收', async () => {
    const el = mountSplash();
    const hide = vi.fn();
    hideSplashAfter(hide);
    await vi.advanceTimersByTimeAsync(SPLASH_MAX_MS - 1);
    expect(hide).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hide).toHaveBeenCalledOnce();
    expect(el.classList.contains('is-leaving')).toBe(false);
  });
});
