// 后台预加载两页之间的等待（app/preload-gap.ts，独立评审 11-25 第 1 条）：空闲以后手指按着不走、停一拍期间不走、抬起不到 PRELOAD_QUIET_MS 不走，
// 抬起静下来就走；一直按着等满 PRELOAD_MAX_WAIT_MS 也照样走
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPointersForTest, useHoldView } from '../../motion/components.ts';
import { PRELOAD_MAX_WAIT_MS, PRELOAD_QUIET_MS, preloadGap } from '../preload-gap.ts';

/** 起一次等待，返回“走了没有” */
const start = (idle: (fn: () => void) => void = (fn) => fn()): (() => boolean) => {
  let done = false;
  void preloadGap(idle).then(() => {
    done = true;
  });
  return () => done;
};
const tick = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('preloadGap', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    resetPointersForTest();
    // 装上全局指针监听（watchPointers 只装一次）：空闲永远不到的一次等待
    start(() => undefined);
  });
  afterEach(() => {
    cleanup();
    resetPointersForTest();
    vi.useRealTimers();
  });

  it('没按过、空闲到了就走；空闲没到不走', async () => {
    let fire: (() => void) | null = null;
    const done = start((fn) => {
      fire = fn;
    });
    await tick(5000);
    expect(done()).toBe(false);
    (fire as unknown as () => void)();
    await tick(0);
    expect(done()).toBe(true);
  });

  it('手指按着时不走；抬起不到 PRELOAD_QUIET_MS 也不走；静下来才走', async () => {
    window.dispatchEvent(new Event('pointerdown'));
    const d2 = start();
    await tick(1000);
    expect(d2()).toBe(false);
    window.dispatchEvent(new Event('pointerup'));
    await tick(PRELOAD_QUIET_MS - 200);
    expect(d2()).toBe(false);
    await tick(400);
    expect(d2()).toBe(true);
  });

  it('打勾停一拍期间（useHoldView 留着那一份）不走，停完就走', async () => {
    const h = renderHook(() => useHoldView(0));
    act(() => h.result.current.hold());
    expect(h.result.current.holding).toBe(true);
    const done = start();
    await tick(100);
    expect(done()).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(h.result.current.holding).toBe(false);
    await tick(200);
    expect(done()).toBe(true);
  });

  it('一直按着：等满 PRELOAD_MAX_WAIT_MS 照样走', async () => {
    window.dispatchEvent(new Event('pointerdown'));
    const done = start();
    await tick(PRELOAD_MAX_WAIT_MS - 200);
    expect(done()).toBe(false);
    await tick(400);
    expect(done()).toBe(true);
  });
});
