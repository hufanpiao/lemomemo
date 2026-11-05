// 动效功能包下载失败（B2 FA-6 ②，src/motion/features.ts）：不抛（LazyMotion 的 then 没接 catch，抛了就是未处理的拒绝），
// 这一次一直不到、motionFeaturesReady() 保持 false（元素照常显示、只是没有动画）；下一次调用重新下载，成功了就到
// • 不按墙钟等（接手清单 MOTION-wallclock-tests；代码审查 K8-newItem 重构 M6 的同类）：原来真 setTimeout 等 30 ms、
//   成功那次在用例里才第一次加载 motion/react，12 份并发时这一步能拖过 5 秒的用例超时。现在 motion/react 在模块顶层先加载好
//   （不算进用例时间），“等一会儿看它有没有落定”改成假时钟往前推 30 ms（advanceTimersByTimeAsync 会把其间的微任务都跑完）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAKE } from './fake-frames.ts';

const chunk = vi.hoisted(() => ({ fail: true, loads: 0 }));
vi.mock('../feature-bundle.ts', async () => {
  chunk.loads += 1;
  if (chunk.fail) throw new Error('Failed to fetch dynamically imported module');
  const { domMax } = await import('motion/react');
  return { default: domMax };
});

await import('motion/react');   // 先加载好，成功那次的 import 只是取缓存
const { loadMotionFeatures, motionFeatures, motionFeaturesReady } = await import('../features.ts');

afterEach(() => {
  vi.useRealTimers();
});

describe('功能包下载失败', () => {
  it('不抛、一直不到；下一次重新下载，成功了就到', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    const settled = vi.fn();
    void loadMotionFeatures().then(settled, settled);
    await vi.advanceTimersByTimeAsync(30);
    expect(chunk.loads).toBe(1);
    expect(settled, '失败的那一次既不 resolve 也不 reject').not.toHaveBeenCalled();
    expect(motionFeaturesReady()).toBe(false);
    expect(typeof motionFeatures(), '还给加载函数').toBe('function');

    chunk.fail = false;
    const bundle = await loadMotionFeatures();
    expect(chunk.loads).toBeGreaterThanOrEqual(2);
    expect(bundle).toBeTruthy();
    expect(motionFeaturesReady()).toBe(true);
    expect(typeof motionFeatures()).toBe('object');
  });
});
