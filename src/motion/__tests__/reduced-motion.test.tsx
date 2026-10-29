// UI-4 M-1（架构 17.2 第 5 点）：“减少动态效果”只有一套判断——系统设置或 <html data-rm="1"> 任一条成立就算。
// 函数（animateIn / press / transition）和 React 组件（Appear、SharedLayout）读的是同一个判断，data-rm 变了组件要重新渲染
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { useReducedMotionConfig } from 'motion/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appearMotion } from '../Appear.tsx';
import { Appear, SharedLayout, useReducedMotionPref } from '../components.ts';
import { animateIn, prefersReducedMotion, press } from '../index.ts';
import { presets, PRESS_SCALE } from '../presets.ts';
import { dur } from '../tokens.ts';

const html = document.documentElement;

/** 假的 matchMedia：系统“减少动态效果”开或关，可以中途切换 */
function fakeSystem(reduce: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    get matches() {
      return reduce;
    },
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  };
  vi.stubGlobal('matchMedia', () => mql);
  return {
    set(v: boolean) {
      reduce = v;
      for (const l of listeners) l();
    },
    listeners,
  };
}

/** MutationObserver 的回调是微任务：等一轮 */
const flush = () => act(async () => {
  await Promise.resolve();
});

afterEach(() => {
  cleanup();
  delete html.dataset['rm'];
  vi.unstubAllGlobals();
});

