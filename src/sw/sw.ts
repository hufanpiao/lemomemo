// Service Worker（架构 8.1）：scope /app/；预缓存 App 的全部产物，装好以后离线也能打开
// /sb/*、/files/*（0.32）一律直连、不缓存：第一个 fetch 监听器直接放过，后面的 Workbox 路由也不会匹配到（15.3 第 1 条，S-B0）
// 新版本：只在后台下载，等页面提示“有新版本 · 重新打开”后由页面发 SKIP_WAITING（B1 接界面）
// 不存用户数据（接手清单 K-sw-seal）：运行时缓存只有下面三个公共的（节假日、字体分片、字体清单；页面导航不缓存）；IndexedDB 只在 ./pending.ts 里按 K-sw-seal 写 pending_actions
//（只写已存在、owner 一致的库，开库监听 versionchange 立刻关），见 tests/build/sw-no-user-data.test.ts
// 推送（架构 5.3，B2）：push、notificationclick、notificationclose 的处理在 ./push.ts
import { cleanupOutdatedCaches, PrecacheController, PrecacheRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, NetworkOnly } from 'workbox-strategies';
import { keepPreviousAssets, PREV_ASSETS_DIR } from './keep-prev.ts';
import { handleNotificationClick, handlePush, type SwLike } from './push.ts';
import { NAV_DENYLIST, routeOf } from './routes.ts';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

// 必须最先注册：不归 SW 管的请求在这里放过，不调用 respondWith，浏览器按原样走网络
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (routeOf(url, event.request.method, event.request.mode, self.location.origin) === 'bypass') {
    event.stopImmediatePropagation();
  }
});

self.addEventListener('message', (event) => {
  const data: unknown = event.data;
  if (typeof data === 'object' && data !== null && 'type' in data && data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

// 推送和通知（./push.ts）。负载解不开时 event.data.json() 会抛：当成 null，照样显示一条通知
const swLike: SwLike = {
  registration: self.registration,
  clients: {
    // 只要窗口：type: 'window' 时浏览器只回 WindowClient
    matchAll: async (o) => (await self.clients.matchAll(o)) as readonly WindowClient[],
    openWindow: (url) => self.clients.openWindow(url),
  },
  location: self.location,
  indexedDB: self.indexedDB,
  now: () => Date.now(),
  uuid: () => crypto.randomUUID(),
  get languages() {
    return self.navigator.languages;
  },
};

self.addEventListener('push', (event) => {
  let raw: unknown = null;
  try {
    raw = event.data?.json() ?? null;
  } catch {
    raw = null;
  }
  event.waitUntil(handlePush(swLike, raw));
});

self.addEventListener('notificationclick', (event) => {
  event.waitUntil(handleNotificationClick(swLike, event.notification, event.action).then(() => undefined));
});

// 用户划掉通知：不算“知道了”，什么都不写（到点没处理的照样进“错过的提醒”，5.9）。
// 故意空着、不是死代码：表明“划掉”这件事有意不处理；tests/build/sw-no-user-data.test.ts 的事件白名单把它列在里面，删了那条测试会失败
self.addEventListener('notificationclose', () => undefined);

// 预缓存：不用 precacheAndRoute，改用它背后同一套公开的 PrecacheController + PrecacheRoute（缓存名、cacheKey、安装、路由都和原来一样，
// 已装好的设备不用重下）。只为了自己排 activate 的先后：先把上一版的分包挪出来（./keep-prev.ts），再让 workbox 清预缓存（同步层审查第 6 条之二）
cleanupOutdatedCaches();
const precache = new PrecacheController();
precache.addToCacheList(self.__WB_MANIFEST);
self.addEventListener('install', precache.install);
registerRoute(new PrecacheRoute(precache));

// 上一版独有的分包（/app/assets/ 下、这一版预缓存里没有的）：先查 lemo-prev-assets，没有再联网；从不往里写（只由激活时挪进去）。
// 给“别的标签页按了重新打开、本页还在跑上一版代码”时按需加载用；只留一版，见 ./keep-prev.ts
const prevAssets = new CacheFirst({ cacheName: 'lemo-prev-assets', plugins: [{ cacheWillUpdate: () => Promise.resolve(null) }] });

// 11-14 以前的版本导航用过的运行时缓存，里面是旧版 index.html：不再用，激活时删掉（同步层审查第 6 条）
const RETIRED_NAV_CACHE = 'lemo-nav';
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.caches.delete(RETIRED_NAV_CACHE);
      // 挪失败（例如空间不够）也照样往下清预缓存：只是这次旧页拿不到上一版分包，预缓存不跟着越积越多
      await keepPreviousAssets(self.caches, {
        precacheName: precache.strategy.cacheName,
        current: new Set(precache.getURLsToCacheKeys().values()),
        prevName: prevAssets.cacheName,
      }).catch(() => 0);
      await precache.activate(event);
    })(),
  );
});

// 页面导航（/app/、/app/auth/ 这类在预缓存里的地址上面 PrecacheRoute 已经接走，到这里的是带查询串、不在预缓存里的）：
// 只走网络（3 秒超时），失败回预缓存的 index.html——它和当前 SW 的预缓存一定是同一版，引用的分包都在。
// 不缓存导航响应（同步层审查第 6 条，11-14）：原来用 NetworkFirst 存进 lemo-nav，那份没有版本号，新 SW 接管、旧预缓存清掉以后，
// 弱网、离线时会拿到旧版 index.html，它引用的旧分包预缓存里、线上都没有了 → 白屏。tests/build/sw-nav-shell.test.ts
const shell = precache.createHandlerBoundToURL('/app/index.html');
const navNetwork = new NetworkOnly({ networkTimeoutSeconds: 3 });
registerRoute(
  new NavigationRoute(
    async (opts) => {
      try {
        return await navNetwork.handle(opts);
      } catch {
        return shell(opts);
      }
    },
    // 预览沙箱不走 App 外壳；名单在 routes.ts（diag 技术页 10-30 起在 /app/ 作用域外的 /diag/，SW 管不到）
    { allowlist: [/^\/app\//], denylist: [...NAV_DENYLIST] },
  ),
);

registerRoute(
  ({ url, request }) => routeOf(url, request.method, request.mode, self.location.origin) === 'holidays',
  new NetworkFirst({ cacheName: 'lemo-holidays' }),
);

registerRoute(
  ({ url, request }) => routeOf(url, request.method, request.mode, self.location.origin) === 'fonts',
  new CacheFirst({ cacheName: 'lemo-fonts' }),
);

// 可选字体清单：先联网、失败用缓存（不进预缓存，routes.ts）；单独一个缓存，platform/fonts.ts 清 lemo-fonts 时不会把它删掉
registerRoute(
  ({ url, request }) => routeOf(url, request.method, request.mode, self.location.origin) === 'font-index',
  new NetworkFirst({ cacheName: 'lemo-font-index' }),
);

// 上一版独有的分包（prevAssets，见上）：排在 PrecacheRoute 后面，这一版预缓存里有的分包到不了这里
registerRoute(
  ({ url, request }) =>
    routeOf(url, request.method, request.mode, self.location.origin) === 'precache-or-network' && url.pathname.startsWith(PREV_ASSETS_DIR),
  prevAssets,
);
