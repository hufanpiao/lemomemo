// UI-4 M-1（架构 17.2 第 5 点）：“减少动态效果”只有一套判断——<html data-rm="1">。系统设置那一条由 platform/look.ts 并进 data-rm
// （皮肤整块评审 11-14 第 1、6 条；look.test.ts 验），本模块不再自己查 matchMedia。
// 函数（animateIn / press / transition）和 React 组件（Appear、SharedLayout）读的是同一个判断，data-rm 变了组件要重新渲染
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { useReducedMotionConfig } from 'motion/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appearMotion } from '../appear-impl.tsx';
import { Appear, SharedLayout, useReducedMotionPref } from '../components.ts';
import { animateIn, prefersReducedMotion, press } from '../index.ts';
import { presets, PRESS_SCALE } from '../presets.ts';
import { dur } from '../tokens.ts';
import { loadMotionFeatures } from '../features.ts';

// 动效功能包异步加载（B2 FA-6 ②）：这里测的是功能包到了以后的手感，先等它到（真实页面里首屏画完后才有人操作）
await loadMotionFeatures();

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

describe('一套判断：只看 data-rm="1"', () => {
  it('prefersReducedMotion：data-rm="1" 才是 true；系统设置了 reduce 但 data-rm 没写（look.ts 还没并进来）不自己判断', () => {
    fakeSystem(false);
    expect(prefersReducedMotion()).toBe(false);
    html.dataset['rm'] = '1';
    expect(prefersReducedMotion()).toBe(true);
    delete html.dataset['rm'];
    fakeSystem(true);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('useReducedMotionPref：data-rm 变了就重新渲染；不挂 matchMedia 监听', async () => {
    const sys = fakeSystem(false);
    const { result, unmount } = renderHook(() => useReducedMotionPref());
    expect(result.current).toBe(false);
    html.dataset['rm'] = '1';
    await flush();
    expect(result.current).toBe(true);
    delete html.dataset['rm'];
    await flush();
    expect(result.current).toBe(false);
    expect(sys.listeners.size).toBe(0);
    unmount();
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
    it(`${kind}：起始和退出都是透明度 0、没有 transform，时长是预设的一半；关时照预设（对照）`, () => {
      const on = appearMotion(kind, true);
      expect(on.initial).toEqual({ opacity: 0 });
      expect('transform' in on.animate).toBe(false);
      const out = presets[kind].exitTransition ?? presets[kind].transition;
      expect(on.exit).toEqual({ opacity: 0, transition: { ...out, duration: out.duration / 2 } });
      expect('transform' in on.exit).toBe(false);
      expect(on.transition.duration).toBe(presets[kind].transition.duration / 2);
      expect(on.transition.ease).toEqual(presets[kind].transition.ease);
      const off = appearMotion(kind, false);
      expect(off.initial).toEqual(presets[kind].initial);
      expect(off.transition.duration).toBe(presets[kind].transition.duration);
    });
  }

  it('弹层退场比进场快：同一条抽屉曲线，时长是进场的 0.6～0.7 倍；遮罩、提示条等退场和进场一样（MOTION-sheet-exit）', () => {
    const sheet = appearMotion('sheet', false);
    expect(sheet.transition.duration).toBe(dur.sheet);
    const ratio = sheet.exit.transition.duration / sheet.transition.duration;
    expect(ratio).toBeGreaterThanOrEqual(0.6);
    expect(ratio).toBeLessThanOrEqual(0.7);
    expect(sheet.exit.transition.ease).toEqual(sheet.transition.ease);
    expect((sheet.exit as { transform?: string }).transform).toBe('translateY(100%) scale(1)');
    for (const k of ['scrim', 'toast', 'row'] as const) expect(appearMotion(k, false).exit.transition).toEqual(presets[k].transition);
  });

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

describe('TC-B1-52：只开系统设置时同样不做位移（look.ts 把系统设置写成 data-rm="1"）', () => {
  it('Appear：系统 prefers-reduced-motion 开（data-rm="1"）时只淡入，不位移', () => {
    fakeSystem(true);
    html.dataset['rm'] = '1';
    render(
      <Appear kind="toast" show>
        <span>hi</span>
      </Appear>,
    );
    const el = screen.getByText('hi').parentElement as HTMLElement;
    expect(el.style.transform === '' || el.style.transform === 'none').toBe(true);
  });

  it('SharedLayout：系统设置开（data-rm="1"）时 layoutId 的弹簧关掉', () => {
    fakeSystem(true);
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
});

/** 给元素装一个假的 element.animate（jsdom 没有），记下调用参数 */
function stubAnimate(el: Element) {
  const fn = vi.fn((_frames: Keyframe[], _opts: KeyframeAnimationOptions) => ({ finished: Promise.resolve() }));
  // 先转成 unknown 再看成普通对象：两套 tsconfig 的 DOM 类型不同，交叉类型在带完整 DOM 类型时会收窄成 Animation 签名
  (el as unknown as { animate: unknown }).animate = fn;
  return fn;
}

describe('17.4 B1（UI-4 M-1）：非 React 的 animateIn、press 和组件表现一致', () => {
  for (const [name, setup] of [
    ['data-rm="1"', () => { fakeSystem(false); html.dataset['rm'] = '1'; }],
    ['系统设置（look.ts 写成 data-rm="1"）', () => { fakeSystem(true); html.dataset['rm'] = '1'; }],
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

describe('弹层的遮罩和内容（Dialog.tsx，UI-4 L-2）', () => {
  it('Dialog 用的两种（UI-4 L-2）时长：内容 --dur-sheet、遮罩 --dur-ui；减少动态效果时两者都减半（接手清单 M4）', () => {
    expect(appearMotion('sheet', false).transition.duration).toBe(dur.sheet);
    expect(appearMotion('scrim', false).transition.duration).toBe(dur.ui);
    expect(appearMotion('sheet', true).transition.duration).toBe(dur.sheet / 2);
    expect(appearMotion('scrim', true).transition.duration).toBe(dur.ui / 2);
    // 遮罩只淡入淡出，起止的 transform 一样（不动位置）
    const s = appearMotion('scrim', false);
    expect(s.initial.opacity).toBe(0);
    expect(s.animate.opacity).toBe(1);
    expect((s.animate as { transform?: string }).transform).toBe('translateY(0px) scale(1)');
    expect(s.initial).toMatchObject({ transform: 'translateY(0px) scale(1)' });
  });
});
