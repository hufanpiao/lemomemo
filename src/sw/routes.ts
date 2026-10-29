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

/**
 * 技术页目录（机型信息页、倾斜授权试验页）：SW 一律放过，不走 App 外壳、不进 lemo-nav 等任何缓存。
 * 装过 App SW 的 Safari 打开这些页时，不能把它们写进缓存（下次读到旧版，或离线时冒出旧页面）。
 */
export const DIAG_PREFIX = `${APP_SCOPE}diag/`;

/** 不走 App 外壳的导航（sw.ts 的 NavigationRoute denylist）：预览沙箱（Pages 会把 preview.html 308 到 /app/preview，两种写法都排除）、diag/ */
export const NAV_DENYLIST: readonly RegExp[] = [/^\/app\/preview(\.html)?$/, /^\/app\/diag\//];

export type SwRoute = 'bypass' | 'navigation' | 'holidays' | 'fonts' | 'precache-or-network';

/**
 * 一个请求归哪条路：
 * - /sb/*（数据接口转发）、/files/*（照片和附件，0.32）、别的源、非 GET：一律直连，SW 不碰、不缓存（15.3 第 1 条）
 * - /app/diag/*（机型信息页、倾斜授权试验页）：同样直连，导航也不进 lemo-nav
 * - /app/ 下的页面导航：先联网、3 秒超时用缓存
 * - /app/holidays/*.json：先联网、失败用缓存（5.4）
 * - /fonts/*（R-128 选中的字体分片）：单独的运行时缓存（5.9c，B6 接）
 */
export function routeOf(url: URL, method: string, mode: string, selfOrigin: string): SwRoute {
  if (method !== 'GET') return 'bypass';
  if (url.origin !== selfOrigin) return 'bypass';
  if (isNetworkOnly(url.pathname)) return 'bypass';
  if (!url.pathname.startsWith(APP_SCOPE)) return 'bypass';
  if (url.pathname.startsWith(DIAG_PREFIX)) return 'bypass';
  if (mode === 'navigate') return 'navigation';
  if (url.pathname.startsWith(`${APP_SCOPE}holidays/`)) return 'holidays';
  if (url.pathname.startsWith(`${APP_SCOPE}fonts/`)) return 'fonts';
  return 'precache-or-network';
}

/**
 * 预缓存清单里不放的文件（注入清单的脚本和测试共用）。
 * icons/startup/：iOS 启动图 12 张共约 13 MB，iOS 只在“添加到主屏幕”时按 media 取自己那一张、由系统保存，不经 SW，预缓存只会让每个用户白下；
 * 添加时断网取不到，iOS 退回 manifest 的 background_color 纯色（R-232；架构 8.1 SW 缓存策略、0.38 第 63 条）
 * “不经 SW”尚待实机清单 P1-07 第 4、5 步核对；结果相反时回来改这里和架构那两处
 * diag/：机型信息页（P1-07 第 1、2 步用的技术页，只在联网时用），不是 App 外壳，不让每个用户都下（架构 8.1、0.38 第 63 条）
 */
export function excludedFromPrecache(path: string): boolean {
  return (
    path === 'sw.js' ||
    path.startsWith('holidays/') ||
    path.startsWith('fonts/') ||
    path.startsWith('icons/startup/') ||
    path.startsWith('diag/') ||
    path.startsWith('.vite/') ||
    path.endsWith('.map') ||
    path === 'version.json'
  );
}
