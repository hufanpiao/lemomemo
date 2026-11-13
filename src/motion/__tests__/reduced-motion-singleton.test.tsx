// 接手清单 M5（UI-4 B0 第二轮 N-3）：useReducedMotionPref 改单例。
// 列表里成批的 <Appear> 各订阅一次，整页仍然只挂一个 MutationObserver（看 <html data-rm>）；最后一个退订时摘掉，下一次订阅重新挂。
// 系统设置由 platform/look.ts 并进 data-rm（皮肤整块评审 11-14 第 1、6 条），本模块不调 matchMedia
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Appear, useReducedMotionPref } from '../components.ts';
import { prefersReducedMotion, subscribeReducedMotion } from '../index.ts';

const html = document.documentElement;

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

/** 记下有没有人调 matchMedia（本模块不该调） */
const spyMatchMedia = () => {
  const fn = vi.fn(() => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('matchMedia', fn);
  return fn;
};

afterEach(() => {
  cleanup();
  delete html.dataset['rm'];
  vi.unstubAllGlobals();
});

describe('M5：减少动态效果的订阅是单例', () => {
  it('20 个 <Appear> 同时挂着：只建 1 个 MutationObserver、不调 matchMedia；全部卸载后摘掉', () => {
    const mm = spyMatchMedia();
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
    unmount();
    expect(obs.live).toBe(0);
    expect(mm).not.toHaveBeenCalled();
  });

  it('data-rm 变了：每个订阅者都收到；一个先退订不影响别的', async () => {
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
    delete html.dataset['rm'];
    await flush();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    offB();
  });

  it('回调里退订自己（组件在这次变化里卸载）：同一轮的其余订阅者照样收到', async () => {
    const later = vi.fn();
    const off = subscribeReducedMotion(() => off());
    const offLater = subscribeReducedMotion(later);
    html.dataset['rm'] = '1';
    await flush();
    expect(later).toHaveBeenCalledTimes(1);
    offLater();
  });

  it('全部退订后再订阅：重新挂 MutationObserver，照样收到', async () => {
    const obs = countObservers();
    subscribeReducedMotion(() => undefined)();
    expect(obs.live).toBe(0);
    const fn = vi.fn();
    const off = subscribeReducedMotion(fn);
    expect(obs.created).toBe(2);
    html.dataset['rm'] = '1';
    await flush();
    expect(fn).toHaveBeenCalledOnce();
    off();
  });

  it('useReducedMotionPref 多个实例读同一个值、一起更新', async () => {
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

describe('prefersReducedMotion 只读属性（代码审查 S9 的 MediaQueryList 复用已随 matchMedia 一起删掉）', () => {
  it('读多少次都不调 matchMedia', () => {
    const mm = spyMatchMedia();
    for (let i = 0; i < 20; i++) expect(prefersReducedMotion()).toBe(false);
    html.dataset['rm'] = '1';
    expect(prefersReducedMotion()).toBe(true);
    expect(mm).not.toHaveBeenCalled();
  });
});
