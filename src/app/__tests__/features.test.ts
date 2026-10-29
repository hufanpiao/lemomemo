// 功能入口按开关挂（架构 0.27 第 4 点、TC-B1-50）：flags 为 null 全挂；关掉的开关只藏入口
import { describe, expect, it } from 'vitest';
import { featureRoutes, mountFeatures, offRoutes, offRoutesFor, routesFor } from '../features.ts';

const names = (r: readonly { name: string }[]): string[] => r.map((x) => x.name).sort();

describe('routesFor / mountFeatures', () => {
  it('flags 为 null（本机还没缓存 config）：全挂', () => {
    expect(names(routesFor(null))).toEqual(expect.arrayContaining(['today', 'calendar', 'todos', 'notes', 'anniv', 'settings']));
  });

  it('note 关、其余开：随手记不挂；今天、设置、隐私记这些不受开关管的照挂', () => {
    const r = names(routesFor(new Set(['event', 'todo', 'anniv'])));
    expect(r).not.toContain('notes');
    expect(r).toEqual(expect.arrayContaining(['today', 'calendar', 'todos', 'anniv', 'settings', 'vault']));
  });

  it('mountFeatures 改的是 App 读的那份', () => {
    mountFeatures(new Set(['note']));
    expect(names(featureRoutes)).toContain('notes');
    expect(names(featureRoutes)).not.toContain('calendar');
    mountFeatures(null);
    expect(names(featureRoutes)).toContain('calendar');
  });

  it('L11：关着的开关对应的路由记进 offRoutes（App 显示“此功能未开启”，不显示出错页）；flags 为 null 时没有', () => {
    expect([...offRoutesFor(new Set(['event', 'todo', 'anniv']))]).toEqual(expect.arrayContaining(['notes']));
    expect(offRoutesFor(new Set(['event', 'todo', 'anniv'])).has('today')).toBe(false);
    expect(offRoutesFor(null).size).toBe(0);
    mountFeatures(new Set(['event']));
    expect(offRoutes.has('todos')).toBe(true);
    mountFeatures(null);
    expect(offRoutes.size).toBe(0);
  });
});
