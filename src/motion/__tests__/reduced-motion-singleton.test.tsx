// 接手清单 M5（UI-4 B0 第二轮 N-3）：useReducedMotionPref 改单例。
// 列表里成批的 <Appear> 各订阅一次，整页仍然只挂一个 MutationObserver、一个 matchMedia 监听；
// 最后一个退订时摘掉，下一次订阅重新挂（读的是那时的 matchMedia）
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Appear, useReducedMotionPref } from '../components.ts';
import { subscribeReducedMotion } from '../index.ts';

const html = document.documentElement;

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
  const matchMedia = vi.fn(() => mql);
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    listeners,
    matchMedia,
    set(v: boolean) {
      reduce = v;
      for (const l of listeners) l();
    },
  };
}

/** 包一层真的 MutationObserver，记下建了几个、还有几个没断开 */
function countObservers() {
  const Real = MutationObserver;
  const stats = { created: 0, live: 0 };
  class Counting extends Real {
    constructor(cb: MutationCallback) {
      super(cb);
      stats.created += 1;
      stats.live += 1;
    }
    override disconnect(): void {
      stats.live -= 1;
      super.disconnect();
    }
  }
  vi.stubGlobal('MutationObserver', Counting);
  return stats;
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

afterEach(() => {
  cleanup();
  delete html.dataset['rm'];
  vi.unstubAllGlobals();
});

describe('M5：减少动态效果的订阅是单例', () => {
  it('20 个 <Appear> 同时挂着：只建 1 个 MutationObserver、matchMedia 只挂 1 个监听；全部卸载后都摘掉', () => {
    const sys = fakeSystem(false);
    const obs = countObservers();
    const { unmount } = render(
      <>
        {Array.from({ length: 20 }, (_, i) => (
          <Appear key={i} kind="row" show>
            <span>{i}</span>
          </Appear>
        ))}
      </>,
    );
    expect(obs.created).toBe(1);
    expect(obs.live).toBe(1);
    expect(sys.listeners.size).toBe(1);
    unmount();
    expect(obs.live).toBe(0);
    expect(sys.listeners.size).toBe(0);
  });

  it('data-rm 变了、系统设置变了：每个订阅者都收到；一个先退订不影响别的', async () => {
    const sys = fakeSystem(false);
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeReducedMotion(a);
    const offB = subscribeReducedMotion(b);
    html.dataset['rm'] = '1';
    await flush();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offA(); // 重复退订不出错、不多减
    act(() => sys.set(true));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    expect(sys.listeners.size).toBe(1);
    offB();
    expect(sys.listeners.size).toBe(0);
  });

  it('回调里退订自己（组件在这次变化里卸载）：同一轮的其余订阅者照样收到', () => {
    const sys = fakeSystem(false);
    const later = vi.fn();
    const off = subscribeReducedMotion(() => off());
    const offLater = subscribeReducedMotion(later);
    act(() => sys.set(true));
    expect(later).toHaveBeenCalledTimes(1);
    offLater();
    expect(sys.listeners.size).toBe(0);
  });

  it('全部退订后再订阅：重新读 matchMedia（换了假系统设置也认）', () => {
    const first = fakeSystem(false);
    subscribeReducedMotion(() => undefined)();
    const second = fakeSystem(false);
    const fn = vi.fn();
    const off = subscribeReducedMotion(fn);
    expect(first.listeners.size).toBe(0);
    expect(second.listeners.size).toBe(1);
    act(() => second.set(true));
    expect(fn).toHaveBeenCalledOnce();
    off();
  });

  it('useReducedMotionPref 多个实例读同一个值、一起更新', async () => {
    fakeSystem(false);
    const seen: boolean[] = [];
    function Probe({ i }: { i: number }) {
      seen[i] = useReducedMotionPref();
      return null;
    }
    render(
      <>
        <Probe i={0} />
        <Probe i={1} />
        <Probe i={2} />
      </>,
    );
    expect(seen).toEqual([false, false, false]);
    html.dataset['rm'] = '1';
    await flush();
    expect(seen).toEqual([true, true, true]);
  });
});

describe('有订阅者时 prefersReducedMotion 复用同一个 MediaQueryList（代码审查 S9）', () => {
  it('挂上以后再读不再调 matchMedia；全部退订后照常现读', async () => {
    const { prefersReducedMotion } = await import('../index.ts');
    const sys = fakeSystem(true);
    const off = subscribeReducedMotion(() => undefined);
    const n = sys.matchMedia.mock.calls.length;
    for (let i = 0; i < 20; i++) expect(prefersReducedMotion()).toBe(true);
    expect(sys.matchMedia.mock.calls.length).toBe(n);
    sys.set(false);
    expect(prefersReducedMotion()).toBe(false);
    off();
    expect(prefersReducedMotion()).toBe(false);
    expect(sys.matchMedia.mock.calls.length).toBe(n + 1);
  });
});
