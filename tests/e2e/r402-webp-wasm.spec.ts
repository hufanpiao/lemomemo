// R-402（11-13）：iPhone Safari 的 canvas 导不出 webp（要 image/webp 交回 png），App 改用自带的 wasm 编码器（@jsquash/webp）
// 做法：打开页面前把 HTMLCanvasElement.prototype.toBlob 和 OffscreenCanvas.prototype.convertToBlob 改成“要 webp 就回 png”（模拟 iPhone），
// 在真的随手记编辑页里选一张带拍摄时间和 GPS 的 JPEG（canvas 画的真 JPEG + exif-sample.ts 造的 EXIF），看：
//   · 走到了上传请求（PUT /files/v1/o/images/…）：原图、缩略图两份包体的文件头都是 RIFF....WEBP，RIFF 块只有图像块（没有 EXIF、XMP 块），
//     字节里找不到 Exif；
//   · 选图之前一个 .wasm 都不请求（按需加载）；选了以后 wasm 从同源的 /app/assets/*.wasm 取（CSP 的 script-src 'wasm-unsafe-eval' 生效，
//     csp-fixture 收不到任何违规）；运行日志压图那一行记了 path=wasm native=image/png 和耗时；
//   · 离线（SW 装好、断网）也能编：wasm 在预缓存里，运行日志照样 path=wasm、没有 why=，图插进了编辑器
// 跑在快读组（playwright.fastread.config.ts）：上传器“等行确认了才传”，确认要同步引擎把新建发出去，只有带 supabase 地址的构建才起同步；
// 默认的无后端组没配地址，整份跳过。/sb 接的是假后端：这里在浏览器这一层答——profiles、app_config 回告知已同意，别的表 GET 回空，
// 随手记、插图两张表的新建回 201 带 rev、GET 时回新建过的行，上传记下包体回 200。会话是 JWT 形状的假令牌（session-fixture.ts 的 seedFakeSession({ jwt: true })，和 b2-first-screen-supabase.spec.ts 共用）
import { writeFileSync } from 'node:fs';
import type { Page, Request } from '@playwright/test';
import { exifApp1, hasAscii, isWebpFile, riffChunks, WEBP_IMAGE_CHUNKS, withExif } from '../../src/features/notes/__tests__/exif-sample.ts';
import { expect, FAKE_USER_ID, seedFakeSession, test } from './session-fixture.ts';

test.skip(!process.env['VITE_PUBLIC_SUPABASE_URL'], '要同步引擎把新建发出去，只在带 supabase 地址的快读组跑（npm run e2e:fastread）');
test.skip(({ browserName }) => browserName !== 'chromium', '改的是 Chromium 的 canvas 导出（WebKit 原生行为只能真机看）；SW、断网在 chromium 跑一次');
test.setTimeout(90_000);

/** 模拟 iPhone Safari：要 webp 就回 png（别的类型照旧） */
const FAKE_IPHONE_CANVAS = `(() => {
  const tb = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function (cb, type, q) { return tb.call(this, cb, type === 'image/webp' ? 'image/png' : type, q); };
  if (typeof OffscreenCanvas === 'function') {
    const cb = OffscreenCanvas.prototype.convertToBlob;
    OffscreenCanvas.prototype.convertToBlob = function (o) { return cb.call(this, o && o.type === 'image/webp' ? { ...o, type: 'image/png' } : o); };
  }
})();`;
const V = '2026-10-29';
/** 运行日志里压图成功、走 wasm 的那一行（image-uploader.ts：结果 + 编码诊断；失败是 encode_… 并带 why=） */
const WASM_OK = /notes img encode ok .* path=wasm native=image\/png ms=\d+ loadMs=\d+ encMs=\d+$/m;

/** 页面里用 canvas 画一张 1600 × 1200 的真 JPEG，回到 Node 侧插上带拍摄时间和 GPS 的 EXIF */
async function gpsJpeg(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 1600;
    c.height = 1200;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no_ctx');
    for (let i = 0; i < 300; i++) {
      ctx.fillStyle = `hsl(${(i * 37) % 360} 70% 50%)`;
      ctx.fillRect((i * 97) % 1600, (i * 53) % 1200, 120, 80);
    }
    const b = await new Promise<Blob>((res) => c.toBlob((x) => res(x as Blob), 'image/jpeg', 0.9));
    return [...new Uint8Array(await b.arrayBuffer())];
  });
  const jpeg = withExif(Uint8Array.from(bytes), exifApp1({ date: '2026:10:21 14:05:09', gps: true }));
  expect(hasAscii(jpeg, 'Exif')).toBe(true);
  return Buffer.from(jpeg);
}

