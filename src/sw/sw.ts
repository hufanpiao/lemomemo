// Service Worker（架构 8.1）：scope /app/；预缓存 App 的全部产物，装好以后离线也能打开
// /sb/* 一律直连、不缓存：第一个 fetch 监听器直接放过，后面的 Workbox 路由也不会匹配到（15.3 第 1 条，S-B0）
// 新版本：只在后台下载，等页面提示“有新版本 · 重新打开”后由页面发 SKIP_WAITING（B1 接界面）
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';
import { routeOf } from './routes.ts';

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

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// 页面导航：先联网（3 秒超时），失败用预缓存的 index.html
const shell = createHandlerBoundToURL('/app/index.html');
const navNetwork = new NetworkFirst({ cacheName: 'lemo-nav', networkTimeoutSeconds: 3 });
registerRoute(
  new NavigationRoute(
    async (opts) => {
      try {
        return await navNetwork.handle(opts);
      } catch {
        return shell(opts);
      }
    },
    // 预览沙箱不走 App 外壳；Pages 会把 preview.html 308 到 /app/preview，两种写法都排除
    { allowlist: [/^\/app\//], denylist: [/^\/app\/preview(\.html)?$/] },
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
