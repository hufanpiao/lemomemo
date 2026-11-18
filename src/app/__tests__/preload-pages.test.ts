// 冷启动后台先下载三个页签页（负责人 11-18“冷启动后马上后台自动加载这3个页面，不用点进去的时候再加载”）：
// 只有日历、待办、随手记三页写了 preload；preloadPages 一页一页下载、记运行日志，失败不抛
import { describe, expect, it, vi } from 'vitest';
import { featureRoutes, mountFeatures, preloadPages } from '../features.ts';

describe('preloadPages', () => {
  it('写了 preload 的正好是日历、待办、随手记三个页签页', () => {
    mountFeatures(null);
    expect(featureRoutes.filter((r) => r.preload).map((r) => r.name).sort()).toEqual(['calendar', 'notes', 'todos']);
  });

  it('一页一页下载、每页记一行运行日志；某页失败照样往下走，不抛', async () => {
    mountFeatures(null);
    const order: string[] = [];
    for (const r of featureRoutes) {
      if (!r.preload) continue;
      const name = r.name;
      vi.spyOn(r, 'preload').mockImplementation(() => {
        order.push(name);
        return name === 'todos' ? Promise.reject(new Error('offline')) : Promise.resolve();
      });
    }
    const logs: string[] = [];
    await preloadPages((l) => logs.push(l), () => 0);
    expect(order).toEqual(featureRoutes.filter((r) => r.preload).map((r) => r.name));
    expect(logs).toContain('preload todos ms=0 ok=0');
    expect(logs.filter((l) => l.endsWith('ok=1'))).toHaveLength(2);
  });

  it('功能开关关着（没挂上）的页不下载', () => {
    mountFeatures(new Set(['event']));
    expect(featureRoutes.filter((r) => r.preload).map((r) => r.name)).toEqual(['calendar']);
    mountFeatures(null);
  });
});