/** 假会话 + 浏览器这一层的假服务器（见文件头）；返回记下的上传请求 */
async function fakeServer(page: Page, baseURL: string | undefined): Promise<Request[]> {
  if (!baseURL) throw new Error('没有 baseURL');
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  await page.addInitScript({ content: FAKE_IPHONE_CANVAS });
  // 随手记、插图两张表新建过的行：GET 时原样回出来。首次同步是整表重拉，拉完服务器没回的、本机已确认的行会被当成
  // “服务器上已删”丢掉（core/sync/pull.ts 的 snapshot / dropServer）；新建确认得比重拉早时，回空就会把刚建的随手记删掉
  const saved = new Map<string, Map<string, Record<string, unknown>>>([['notes', new Map()], ['note_images', new Map()]]);
  await page.route(/\/sb\/rest\/v1\//, (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const table = saved.get(u.pathname.split('/').pop() ?? '');
    if (req.method() === 'POST' && table) {
      // 新建回 201 带 rev（sync-transport 的 insertRow 要 select('rev')；回包里没有 rev 就当成“服务器上已有”，去核对、判成冲突）
      const body: unknown = req.postDataJSON();
      for (const r of Array.isArray(body) ? body : [body]) {
        const row = r as Record<string, unknown>;
        if (typeof row['id'] === 'string') table.set(row['id'], { ...row, rev: 1, synced_at: new Date().toISOString() });
      }
      return route.fulfill({ status: 201, json: [{ rev: 1 }] });
    }
    if (req.method() !== 'GET') return route.fallback();
    if (table) return route.fulfill({ json: [...table.values()] });
    if (u.pathname.endsWith('/profiles')) return route.fulfill({ json: [{ user_id: FAKE_USER_ID, consent_policy_ver: V }] });
    if (u.pathname.endsWith('/app_config') && u.searchParams.get('select') === 'notice') return route.fulfill({ json: [{ notice: { policy_ver: V, min_consent_ver: V } }] });
    return route.fulfill({ json: [] });
  });
  const uploads: Request[] = [];
  await page.route(/\/files\/v1\/o\/images\//, (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    uploads.push(route.request());
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"etag":"e2e"}' });
  });
  return uploads;
}

/** 新建一条随手记，等插图按钮能点（行有了 id） */
async function newNote(page: Page): Promise<void> {
  await page.goto('/app/#/note/new');
  const title = page.getByTestId('note-edit-title');
  await expect(title).toBeVisible({ timeout: 30_000 });
  await title.fill('R-402 插图');
  await page.getByTestId('note-edit-body').click();
  await expect(page.getByTestId('note-edit-img')).toBeEnabled({ timeout: 15_000 });
}

const runLog = (page: Page) => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');

// 失败时把运行日志附进报告（先看日志再定根因）
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const path = info.outputPath('run-log.txt');
  writeFileSync(path, await runLog(page).catch((e: unknown) => String(e)));
  await info.attach('运行日志', { path, contentType: 'text/plain' });
});

test('原生导不出 webp → wasm 编：走到上传请求，两份包体都是 RIFF....WEBP、没有 EXIF；wasm 同源、日志 path=wasm', async ({ page, baseURL }) => {
  const uploads = await fakeServer(page, baseURL);
  const wasm: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('.wasm')) wasm.push(r.url());
  });
  await newNote(page);
  // 模拟生效：页面里要 webp 拿到的是 png
  expect(await page.evaluate(() => new Promise<string>((res) => document.createElement('canvas').toBlob((b) => res(b?.type ?? ''), 'image/webp')))).toBe('image/png');
  expect(wasm, '选图之前不请求 .wasm（按需加载，R-402 评审 9）').toEqual([]);
  await page.getByTestId('note-edit-img-input').setInputFiles({ name: 'IMG_0402.JPG', mimeType: 'image/jpeg', buffer: await gpsJpeg(page) });

  await expect.poll(() => uploads.length, { timeout: 45_000, message: '原图、缩略图两次上传' }).toBe(2);
  expect(uploads.map((r) => new URL(r.url()).pathname).filter((p) => p.endsWith('.t.webp')), '一份原图、一份缩略图').toHaveLength(1);
  for (const r of uploads) {
    const path = new URL(r.url()).pathname;
    const body = r.postDataBuffer();
    if (!body) throw new Error(`${path} 的上传请求没有包体`);
    expect(isWebpFile(body), `${path} 文件头`).toBe(true);
    expect(riffChunks(body).length, `${path} 有图像块`).toBeGreaterThan(0);
    for (const c of riffChunks(body)) expect(WEBP_IMAGE_CHUNKS, `${path} 的 RIFF 块 ${c}`).toContain(c);
    expect(hasAscii(body, 'Exif') || hasAscii(body, 'EXIF'), `${path} 没带 EXIF`).toBe(false);
  }
  expect(wasm.length, '载过 wasm').toBeGreaterThan(0);
  for (const u of wasm) expect(u).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/app\/assets\/webp_enc_simd-[A-Za-z0-9_-]+\.wasm$/);
  // 运行日志攒 300 ms 才写进 localStorage（run-log.ts 的 saveTimer），上传一发出就读会读到旧的：轮询等它落盘
  await expect.poll(() => runLog(page), { timeout: 5_000 }).toMatch(WASM_OK);
  await expect(page.locator('[data-testid^="note-image-"][data-state="done"]')).toHaveCount(1, { timeout: 15_000 });
});

test('离线：SW 装好后断网，wasm 由预缓存回，照样编成 webp（日志 path=wasm、没有 why=）', async ({ page, context, baseURL }) => {
  await fakeServer(page, baseURL);
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
    return out;
  });
  expect(precached.filter((p) => /^\/app\/assets\/webp_enc_simd-[^/]+\.wasm$/.test(p)), 'wasm 在预缓存里').toHaveLength(1);

  await newNote(page);
  const jpeg = await gpsJpeg(page);
  await context.setOffline(true);
  try {
    await page.getByTestId('note-edit-img-input').setInputFiles({ name: 'IMG_0403.JPG', mimeType: 'image/jpeg', buffer: jpeg });
    await expect.poll(() => runLog(page), { timeout: 30_000 }).toMatch(WASM_OK);
    // 编好的图插进了编辑器（离线传不上去，状态是上传中或失败），没有压图失败的提示
    await expect(page.locator('[data-testid^="note-image-"][data-state]')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId('note-edit-img-msg')).toHaveCount(0);
  } finally {
    await context.setOffline(false);
  }
});
