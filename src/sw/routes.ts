// SW 的路由判断（纯函数，单元测试覆盖；架构 8.1、15.3 第 1 条）
// A19：sw 只能 import shared 和 workbox

export const APP_SCOPE = '/app/';

/**
 * 只走网络、绝不进 Cache Storage 的路径前缀（15.3 第 1 条，S-B0；check_arch 的 A19 核对这张表里有 /sb 和 /files）：
 * - /sb：数据接口转发（14.2 第 1 点）
 * - /files：照片和附件的上传、签名、取对象（0.32，R-213；带签名的链接不能留在缓存里，离线时要失败而不是读到旧的）
 */
export const NETWORK_ONLY_PREFIXES = ['/sb', '/files'] as const;

/** 按路径段比：/sb、/sb/… 算，/sbx/… 不算 */
export function isNetworkOnly(pathname: string): boolean {
  return NETWORK_ONLY_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export type SwRoute = 'bypass' | 'navigation' | 'holidays' | 'fonts' | 'precache-or-network';

/**
 * 一个请求归哪条路：
 * - /sb/*（数据接口转发）、/files/*（照片和附件，0.32）、别的源、非 GET：一律直连，SW 不碰、不缓存（15.3 第 1 条）
 * - /app/ 下的页面导航：先联网、3 秒超时用缓存
 * - /app/holidays/*.json：先联网、失败用缓存（5.4）
 * - /fonts/*（R-128 选中的字体分片）：单独的运行时缓存（5.9c，B6 接）
 */
export function routeOf(url: URL, method: string, mode: string, selfOrigin: string): SwRoute {
  if (method !== 'GET') return 'bypass';
  if (url.origin !== selfOrigin) return 'bypass';
  if (isNetworkOnly(url.pathname)) return 'bypass';
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
