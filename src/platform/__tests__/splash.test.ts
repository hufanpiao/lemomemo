// 启动画面的收起（R-251、R-254）：hideSplash 淡出后移除 DOM、可以重复调用；减少动态效果时按 120 ms 收；5 秒兜底和 #root 首次绘制以后收起
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hideSplash, hideSplashAfter, hideSplashWhenPainted, isSplashShowing, SPLASH_FADE_MS, SPLASH_FADE_RM_MS, SPLASH_ID, SPLASH_MAX_MS,
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

  it('减少动态效果（系统设置）：按 120 ms 收，比平时的 220 ms 早移除', async () => {
    stubReducedMotion(true);
    mountSplash();
    void hideSplash();
    await vi.advanceTimersByTimeAsync(SPLASH_FADE_RM_MS + 100);
    expect(document.getElementById(SPLASH_ID)).toBeNull();
  });

  it('减少动态效果（设置里的开关 data-rm="1"）同样按 120 ms；不开时这个时刻还在淡出', async () => {
    mountSplash();
    void hideSplash();
    await vi.advanceTimersByTimeAsync(SPLASH_FADE_RM_MS + 100);
    expect(document.getElementById(SPLASH_ID)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(SPLASH_FADE_MS);
    expect(document.getElementById(SPLASH_ID)).toBeNull();

    document.documentElement.dataset['rm'] = '1';
    mountSplash();
    void hideSplash();
    await vi.advanceTimersByTimeAsync(SPLASH_FADE_RM_MS + 100);
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

describe('hideSplashAfter、hideSplashWhenPainted', () => {
  it('hideSplashAfter：默认 5 秒到点收起；取消了就不收', async () => {
    const el = mountSplash();
    hideSplashAfter();
    await vi.advanceTimersByTimeAsync(SPLASH_MAX_MS - 1);
    expect(el.classList.contains('is-leaving')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(el.classList.contains('is-leaving')).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);

    const el2 = mountSplash();
    const stop = hideSplashAfter(100);
    stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(el2.classList.contains('is-leaving')).toBe(false);
  });

  it('root 还是空的：不收；画出第一个节点以后按传进来的 nextFrame 收', async () => {
    const el = mountSplash();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const frames: (() => void)[] = [];
    hideSplashWhenPainted(root, (cb) => {
      frames.push(cb);
      return () => undefined;
    });
    await Promise.resolve();
    expect(frames).toHaveLength(0);
    root.appendChild(document.createElement('p'));
    await Promise.resolve();
    expect(frames).toHaveLength(1);
    expect(el.classList.contains('is-leaving')).toBe(false);
    frames[0]?.();
    expect(el.classList.contains('is-leaving')).toBe(true);
    root.appendChild(document.createElement('p'));
    await Promise.resolve();
    expect(frames).toHaveLength(1);
  });

  it('root 里已经有东西：直接排下一帧；取消函数能撤掉还没画出的那一次', async () => {
    const el = mountSplash();
    const root = document.createElement('div');
    root.appendChild(document.createElement('p'));
    hideSplashWhenPainted(root);
    await vi.advanceTimersByTimeAsync(0);
    expect(el.classList.contains('is-leaving')).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);

    const el2 = mountSplash();
    const empty = document.createElement('div');
    const stop = hideSplashWhenPainted(empty);
    stop();
    empty.appendChild(document.createElement('p'));
    await vi.advanceTimersByTimeAsync(10);
    expect(el2.classList.contains('is-leaving')).toBe(false);
  });
});

describe('hideSplashWhenPainted 的“画出东西”口径：有元素子节点或非空白文本', () => {
  function setup(prefill?: (root: HTMLElement) => void) {
    const el = mountSplash();
    const root = document.createElement('div');
    prefill?.(root);
    document.body.appendChild(root);
    const frames: (() => void)[] = [];
    hideSplashWhenPainted(root, (cb) => {
      frames.push(cb);
      cb();
      return () => undefined;
    });
    return { el, root, frames };
  }

  it('塞进纯空白文本：不收；再画出元素才收', async () => {
    const { el, root } = setup();
    root.appendChild(document.createTextNode('\n    '));
    await Promise.resolve();
    expect(el.classList.contains('is-leaving')).toBe(false);
    root.appendChild(document.createElement('main'));
    await Promise.resolve();
    expect(el.classList.contains('is-leaving')).toBe(true);
  });

  it('塞进注释节点：不收；再画出元素才收', async () => {
    const { el, root } = setup();
    root.appendChild(document.createComment('react'));
    await Promise.resolve();
    expect(el.classList.contains('is-leaving')).toBe(false);
    root.appendChild(document.createElement('main'));
    await Promise.resolve();
    expect(el.classList.contains('is-leaving')).toBe(true);
  });

  it('挂上之前 #root 里就有空白（index.html 格式化过）：挂上时不收；画出元素才收', async () => {
    const { el, root, frames } = setup((r) => r.appendChild(document.createTextNode('\n  ')));
    expect(frames).toHaveLength(0);
    expect(el.classList.contains('is-leaving')).toBe(false);
    root.appendChild(document.createElement('main'));
    await Promise.resolve();
    expect(el.classList.contains('is-leaving')).toBe(true);
  });

  it('空白文本原地改成文字：算画出东西，收起', async () => {
    const { el, root } = setup();
    const t = document.createTextNode('  ');
    root.appendChild(t);
    await Promise.resolve();
    expect(el.classList.contains('is-leaving')).toBe(false);
    t.data = '出错了';
    await Promise.resolve();
    expect(el.classList.contains('is-leaving')).toBe(true);
  });
});