describe('一套判断：系统设置 或 data-rm="1"', () => {
  it('prefersReducedMotion：两条任一成立就是 true', () => {
    fakeSystem(false);
    expect(prefersReducedMotion()).toBe(false);
    html.dataset['rm'] = '1';
    expect(prefersReducedMotion()).toBe(true);
    delete html.dataset['rm'];
    fakeSystem(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  it('useReducedMotionPref：data-rm 变了、系统设置变了都会重新渲染；卸载后不留监听', async () => {
    const sys = fakeSystem(false);
    const { result, unmount } = renderHook(() => useReducedMotionPref());
    expect(result.current).toBe(false);
    html.dataset['rm'] = '1';
    await flush();
    expect(result.current).toBe(true);
    delete html.dataset['rm'];
    await flush();
    expect(result.current).toBe(false);
    act(() => sys.set(true));
    expect(result.current).toBe(true);
    unmount();
    expect(sys.listeners.size).toBe(0);
  });
});

describe('组件跟着同一套判断（只开设置里的开关、系统没开）', () => {
  it('Appear：data-rm="1" 时只淡入，不位移', () => {
    fakeSystem(false);
    html.dataset['rm'] = '1';
    render(
      <Appear kind="toast" show>
        <span>hi</span>
      </Appear>,
    );
    const el = screen.getByText('hi').parentElement as HTMLElement;
    expect(el.dataset['appear']).toBe('toast');
    expect(el.style.transform === '' || el.style.transform === 'none').toBe(true);
  });

  it('Appear：都没开时照常从下往上滑入（对照）', () => {
    fakeSystem(false);
    render(
      <Appear kind="toast" show>
        <span>hi</span>
      </Appear>,
    );
    const el = screen.getByText('hi').parentElement as HTMLElement;
    expect(el.style.transform).toContain('translateY(12px)');
  });

  it('SharedLayout：data-rm="1" 时 layoutId 的弹簧关掉（MotionConfig reducedMotion）', () => {
    fakeSystem(false);
    html.dataset['rm'] = '1';
    let seen: boolean | null = null;
    function Probe() {
      seen = useReducedMotionConfig();
      return null;
    }
    render(
      <SharedLayout id="x">
        <Probe />
      </SharedLayout>,
    );
    expect(seen).toBe(true);
  });

  it('SharedLayout：都没开时弹簧照常（对照）', () => {
    fakeSystem(false);
    let seen: boolean | null = null;
    function Probe() {
      seen = useReducedMotionConfig();
      return null;
    }
    render(
      <SharedLayout id="x">
        <Probe />
      </SharedLayout>,
    );
    expect(seen).toBe(false);
  });
});

describe('Appear 减少动态效果时交给 Motion 的参数', () => {
  for (const kind of ['toast', 'sheet', 'row', 'page'] as const) {
    it(`${kind}：起始透明度 0、没有 transform，时长是预设的一半；关时照预设（对照）`, () => {
      const on = appearMotion(kind, true);
      expect(on.initial).toEqual({ opacity: 0 });
      expect('transform' in on.animate).toBe(false);
      expect(on.transition.duration).toBe(presets[kind].transition.duration / 2);
      expect(on.transition.ease).toEqual(presets[kind].transition.ease);
      const off = appearMotion(kind, false);
      expect(off.initial).toEqual(presets[kind].initial);
      expect(off.transition.duration).toBe(presets[kind].transition.duration);
    });
  }

  it('渲染出来的起始透明度是 0（data-rm="1"）', () => {
    fakeSystem(false);
    html.dataset['rm'] = '1';
    render(
      <Appear kind="toast" show>
        <span>hi</span>
      </Appear>,
    );
    const el = screen.getByText('hi').parentElement as HTMLElement;
    expect(el.style.opacity).toBe('0');
  });
});

describe('TC-B1-52：只开系统设置（data-rm 没开）同样不做位移', () => {
  it('Appear：系统 prefers-reduced-motion 开时只淡入，不位移', () => {
    fakeSystem(true);
    render(
      <Appear kind="toast" show>
        <span>hi</span>
      </Appear>,
    );
    const el = screen.getByText('hi').parentElement as HTMLElement;
    expect(el.style.transform === '' || el.style.transform === 'none').toBe(true);
  });

  it('SharedLayout：系统设置开时 layoutId 的弹簧关掉', () => {
    fakeSystem(true);
    let seen: boolean | null = null;
    function Probe() {
      seen = useReducedMotionConfig();
      return null;
    }
    render(
      <SharedLayout id="x">
        <Probe />
      </SharedLayout>,
    );
    expect(seen).toBe(true);
  });
});

/** 给元素装一个假的 element.animate（jsdom 没有），记下调用参数 */
function stubAnimate(el: Element) {
  const fn = vi.fn((_frames: Keyframe[], _opts: KeyframeAnimationOptions) => ({ finished: Promise.resolve() }));
  (el as Element & { animate: unknown }).animate = fn;
  return fn;
}

describe('17.4 B1（UI-4 M-1）：非 React 的 animateIn、press 和组件表现一致', () => {
  for (const [name, setup] of [
    ['data-rm="1"', () => { fakeSystem(false); html.dataset['rm'] = '1'; }],
    ['系统设置', () => fakeSystem(true)],
  ] as const) {
    it(`animateIn：${name} 时只淡入（关键帧里没有 transform），时长减半`, async () => {
      setup();
      const el = document.createElement('div');
      const fn = stubAnimate(el);
      await animateIn(el, 'toast');
      const [frames, opts] = fn.mock.calls[0] ?? [];
      expect(frames?.every((f) => !('transform' in f))).toBe(true);
      expect(opts?.duration).toBe((presets.toast.transition.duration * 1000) / 2);
    });

    it(`press：${name} 时不缩放（不调 element.animate）`, async () => {
      setup();
      const el = document.createElement('button');
      const fn = stubAnimate(el);
      await press(el);
      expect(fn).not.toHaveBeenCalled();
    });
  }

  it('都没开（对照）：animateIn 带位移、用预设时长；press 缩到 PRESS_SCALE、时长取 --dur-press', async () => {
    fakeSystem(false);
    const el = document.createElement('div');
    const fn = stubAnimate(el);
    await animateIn(el, 'toast');
    const [frames, opts] = fn.mock.calls[0] ?? [];
    expect(frames?.[0]?.transform).toBe(presets.toast.initial.transform);
    expect(opts?.duration).toBe(presets.toast.transition.duration * 1000);

    const btn = document.createElement('button');
    const pf = stubAnimate(btn);
    await press(btn);
    const [pFrames, pOpts] = pf.mock.calls[0] ?? [];
    expect(pFrames?.[1]?.transform).toBe(`scale(${PRESS_SCALE})`);
    expect(pOpts?.duration).toBe(dur.press * 1000 * 2);
  });
});
