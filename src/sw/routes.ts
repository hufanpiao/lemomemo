// SW 的路由判断（纯函数，单元测试覆盖；架构 8.1、15.3 第 1 条）
// A19：sw 只能 import shared 和 workbox

export const APP_SCOPE = '/app/';

export type SwRoute = 'bypass' | 'navigation' | 'holidays' | 'fonts' | 'precache-or-network';

/**
 * 一个请求归哪条路：
 * - /sb/*（数据接口转发）、别的源、非 GET：一律直连，SW 不碰、不缓存（15.3 第 1 条）
 * - /app/ 下的页面导航：先联网、3 秒超时用缓存
 * - /app/holidays/*.json：先联网、失败用缓存（5.4）
 * - /fonts/*（R-128 选中的字体分片）：单独的运行时缓存（5.9c，B6 接）
 */
export function routeOf(url: URL, method: string, mode: string, selfOrigin: string): SwRoute {
  if (method !== 'GET') return 'bypass';
  if (url.origin !== selfOrigin) return 'bypass';
  if (url.pathname === '/sb' || url.pathname.startsWith('/sb/')) return 'bypass';
  if (!url.pathname.startsWith(APP_SCOPE)) return 'bypass';
  if (mode === 'navigate') return 'navigation';
  if (url.pathname.startsWith(`${APP_SCOPE}holidays/`)) return 'holidays';
  if (url.pathname.startsWith(`${APP_SCOPE}fonts/`)) return 'fonts';
  return 'precache-or-network';
}

/** 预缓存清单里不放的文件（注入清单的脚本和测试共用） */
export function excludedFromPrecache(path: string): boolean {
  return (
    path === 'sw.js' ||
    path.startsWith('holidays/') ||
    path.startsWith('fonts/') ||
    path.startsWith('.vite/') ||
    path.endsWith('.map') ||
    path === 'version.json'
  );
}
