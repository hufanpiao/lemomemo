// hash 路由（架构 2.0）：/app/#/notes/abc
import { describe, expect, it } from 'vitest';
import { canGoBack, DEFAULT_ROUTE, hrefOf, navigate, parseHash, replaceRoute, ROUTE_NAMES } from '../router.ts';
import { replaceAddress } from '../router-levels.ts';
import { featureRoutes } from '../features.ts';

describe('router', () => {
  it('parseHash', () => {
    expect(parseHash('#/notes/abc')).toEqual({ name: 'notes', params: ['abc'] });
    expect(parseHash('#/today')).toEqual({ name: 'today', params: [] });
    expect(parseHash('')).toEqual(DEFAULT_ROUTE);
    expect(parseHash('#/nope')).toEqual(DEFAULT_ROUTE);
    expect(parseHash('#/notes/a%2Fb')).toEqual({ name: 'notes', params: ['a/b'] });
    // 设置的二级页挂在 settings 下（注销、日历 R-320），不另起路由名
    expect(parseHash('#/settings/calendar')).toEqual({ name: 'settings', params: ['calendar'] });
    expect(hrefOf('settings', 'calendar')).toBe('#/settings/calendar');
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

describe('canGoBack（代码审查 S11）、replaceAddress（S7）', () => {
  it('进 App 的第一页没有上一页（哪怕 history.length > 1）；navigate 压一条后有；replaceRoute 不改深度', async () => {
    window.history.replaceState(null, '', '/app/#/today');
    window.history.pushState(null, '', '/app/#/today');
    expect(window.history.length).toBeGreaterThan(1);
    expect(canGoBack()).toBe(false);
    await navigate('todos');
    expect(canGoBack()).toBe(true);
    await replaceRoute('settings');
    expect(canGoBack()).toBe(true);
    expect(window.location.hash).toBe('#/settings');
  });

  it('replaceAddress：只换地址、不压历史、深度不变', async () => {
    window.history.replaceState(null, '', '/app/#/today');
    await navigate('todo', 'new');
    const len = window.history.length;
    replaceAddress('todo', '00000000-0000-4000-8000-000000000001');
    expect(window.location.hash).toBe('#/todo/00000000-0000-4000-8000-000000000001');
    expect(window.history.length).toBe(len);
    expect(canGoBack()).toBe(true);
    window.history.replaceState(null, '', '/app/#/today');
    replaceAddress('todos');
    expect(canGoBack()).toBe(false);
  });
});
