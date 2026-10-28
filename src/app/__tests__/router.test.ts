// hash 路由（架构 2.0）：/app/#/notes/abc
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE, hrefOf, parseHash, ROUTE_NAMES } from '../router.ts';
import { featureRoutes } from '../features.ts';

describe('router', () => {
  it('parseHash', () => {
    expect(parseHash('#/notes/abc')).toEqual({ name: 'notes', params: ['abc'] });
    expect(parseHash('#/today')).toEqual({ name: 'today', params: [] });
    expect(parseHash('')).toEqual(DEFAULT_ROUTE);
    expect(parseHash('#/nope')).toEqual(DEFAULT_ROUTE);
    expect(parseHash('#/notes/a%2Fb')).toEqual({ name: 'notes', params: ['a/b'] });
  });

  it('hrefOf 和 parseHash 互逆（参数会转义）', () => {
    const h = hrefOf('notes', 'a/b c');
    expect(h).toBe('#/notes/a%2Fb%20c');
    expect(parseHash(h)).toEqual({ name: 'notes', params: ['a/b c'] });
  });

  it('功能登记表里的路由名都在 ROUTE_NAMES 里、不重复', () => {
    const names = featureRoutes.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(ROUTE_NAMES).toContain(n);
  });
});
