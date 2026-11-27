// 违规 A19：在 sw.ts 里另给 /files 挂了缓存路由（第 4 行），绕开 routes.ts 的前缀表
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
registerRoute(({ url }) => url.pathname.startsWith('/files/'), new CacheFirst({ cacheName: 'x' }));
// 注释里写 '/files/' 不算；/filesystem 也不算
export const FILESYSTEM = '/filesystem';
