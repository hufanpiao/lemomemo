// TC-B1-130 前端一侧：导出的数据（start、各分片响应、拼好的 .json.gz）不进 Service Worker 的任何 Cache Storage
// 导出请求是 POST <supabaseUrl>/functions/v1/account（正式版 supabaseUrl = https://lemomemo.com/sb，预览是 <预览源>/sb）；
// 拼好的文件只在页面里做成 blob: 链接下载（platform/save-file.ts），不发网络请求、不经 SW 的 fetch 事件。
// 下面两层核对：① routes.ts 的路由判断对导出的各种写法都是 bypass；② 真把 sw.ts 装进替身环境，
// 导出请求在第一个 fetch 监听器就被放过（不 respondWith），注册的每条缓存路由（导航、节假日、字体）都匹配不到它
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_FN } from '../../src/features/settings/data/account-api.ts';
import { routeOf } from '../../src/sw/routes.ts';

const ORIGIN = 'https://lemomemo.com';
const PROD_SUPABASE = `${ORIGIN}/sb`;
const EXPORT_URL = `${PROD_SUPABASE}/functions/v1/${ACCOUNT_FN}`;

describe('routes.ts：导出请求一律 bypass', () => {
  it('正式版导出地址：POST、GET、导航、带查询串都直连', () => {
    const u = new URL(EXPORT_URL);
    expect(u.pathname).toBe('/sb/functions/v1/account');
    for (const [method, mode] of [['POST', 'cors'], ['GET', 'cors'], ['GET', 'navigate'], ['GET', 'no-cors'], ['HEAD', 'cors']] as const) {
      expect(routeOf(u, method, mode, ORIGIN), `${method} ${mode}`).toBe('bypass');
    }
    expect(routeOf(new URL(`${EXPORT_URL}?step=part&cursor=abc`), 'GET', 'cors', ORIGIN)).toBe('bypass');
  });

  it('预览站、本机真后端（同源 /sb）同样直连', () => {
    for (const origin of ['https://preview.lemomemo.pages.dev', 'http://127.0.0.1:8789']) {
      const u = new URL(`${origin}/sb/functions/v1/${ACCOUNT_FN}`);
      expect(routeOf(u, 'POST', 'cors', origin)).toBe('bypass');
      expect(routeOf(u, 'GET', 'cors', origin)).toBe('bypass');
    }
  });

  it('拼好文件的 blob: 链接即使被当成请求也不进 /app/ 的缓存路由', () => {
    const u = new URL(`blob:${ORIGIN}/0f8fad5b-d9cb-469f-a165-70867728950e`);
    expect(routeOf(u, 'GET', 'navigate', ORIGIN)).toBe('bypass');
    expect(routeOf(u, 'GET', 'cors', ORIGIN)).toBe('bypass');
  });
});

// ---- 把 sw.ts 装进替身环境 ----

type Matcher = (o: { url: URL; request: { method: string; mode: string } }) => boolean;
const reg = vi.hoisted(() => ({
  matchers: [] as Array<(o: { url: URL; request: { method: string; mode: string } }) => boolean>,
  navs: [] as Array<{ allowlist: RegExp[]; denylist: RegExp[] }>,
  strategies: [] as string[],
}));

vi.mock('workbox-precaching', () => ({
  cleanupOutdatedCaches: () => undefined,
  precacheAndRoute: () => undefined,
  createHandlerBoundToURL: () => () => Promise.resolve(new Response('')),
}));
vi.mock('workbox-routing', () => ({
  NavigationRoute: class {
    constructor(_h: unknown, o: { allowlist: RegExp[]; denylist: RegExp[] }) {
      reg.navs.push(o);
    }
  },
  registerRoute: (m: unknown) => {
    if (typeof m === 'function') reg.matchers.push(m as Matcher);
  },
}));
vi.mock('workbox-strategies', () => {
  class S {
    constructor(o: { cacheName: string }) {
      reg.strategies.push(o.cacheName);
    }
  }
  return { CacheFirst: S, NetworkFirst: S };
});

type Listener = (e: unknown) => void;

describe('sw.ts：导出请求不进任何缓存', () => {
  const listeners: Record<string, Listener[]> = {};

  beforeEach(async () => {
    vi.resetModules();
    reg.matchers.length = 0;
    reg.navs.length = 0;
    reg.strategies.length = 0;
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.stubGlobal('self', {
      __WB_MANIFEST: [],
      location: { origin: ORIGIN },
      skipWaiting: () => Promise.resolve(),
      addEventListener: (t: string, fn: Listener) => {
        (listeners[t] ??= []).push(fn);
      },
    });
    // 用变量路径：sw.ts 按 webworker 类型写（tsconfig.sw.json），不让测试这边的 tsconfig 去解析它
    const swPath = '../../src/sw/sw.ts';
    await import(/* @vite-ignore */ swPath);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fire(url: string, method: string, mode: string) {
    const ev = {
      request: { url, method, mode },
      stopImmediatePropagation: vi.fn(),
      respondWith: vi.fn(),
    };
    for (const fn of listeners.fetch ?? []) fn(ev);
    return ev;
  }

  it('运行时缓存只有三个公共的，装好后有导航、节假日、字体三条路由', () => {
    expect([...reg.strategies].sort()).toEqual(['lemo-fonts', 'lemo-holidays', 'lemo-nav']);
    expect(reg.matchers).toHaveLength(2);
    expect(reg.navs).toHaveLength(1);
  });

  it('导出的 start、part 请求在第一个 fetch 监听器就放过：不 respondWith，后面的路由收不到', () => {
    for (const body of ['start', 'part']) {
      const ev = fire(EXPORT_URL, 'POST', 'cors');
      expect(ev.stopImmediatePropagation, body).toHaveBeenCalledTimes(1);
      expect(ev.respondWith, body).not.toHaveBeenCalled();
    }
    const nav = fire(EXPORT_URL, 'GET', 'navigate');
    expect(nav.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(nav.respondWith).not.toHaveBeenCalled();
  });

  it('就算放过失效，节假日、字体两条缓存路由也匹配不到导出地址', () => {
    const url = new URL(EXPORT_URL);
    for (const m of reg.matchers) {
      for (const [method, mode] of [['POST', 'cors'], ['GET', 'cors'], ['GET', 'navigate']] as const) {
        expect(m({ url, request: { method, mode } })).toBe(false);
      }
    }
  });

  it('导航缓存（lemo-nav）只收 /app/ 下的页面，导出地址不在 allowlist 里', () => {
    const [nav] = reg.navs;
    const path = new URL(EXPORT_URL).pathname;
    expect(nav?.allowlist.some((re) => re.test(path))).toBe(false);
  });

  it('对照：/app/ 下的普通页面导航不会被放过（说明上面的放过不是“什么都放”）', () => {
    const ev = fire(`${ORIGIN}/app/`, 'GET', 'navigate');
    expect(ev.stopImmediatePropagation).not.toHaveBeenCalled();
  });
});
