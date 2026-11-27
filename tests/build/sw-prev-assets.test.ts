// 上一版的分包多留一版（同步层审查第 6 条之二，主持人 11-14 定方案 A）
// 场景：两个标签页，A 页按“重新打开”让新 SW 接管（skipWaiting 以后 B 页也归新 SW 管），B 页还在跑旧代码，
// 之后按需加载旧版带哈希的分包。原来 workbox 在 activate 时立刻删掉不在新清单里的预缓存条目，线上也只有新版文件，B 页落空。
// 现在：新 SW 激活时把上一版里这一版用不到的 /app/assets/ 分包挪进 lemo-prev-assets（先整个清空，只留一版），
// 旧页再要它们时由这份回；再下一次激活时清掉（不累积）。替身见 ./sw-harness.ts（真的 workbox 加真的 sw.ts）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSw, stubSwGlobals, type FakeCaches, type LoadedSw } from './sw-harness.ts';

/** 一版的预缓存清单：index.html 按内容带 revision，分包带哈希（revision 为 null，和 build/inject_sw_manifest.mjs 一样） */
function manifest(v: number, assets: string[]): Array<{ url: string; revision: string | null }> {
  return [{ url: '/app/index.html', revision: `v${v}` }, ...assets.map((a) => ({ url: `/app/assets/${a}`, revision: null }))];
}

const V1 = ['main-1.js', 'page-1.js', 'shared.css'];
const V2 = ['main-2.js', 'page-2.js', 'shared.css'];
const V3 = ['main-3.js', 'page-3.js', 'shared.css'];

describe('上一版的分包：新 SW 激活后旧页还拿得到，再下一次激活清掉', () => {
  let caches: FakeCaches;
  /** 线上现在有哪些文件（部署新版以后只有新版的） */
  let server: Set<string>;

  const body = (path: string): string => `file:${path}`;
  /** 线上：有这个文件回 200，没有回 404（Pages 上旧版文件已经不在） */
  const net = (u: string): Promise<Response> => {
    const path = new URL(u).pathname;
    return Promise.resolve(server.has(path) ? new Response(body(path), { status: 200 }) : new Response('not found', { status: 404 }));
  };

  /** 部署第 v 版并让它的 SW 装好、激活（A 页按了“重新打开”） */
  async function deploy(v: number, assets: string[]): Promise<LoadedSw> {
    server = new Set(['/app/index.html', ...assets.map((a) => `/app/assets/${a}`)]);
    const sw = await loadSw(caches, manifest(v, assets));
    await sw.lifecycle('install');
    await sw.lifecycle('activate');
    return sw;
  }

  /** 旧页按需加载一个分包：回状态码和内容。SW 不接（没 respondWith）时浏览器自己联网，同样走 net */
  async function load(sw: LoadedSw, path: string): Promise<[number, string]> {
    const ev = sw.fetch(path, 'cors');
    const res = await (ev.responded ?? net(`https://lemomemo.com${path}`));
    return [res.status, await res.text()];
  }

  beforeEach(() => {
    server = new Set();
    caches = stubSwGlobals(net);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('第 2 版激活后：第 1 版独有的分包仍由 SW 回 200（线上已经没有了），两版共用的照旧从预缓存回', async () => {
    await deploy(1, V1);
    const sw2 = await deploy(2, V2);
    expect(await load(sw2, '/app/assets/page-1.js')).toEqual([200, body('/app/assets/page-1.js')]);
    expect(await load(sw2, '/app/assets/main-1.js')).toEqual([200, body('/app/assets/main-1.js')]);
    expect(await load(sw2, '/app/assets/shared.css')).toEqual([200, body('/app/assets/shared.css')]);
    expect(await load(sw2, '/app/assets/page-2.js')).toEqual([200, body('/app/assets/page-2.js')]);
  });

  it('第 3 版激活后：第 1 版的清掉（只留上一版，不累积），第 2 版独有的还在', async () => {
    await deploy(1, V1);
    await deploy(2, V2);
    const sw3 = await deploy(3, V3);
    expect((await load(sw3, '/app/assets/page-1.js'))[0]).toBe(404);
    expect(await load(sw3, '/app/assets/page-2.js')).toEqual([200, body('/app/assets/page-2.js')]);
    // 多留的这份里只有第 2 版独有的分包；预缓存里只有第 3 版的
    expect(await caches.paths('lemo-prev-assets')).toEqual(['/app/assets/main-2.js', '/app/assets/page-2.js']);
    const pre = [...caches.stores.keys()].find((n) => n.includes('precache')) ?? '';
    expect(await caches.paths(pre)).toEqual(['/app/assets/main-3.js', '/app/assets/page-3.js', '/app/assets/shared.css', '/app/index.html?__WB_REVISION__=v3']);
  });

  it('只挪 /app/assets/ 下的分包：上一版的 index.html 不进多留的那份；多留的那份从不被网络响应写进去', async () => {
    await deploy(1, V1);
    const sw2 = await deploy(2, V2);
    // 不存在的分包：联网拿到 404，原样回，不写进任何缓存
    expect((await load(sw2, '/app/assets/nope-9.js'))[0]).toBe(404);
    expect(await caches.paths('lemo-prev-assets')).toEqual(['/app/assets/main-1.js', '/app/assets/page-1.js']);
  });

  it('第一次安装（没有上一版）：多留的那份是空的，分包照常从预缓存回', async () => {
    const sw1 = await deploy(1, V1);
    expect(await caches.paths('lemo-prev-assets')).toEqual([]);
    expect(await load(sw1, '/app/assets/page-1.js')).toEqual([200, body('/app/assets/page-1.js')]);
  });
});
