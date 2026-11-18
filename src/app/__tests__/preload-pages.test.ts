// 冷启动后台先下载三个页签页（负责人 11-18“冷启动后马上后台自动加载这3个页面，不用点进去的时候再加载”）和设置页（负责人 11-18“把设置页也一起缓存一下”）：
// 只有日历、待办、随手记、设置四页写了 preload；preloadPages 一页一页下载、记运行日志，失败不抛
import { describe, expect, it, vi } from 'vitest';
import { featureRoutes, mountFeatures, preloadPages, warmRoute } from '../features.ts';

// “＋”打开打字条时先下载“展开编辑”要进的新建页（负责人 11-18 录屏第一次展开卡约 0.4 秒）：只有日程、待办编辑页写了 warm，不进冷启动的 preload
describe('warmRoute', () => {
  it('写了 warm 的正好是日程、待办编辑页', () => {
    mountFeatures(null);
    expect(featureRoutes.filter((r) => r.warm).map((r) => r.name).sort()).toEqual(['event', 'todo']);
  });

  it('下载一次、记一行 warm <页>；没写 warm 的页不动、不记', async () => {
    mountFeatures(null);
    const r = featureRoutes.find((x) => x.name === 'event');
    const spy = vi.spyOn(r as { warm: () => Promise<unknown> }, 'warm').mockResolvedValue(undefined);
    const logs: string[] = [];
    await warmRoute('event', (l) => logs.push(l), () => 0);
    await warmRoute('note', (l) => logs.push(l), () => 0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(['warm event ms=0 ok=1']);
  });
});

describe('preloadPages', () => {
  it('写了 preload 的正好是日历、待办、随手记三个页签页和设置页', () => {
    mountFeatures(null);
    expect(featureRoutes.filter((r) => r.preload).map((r) => r.name).sort()).toEqual(['calendar', 'notes', 'settings', 'todos']);
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
    expect(logs.filter((l) => l.endsWith('ok=1'))).toHaveLength(3);
  });

  it('功能开关关着（没挂上）的页不下载', () => {
    mountFeatures(new Set(['event']));
    expect(featureRoutes.filter((r) => r.preload).map((r) => r.name)).toEqual(['calendar', 'settings']);
    mountFeatures(null);
  });
});
