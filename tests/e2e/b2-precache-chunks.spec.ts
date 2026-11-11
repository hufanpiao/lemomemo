// TC-B2-58（B2 QA 缺口 G-11）：懒加载 chunk 都在预缓存里、断网（服务器上已没有这些文件时同理）从 SW 打开不 404 的直接断言
// 原来只有 tests/build/inject-sw.test.ts（清单的排除规则）和 b2-ui-b-update-fallback（更新模块下载失败的退路），没有对真实产物逐个查。
// 做法（真实浏览器 + 本组的 dist）：
//   ① 从产物里的 JS 收集它们引用的每个带哈希的 chunk 文件名（动态 import、Vite 的预加载依赖表），每个都在 <WEB_OUT>/app/assets/ 里有文件；
//   ② SW 装好后读 Cache Storage 的 workbox 预缓存：assets/ 下每个 .js、.css（不含 .map）都在里面，①收集到的引用也都在里面；
//   ③ 断网（context.setOffline，SW 的 fetch 也一起断）后在页面里逐个 fetch 每个 chunk：全部 200（由预缓存回），没有一个失败；
//      再断网重新打开 /app/ 切到日历、待办、随手记，不出现失败的请求（holidays/、fonts/ 按设计走运行时缓存，不算）和动态 import 报错。
// “旧 chunk 不 404”：断网和“新版本上线后服务器删掉了旧 chunk”对页面是同一回事——旧 SW 还在管时，旧 chunk 只能从它的预缓存来。
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { webOutDir } from '../../build/assemble_web.mjs';
import { expect, test } from './session-fixture.ts';

test.use({ loggedIn: true });
test.skip(({ browserName }) => browserName !== 'chromium', '读产物文件、Cache Storage 和浏览器无关；断网 + SW 在 chromium 跑一次');

const ROOT = join(import.meta.dirname, '..', '..');
const APP_DIR = join(webOutDir(ROOT, process.env), 'app');
const ASSETS = join(APP_DIR, 'assets');

/** assets/ 下所有要进预缓存的 chunk（.js、.css；.map 本来就排除） */
function diskChunks(): string[] {
  return readdirSync(ASSETS)
    .filter((f) => /\.(js|css)$/.test(f))
    .map((f) => `/app/assets/${f}`)
    .sort();
}

/** 产物 JS 里引用的带哈希的 chunk 文件名（动态 import("./x-hash.js")、__vite__mapDeps 里的 "assets/x-hash.js"） */
function referencedChunks(): string[] {
  const out = new Set<string>();
  for (const f of readdirSync(ASSETS).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(ASSETS, f), 'utf8');
    for (const m of src.matchAll(/import\(\s*["'`]\.\/([A-Za-z0-9_.-]+\.js)["'`]\s*\)/g)) out.add(`/app/assets/${m[1]}`);
    for (const m of src.matchAll(/["'`](?:\.\/|assets\/)([A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css))["'`]/g)) out.add(`/app/assets/${m[1]}`);
  }
  return [...out].sort();
}

test('懒加载 chunk 都在预缓存里；断网后逐个取都由 SW 回 200', async ({ page, context }) => {
  const disk = diskChunks();
  const refs = referencedChunks();
  expect(disk.length, `产物目录 ${relative(ROOT, ASSETS)} 里应当有 chunk`).toBeGreaterThan(5);
  // 至少要真的收集到懒加载引用（证明 ① 的正则对当前 Vite 产物有效，不是空集合放过）
  expect(refs.length, '产物 JS 里应当有动态 import 的 chunk 引用').toBeGreaterThan(5);
  expect(refs.filter((u) => !disk.includes(u)), '被引用但产物里没有的 chunk').toEqual([]);

  await page.goto('/app/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null), '刷新后页面归 SW 管').toBe(true);

  const precached = await page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith('workbox-precache')) continue;
      for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
    }
    return out.sort();
  });
  expect(precached.length, '应当查到 workbox 预缓存').toBeGreaterThan(0);
  expect(disk.filter((u) => !precached.includes(u)), '产物里有、预缓存里没有的 chunk').toEqual([]);
  expect(refs.filter((u) => !precached.includes(u)), '被懒加载引用、预缓存里没有的 chunk').toEqual([]);

  await context.setOffline(true);
  try {
    const failed = await page.evaluate(async (urls) => {
      const bad: string[] = [];
      for (const u of urls) {
        try {
          const r = await fetch(u);
          if (r.status !== 200) bad.push(`${u} → ${r.status}`);
        } catch {
          bad.push(`${u} → 取不到`);
        }
      }
      return bad;
    }, disk);
    expect(failed, '断网后取不到的 chunk').toEqual([]);

    // 断网重新打开，切几个懒加载的页签：不出失败请求、没有动态 import 报错
    const reqFailed: string[] = [];
    const pageErrors: string[] = [];
    page.on('requestfailed', (r) => {
      const u = new URL(r.url());
      // holidays/、fonts/ 按设计不进预缓存（架构 16.1，运行时缓存，第一次断网取不到是预期的），只看该进预缓存的
      if (u.pathname.startsWith('/app/') && !/^\/app\/(holidays|fonts)\//.test(u.pathname)) reqFailed.push(u.pathname);
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.reload();
    await expect(page.locator('main[data-feature]').first()).toBeVisible();
    for (const hash of ['#/calendar', '#/todos', '#/notes', '#/today']) {
      await page.evaluate((h) => {
        location.hash = h;
      }, hash);
      await expect(page.locator('main[data-feature]').first()).toBeVisible();
    }
    expect(reqFailed, '断网打开时失败的 /app/ 请求').toEqual([]);
    expect(pageErrors.filter((m) => /dynamically imported module|Failed to fetch|Importing a module script failed/i.test(m)), '动态 import 报错').toEqual([]);
  } finally {
    await context.setOffline(false);
  }
});
