// SW 路由（架构 15.3 第 1 条、16.1；TC-B0-40）：/sb/*、/files/*（0.32）一律直连不缓存；作用域只有 /app/
import { describe, expect, it } from 'vitest';
import { APP_SCOPE, NAV_DENYLIST, NETWORK_ONLY_PREFIXES, excludedFromPrecache, isNetworkOnly, routeOf } from '../routes.ts';

const ORIGIN = 'https://lemomemo.com';
const r = (path: string, method = 'GET', mode = 'cors', origin = ORIGIN) => routeOf(new URL(path, origin), method, mode, ORIGIN);

describe('routeOf', () => {
  it('/sb/* 一律直连（GET、导航、带查询串都一样）', () => {
    expect(r('/sb/rest/v1/events?select=*')).toBe('bypass');
    expect(r('/sb/auth/v1/user', 'GET', 'navigate')).toBe('bypass');
    expect(r('/sb')).toBe('bypass');
  });

  it('/files/* 一律直连（0.32：签名链接、上传、批量签名都不进 Cache Storage）', () => {
    expect(r('/files/v1/o/images/00000000-0000-4000-8000-000000000001/a/b.webp?e=1&d=&s=x')).toBe('bypass');
    expect(r('/files/v1/o/files/u/n/i.pdf?e=1&d=a.pdf&s=x', 'GET', 'navigate')).toBe('bypass');
    expect(r('/files/v1/sign', 'POST')).toBe('bypass');
    expect(r('/files/v1/o/images/u/n/i.webp', 'PUT')).toBe('bypass');
    expect(r('/files')).toBe('bypass');
  });

  it('只走网络的前缀表：正好是 /sb 和 /files，按路径段比', () => {
    expect([...NETWORK_ONLY_PREFIXES].sort()).toEqual(['/files', '/sb']);
    expect(isNetworkOnly('/files/v1/sign')).toBe(true);
    expect(isNetworkOnly('/sb')).toBe(true);
    expect(isNetworkOnly('/filesx/a')).toBe(false);
    expect(isNetworkOnly('/app/files/a.js')).toBe(false);
    expect(r('/app/files/a.js')).toBe('precache-or-network');
  });

  it('非 GET、别的源、/app/ 以外一律直连', () => {
    expect(r('/app/x.js', 'POST')).toBe('bypass');
    expect(r('/app/x.js', 'GET', 'cors', 'https://cdn.example.com')).toBe('bypass');
    expect(r('/')).toBe('bypass');
    expect(r('/application/x')).toBe('bypass');
  });

  it('/sbx 不算 /sb（前缀要按路径段比）', () => {
    expect(r('/sbx/a')).toBe('bypass'); // 不在 /app/ 下，本来就直连
    expect(r('/app/sb/a.js')).toBe('precache-or-network');
  });

  it('/app/ 下：导航、节假日、字体、其他静态文件', () => {
    expect(APP_SCOPE).toBe('/app/');
    expect(r('/app/', 'GET', 'navigate')).toBe('navigation');
    expect(r('/app/holidays/kr/2026.json')).toBe('holidays');
    expect(r('/app/fonts/a.woff2')).toBe('fonts');
    expect(r('/app/assets/index-abc.js')).toBe('precache-or-network');
  });
});

describe('diag/ 技术页（机型信息页、倾斜授权试验页）不归 SW 管', () => {
  it('导航和子资源一律直连：第一个 fetch 监听器放过，不进 lemo-nav 也不进任何缓存', () => {
    for (const p of ['/app/diag/tilt.html', '/app/diag/tilt', '/app/diag/startup.html', '/app/diag/startup']) {
      expect(r(p, 'GET', 'navigate'), p).toBe('bypass');
    }
    for (const p of ['/app/diag/tilt.js', '/app/diag/tilt.css', '/app/diag/startup.js']) expect(r(p), p).toBe('bypass');
    // 只按目录比：/app/diagx、首页带 ?diag=1（机型信息页读首页用）不受影响
    expect(r('/app/diagx/a', 'GET', 'navigate')).toBe('navigation');
    expect(r('/app/index.html?diag=1')).toBe('precache-or-network');
  });

  it('NavigationRoute 的 denylist：排除预览沙箱两种写法和 diag/，App 页面照常走外壳', () => {
    const denied = (path: string) => NAV_DENYLIST.some((re) => re.test(path));
    for (const p of ['/app/preview', '/app/preview.html', '/app/diag/tilt.html', '/app/diag/tilt', '/app/diag/startup.html']) {
      expect(denied(p), p).toBe(true);
    }
    for (const p of ['/app/', '/app/index.html', '/app/auth/', '/app/previewx', '/app/diagx/a']) expect(denied(p), p).toBe(false);
  });
});

describe('excludedFromPrecache', () => {
  it('sw.js、节假日、字体、iOS 启动图、机型信息页和倾斜授权试验页（diag/）、source map、version.json 不进预缓存', () => {
    for (const p of ['sw.js', 'holidays/cn/2026.json', 'fonts/a.woff2', 'icons/startup/startup-1170x2532.png', 'diag/startup.html', 'diag/startup.js', 'diag/startup.css', 'diag/tilt.html', 'diag/tilt.js', 'diag/tilt.css', 'assets/a.js.map', 'version.json', '.vite/manifest.json']) {
      expect(excludedFromPrecache(p), p).toBe(true);
    }
    for (const p of ['index.html', 'assets/index-abc.js', 'assets/index-abc.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png']) {
      expect(excludedFromPrecache(p), p).toBe(false);
    }
  });
});
