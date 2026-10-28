// UI-4 M-1（架构 17.2 第 5 点）：“减少动态效果”只有一套判断——系统设置或 <html data-rm="1"> 任一条成立就算。
// 函数（animateIn / press / transition）和 React 组件（Appear、SharedLayout）读的是同一个判断，data-rm 变了组件要重新渲染
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { useReducedMotionConfig } from 'motion/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Appear, SharedLayout, useReducedMotionPref } from '../components.ts';
import { prefersReducedMotion } from '../index.ts';

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
