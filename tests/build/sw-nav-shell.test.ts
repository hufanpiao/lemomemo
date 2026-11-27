// SW 页面导航只走网络、失败回预缓存的 index.html（同步层审查第 6 条，11-14）
// 原来导航走 NetworkFirst（cacheName lemo-nav，3 秒超时）：lemo-nav 没有版本号、cleanupOutdatedCaches 也不清它。
// 新 SW 接管、旧版预缓存被清掉以后，重新载入时网络超过 3 秒或离线，会拿到 lemo-nav 里旧版的 index.html，
// 它引用的旧版带哈希分包预缓存里、线上都没有了 → 白屏或分包加载失败。
// 改法：导航 NetworkOnly（保留 3 秒超时），失败回预缓存的 /app/index.html（createHandlerBoundToURL，和当前 SW 的预缓存一定一致）；
// 不再用 lemo-nav，activate 时删掉它。
// 注意：/app/、/app/auth/ 这类本身在预缓存里的地址由预缓存路由先接走（directoryIndex，当前 SW 的预缓存），本来就不经导航路由；
// 落到导航路由的是预缓存里没有的地址：带查询串（utm_*、fbclid 以外）、不存在的路径。下面用 /app/?src=t、/app/today 这两种。
// 做法：真的 workbox 加真的 sw.ts，替身见 ./sw-harness.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORIGIN, loadSw, stubSwGlobals, type FakeCaches, type LoadedSw } from './sw-harness.ts';

const OLD_HTML = '<!doctype html><script src="/app/assets/main-OLDHASH.js"></script>';
const NEW_HTML = '<!doctype html><script src="/app/assets/main-NEWHASH.js"></script>';

/** 预缓存里没有、会落到导航路由的地址 */
const NAV_PATH = '/app/?src=t';

/** 网络：online 回新版 index.html；hang 一直不回（弱网，超过 3 秒）；down 直接失败（离线） */
type Net = 'online' | 'hang' | 'down';

describe('SW 导航：只走网络，失败回预缓存的 index.html；lemo-nav 退役', () => {
  let caches: FakeCaches;
  let sw: LoadedSw;
  let net: Net;
  let fetched: string[];

  /** 发一次页面导航，返回拿到的 HTML */
  async function navigate(path = NAV_PATH): Promise<string> {
    // 假计时器只在导航时用：安装时 workbox 的 cachePut 要等 timeout(0)，一直假着会卡住
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const ev = sw.fetch(path, 'navigate');
      expect(ev.responded, '导航应由 SW 回').not.toBeNull();
      const p = ev.responded ?? Promise.reject(new Error('no respondWith'));
      // 网络一直不回时推进 3 秒超时：超时计时器是在几层 await 之后才挂上的，分小步推，直到有结果
      let done = false;
      const r = p.finally(() => {
        done = true;
      });
      for (let i = 0; i < 60 && !done; i++) await vi.advanceTimersByTimeAsync(100);
      return await (await r).text();
    } finally {
      vi.useRealTimers();
    }
  }

  /** 旧版 SW 的 lemo-nav：这几个地址都存着旧版 index.html */
  async function seedOldNav(): Promise<void> {
    const nav = await caches.open('lemo-nav');
    for (const path of ['/app/', NAV_PATH, '/app/today']) await nav.put(`${ORIGIN}${path}`, new Response(OLD_HTML));
  }

  beforeEach(async () => {
    net = 'online';
    fetched = [];
    caches = stubSwGlobals((u) => {
      fetched.push(u);
      if (net === 'hang') return new Promise<Response>(() => undefined);
      if (net === 'down') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(new Response(NEW_HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    });
    sw = await loadSw(caches, [{ url: '/app/index.html', revision: 'v2' }]);
    // 新 SW 安装：预缓存里放进当前版本的 index.html
    await sw.lifecycle('install');
    fetched.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('activate 以后 lemo-nav 这个缓存不存在（旧版 SW 留下的旧 index.html 一起删掉）', async () => {
    await seedOldNav();
    await sw.lifecycle('activate');
    expect(await caches.has('lemo-nav')).toBe(false);
    // 预缓存照旧在（只删 lemo-nav）
    expect([...caches.stores.keys()].some((n) => n.includes('precache'))).toBe(true);
  });

  it('lemo-nav 里有旧版 index.html、网络超过 3 秒：导航拿到预缓存里当前版本那一份', async () => {
    await sw.lifecycle('activate');
    // 就算 lemo-nav 又出现（例如旧版 SW 还在别处写）：导航也不读它
    await seedOldNav();
    net = 'hang';
    expect(await navigate()).toBe(NEW_HTML);
    expect(await navigate('/app/today')).toBe(NEW_HTML);
  });

  it('离线（请求直接失败）：同样回预缓存的 index.html', async () => {
    await sw.lifecycle('activate');
    await seedOldNav();
    net = 'down';
    expect(await navigate()).toBe(NEW_HTML);
  });

  it('在线：回网络的响应，不往任何运行时缓存里存', async () => {
    await sw.lifecycle('activate');
    const before = [...caches.stores.keys()].sort();
    expect(await navigate()).toBe(NEW_HTML);
    expect(fetched).toEqual([`${ORIGIN}${NAV_PATH}`]);
    expect([...caches.stores.keys()].sort()).toEqual(before);
    expect(await caches.has('lemo-nav')).toBe(false);
  });

  it('对照：/app/ 本身由预缓存回（不联网），lemo-nav 里的旧版碰不到它', async () => {
    await sw.lifecycle('activate');
    net = 'down';
    expect(await navigate('/app/')).toBe(NEW_HTML);
    expect(fetched).toEqual([]);
  });
});
