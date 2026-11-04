// 动效功能包下载失败（B2 FA-6 ②，src/motion/features.ts）：不抛（LazyMotion 的 then 没接 catch，抛了就是未处理的拒绝），
// 这一次一直不到、motionFeaturesReady() 保持 false（元素照常显示、只是没有动画）；下一次调用重新下载，成功了就到
import { describe, expect, it, vi } from 'vitest';

const chunk = vi.hoisted(() => ({ fail: true, loads: 0 }));
vi.mock('../feature-bundle.ts', async () => {
  chunk.loads += 1;
  if (chunk.fail) throw new Error('Failed to fetch dynamically imported module');
  const { domMax } = await import('motion/react');
  return { default: domMax };
});

const { loadMotionFeatures, motionFeatures, motionFeaturesReady } = await import('../features.ts');

describe('功能包下载失败', () => {
  it('不抛、一直不到；下一次重新下载，成功了就到', async () => {
    const settled = vi.fn();
    void loadMotionFeatures().then(settled, settled);
    await vi.waitFor(() => expect(chunk.loads).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
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
