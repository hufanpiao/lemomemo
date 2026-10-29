// SW 不存用户数据（接手清单 K-sw-seal；架构 4.1、8.1“SW 缓存策略”）
// 退出时的封存（core/account.ts 的 sealForExit）只管得到本页的库连接，管不到 SW；现在 SW 一侧没有要封存的东西，靠下面几条钉住：
// ① SW 只有三个运行时缓存：lemo-nav（/app/ 的页面导航，Pages 的静态 HTML，_routes.json 只把 /、/sb/*、/files/* 交给 Functions）、
//    lemo-holidays（公共节假日 JSON）、lemo-fonts（公共字体分片）；三个都不以预缓存前缀开头，退出、换账号、被移除时 clearCacheStorage 照样删
// ② /sb/*、/files/*、非 GET、别的源一律直连，进不了这三个缓存（routes.ts）
// ③ SW 不碰 IndexedDB、不自己发请求、不往缓存里手写，只听 fetch、message（SKIP_WAITING）两个事件；不引会用 IndexedDB 的 Workbox 模块
//    （workbox-expiration、workbox-background-sync 会把请求体存进 IndexedDB）
// B2 加通知按键（SW 写 pending_actions，0.29 续第 102 条③、第 107 条）时这里会失败：那时按 K-sw-seal 的结论做——
//    ⑴ SW 只往已经存在、且 owner 仓有 user_id 的 planner-v4 里写（打开时遇到 upgradeneeded 且 oldVersion 为 0 就中止，不建新库）；
//       推送里带的 user_id 必须和 owner 的 user_id 一致才写，不一致就丢掉——不能直接拿 owner 的值填，否则 A 账号的通知会写进 B 的库（串号）
//    ⑵ SW 打开库后必须监听 versionchange，收到就立刻 close()；否则退出 ⑤ 的删库会被 SW 的连接挡住，退出卡住
//    ⑶ 退出、换账号时退掉推送订阅，或由服务器换绑（claim_endpoint），从源头上不让旧账号的通知再推到这台设备
//    退出 ⑤ 删库以后 SW 写不进去，也不会在硬盘上建出新库。再把这里的白名单放宽，并补对应测试（含 ⑴ 串号、⑵ 删库不被挡）
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRECACHE_PREFIX } from '../../src/platform/session.ts';
import { routeOf } from '../../src/sw/routes.ts';

const SW_DIR = join(import.meta.dirname, '../../src/sw');
const RUNTIME_CACHES = ['lemo-fonts', 'lemo-holidays', 'lemo-nav'];
const ALLOWED_IMPORTS = ['./routes.ts', 'workbox-precaching', 'workbox-routing', 'workbox-strategies'];

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** src/sw 下除测试以外的全部源码（以后新加的文件也算） */
function swSources(): Array<{ name: string; code: string }> {
  return readdirSync(SW_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => ({ name: d.name, code: stripComments(readFileSync(join(SW_DIR, d.name), 'utf8')) }));
}

describe('SW 不存用户数据（K-sw-seal）', () => {
  it('运行时缓存只有 lemo-nav、lemo-holidays、lemo-fonts，且都不是预缓存（退出时会被 clearCacheStorage 删掉）', () => {
    const names = swSources()
      .flatMap((f) => [...f.code.matchAll(/cacheName\s*:\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1] ?? ''))
      .sort();
    expect(names).toEqual(RUNTIME_CACHES);
    for (const n of names) expect(n.startsWith(PRECACHE_PREFIX), n).toBe(false);
    // 没有另改 Workbox 的缓存名（改了以后 PRECACHE_PREFIX 认不出预缓存，或运行时缓存名对不上）
    for (const f of swSources()) expect(f.code, f.name).not.toMatch(/\bcacheNames\b|setCacheNameDetails/);
  });

  it('SW 不碰 IndexedDB、不手写缓存、不自己发请求', () => {
    const forbidden: Array<[string, RegExp]> = [
      ['IndexedDB', /\bindexedDB\b|\bIDB[A-Z]\w*/],
      ['手动开缓存或写缓存', /\bcaches\s*\.\s*open\b|\.put\s*\(/],
      ['SW 自己发请求', /(^|[^.\w])fetch\s*\(|importScripts/],
    ];
    for (const f of swSources()) {
      for (const [what, re] of forbidden) expect(f.code, `${f.name}：${what}`).not.toMatch(re);
    }
  });

  it('只引白名单里的模块（不引 workbox-expiration、workbox-background-sync 这类用 IndexedDB 的）', () => {
    for (const f of swSources()) {
      const specs = [...f.code.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
      for (const s of specs) expect(ALLOWED_IMPORTS, `${f.name} 引了 ${s}`).toContain(s);
    }
  });

  it('只听 fetch、message 两个事件（没有 push、notificationclick、sync）', () => {
    const events = swSources()
      .flatMap((f) => [...f.code.matchAll(/addEventListener\s*\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1] ?? ''))
      .sort();
    expect(events).toEqual(['fetch', 'message']);
    for (const f of swSources()) expect(f.code, f.name).not.toMatch(/\bon(push|notificationclick|sync|periodicsync)\s*=/);
  });

  it('message 只认 SKIP_WAITING', () => {
    const sw = swSources().find((f) => f.name === 'sw.ts');
    expect(sw).toBeDefined();
    const types = [...(sw?.code ?? '').matchAll(/\.type\s*===\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(types).toEqual(['SKIP_WAITING']);
  });

  it('带账号数据的请求进不了运行时缓存：/sb、/files、非 GET、别的源一律直连', () => {
    const O = 'https://lemomemo.com';
    const cases: Array<[string, string, string, string]> = [
      ['/sb/rest/v1/events', 'GET', 'cors', O],
      ['/sb/auth/v1/user', 'GET', 'navigate', O],
      ['/files/v1/o/images/u/n/i.webp?e=1&s=x', 'GET', 'no-cors', O],
      ['/files/v1/o/files/u/n/i.pdf?e=1&s=x', 'GET', 'navigate', O],
      ['/app/holidays/kr/2026.json', 'POST', 'cors', O],
      ['/app/fonts/a.woff2', 'GET', 'cors', 'https://x.supabase.co'],
      ['/app/', 'GET', 'navigate', 'https://x.supabase.co'],
    ];
    for (const [path, method, mode, origin] of cases) {
      expect(routeOf(new URL(path, origin), method, mode, O), `${method} ${origin}${path}`).toBe('bypass');
    }
  });
});
