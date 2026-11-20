// R-384 设置里换头像（快读组跑，默认组跳过：要会话令牌和 /sb 地址，见 e2e-config.ts 的 FASTREAD_ONLY_SPECS）
// 在真的设置 › 账号页里走：
//   ① 换头像：选一张 JPEG → 裁剪框“用这张” → PATCH profiles 两列（新 uuid、字节数 1～102400）→ PUT /files/v1/o/images/<uid>/me/<id>.webp（包体是 webp、
//      长度等于 avatar_bytes）→ 大头像、四页右上角、设置首页账号一行都换成图片；Cache Storage 的 lemo-me-avatar 里存了这一张；
//      重开 App 从缓存读，不再签名取图；运行日志记 me avatar-change ok，头像自己写的行不带 id
//   ② 去掉头像：profile 原来就有头像（经签名取图显示出来）→ 点“去掉头像” → PATCH 两列 null → 变回名字首字，“去掉头像”按钮消失
//   ③ 上传失败回滚：PUT 一直 503 → 退避重试 2 次（共 3 次）→ PATCH 把两列写回原值（原来没头像就是 null）→ 出“没传上”的提示，仍是首字
//   ④ 没网：两个按钮置灰，下面写“没有网络，联网后才能换头像”；联网后恢复
// /sb 在浏览器这一层答（fake-rest.ts），profiles 这张表由这里接管：GET 回当前那一行（含 avatar_id、avatar_bytes），PATCH 改它、回 204。
// 截图：设了 LEMO_SHOT_DIR 才截、只在 Chromium 上截（手机 390×844，浅色、深色）；断言两种浏览器都跑
import { writeFileSync } from 'node:fs';
import type { Page, Request } from '@playwright/test';
import { isWebpFile } from '../../src/features/notes/__tests__/exif-sample.ts';
import { fakeRest, POLICY_VER } from './fake-rest.ts';
import { jpeg, readRunLogInPage, SHOT_DIR } from './page-helpers.ts';
import { expect, FAKE_USER_ID, seedFakeSession, test } from './session-fixture.ts';

test.setTimeout(90_000);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OLD_ID = '0e2e0384-0000-4000-8000-0000000000aa';

interface Fake {
  profile: Record<string, unknown>;
  patches: Record<string, unknown>[];
  puts: Request[];
  signs: string[];
  /** PUT 回的状态码（默认 200） */
  putStatus: number;
}

/** 假会话 + /sb（profiles 由这里接管）+ 假签名、假取字节、假上传 */
async function fakeServer(page: Page, baseURL: string | undefined, profile: Record<string, unknown> = {}): Promise<Fake> {
  if (!baseURL) throw new Error('没有 baseURL');
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  const fake: Fake = {
    profile: { user_id: FAKE_USER_ID, consent_policy_ver: POLICY_VER, display_name: '柠檬', avatar_id: null, avatar_bytes: null, ...profile },
    patches: [],
    puts: [],
    signs: [],
    putStatus: 200,
  };
  await fakeRest(page, { user: FAKE_USER_ID });
  // 后注册的先匹配：profiles 这张表这里答
  await page.route(/\/sb\/rest\/v1\/profiles(\?|$)/, (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ json: [fake.profile] });
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON() as Record<string, unknown>;
      fake.patches.push(body);
      fake.profile = { ...fake.profile, ...body };
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fallback();
  });
  const stored = new Map<string, Buffer>();
  if (typeof profile['avatar_id'] === 'string') stored.set(`/files/v1/o/images/${FAKE_USER_ID}/me/${profile['avatar_id']}.webp`, await jpeg(page, { hue: 200, w: 256, h: 256, box: true }));
  await page.route(/\/files\/v1\/sign$/, async (route) => {
    const body = route.request().postDataJSON() as { items: { bucket: string; path: string; purpose: string }[] };
    const origin = new URL(route.request().url()).origin;
    const items = body.items.map((x, i) => {
      fake.signs.push(x.path);
      return { i, ok: true, url: `${origin}/files/v1/o/${x.bucket}/${x.path}`, sig: `p=${x.purpose}&e=9999999999&s=e2e` };
    });
    await route.fulfill({ json: { items } });
  });
  await page.route(/\/files\/v1\/o\/images\//, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'PUT') {
      fake.puts.push(req);
      if (fake.putStatus !== 200) return route.fulfill({ status: fake.putStatus, json: { error: 'try_later' } });
      const b = req.postDataBuffer();
      if (b) stored.set(path, b);
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"etag":"e2e"}' });
    }
    const b = stored.get(path);
    return b ? route.fulfill({ status: 200, contentType: 'image/webp', body: b }) : route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  return fake;
}

const runLog = (page: Page) => page.evaluate(readRunLogInPage);
const face = (page: Page) => page.getByTestId('settings-me-avatar-face');

async function openAccount(page: Page): Promise<void> {
  await page.goto('/app/#/settings/account');
  await expect(page.getByTestId('settings-me-avatar')).toBeVisible({ timeout: 30_000 });
}

/** 选一张图、在裁剪框里点“用这张” */
async function pickAndCrop(page: Page): Promise<void> {
  await page.getByTestId('settings-me-avatar-file').setInputFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: await jpeg(page, { w: 800, h: 600, tiles: { n: 120, w: 60, h: 40 } }) });
  await expect(page.getByTestId('settings-me-avatar-crop')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('settings-me-avatar-crop-ok').click();
}

async function shots(page: Page, browserName: string, tag: string): Promise<void> {
  if (browserName !== 'chromium' || !SHOT_DIR) return;
  await page.setViewportSize({ width: 390, height: 844 });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/app/#/settings/account');
    await expect(face(page)).toHaveAttribute('data-has-img', '', { timeout: 15_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-账号页-${scheme}.png`, animations: 'disabled' });
    await page.goto('/app/#/settings');
    await expect(page.getByTestId('settings-account-avatar')).toHaveAttribute('data-has-img', '', { timeout: 15_000 });
    // 从账号页退回时焦点还原到账号那一行（现有行为），截图前移开，免得图上多一圈焦点框
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-设置首页-${scheme}.png`, animations: 'disabled' });
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today-settings').locator('[data-has-img] img')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOT_DIR}/${tag}-今天页右上角-${scheme}.png`, animations: 'disabled' });
    await page.getByTestId('today-settings').screenshot({ path: `${SHOT_DIR}/${tag}-今天页右上角-放大-${scheme}.png`, animations: 'disabled' });
  }
}

// 失败时把运行日志附进报告（先看日志再定根因）
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const path = info.outputPath('run-log.txt');
  writeFileSync(path, await runLog(page).catch((e: unknown) => String(e)));
  await info.attach('运行日志', { path, contentType: 'text/plain' });
});

test('换头像：写两列 → 传 webp → 三处都显示图片、存进缓存；重开从缓存读、不再签名', async ({ page, baseURL, browserName }) => {
  const fake = await fakeServer(page, baseURL);
  await openAccount(page);
  await expect(face(page)).toHaveText('柠');
  await expect(page.getByTestId('settings-me-avatar-remove'), '没头像时没有“去掉头像”').toHaveCount(0);
  await pickAndCrop(page);

  await expect(face(page)).toHaveAttribute('data-has-img', '', { timeout: 30_000 });
  expect(fake.patches).toHaveLength(1);
  const id = String(fake.patches[0]?.['avatar_id']);
  const bytes = Number(fake.patches[0]?.['avatar_bytes']);
  expect(id).toMatch(UUID);
  expect(bytes).toBeGreaterThan(0);
  expect(bytes).toBeLessThanOrEqual(102400);
  expect(fake.puts).toHaveLength(1);
  const put = fake.puts[0] as Request;
  expect(new URL(put.url()).pathname).toBe(`/files/v1/o/images/${FAKE_USER_ID}/me/${id}.webp`);
  // 请求包体：WebKit 里 Playwright 拿不到 Blob 形式的包体（postDataBuffer 回 null），只在拿得到时核；
  // 两种浏览器都核缓存里存的那一张（和上传的是同一个 Blob）：文件头 RIFF....WEBP、长度等于 avatar_bytes（库里 files_authorize 核这个）
  const body = put.postDataBuffer();
  if (browserName === 'chromium') {
    expect(body && isWebpFile(body), '包体是 webp').toBe(true);
    expect(body?.length, '包体长度等于 avatar_bytes').toBe(bytes);
  }
  const saved = await page.evaluate(async (key) => {
    const r = await (await caches.open('lemo-me-avatar')).match(`${location.origin}/__me-avatar/${key}`);
    return r ? [...new Uint8Array(await r.arrayBuffer())] : null;
  }, id);
  expect(saved && isWebpFile(Uint8Array.from(saved)), '缓存里那一张是 webp').toBe(true);
  expect(saved?.length, '缓存里那一张的长度等于 avatar_bytes').toBe(bytes);
  await expect(page.getByTestId('settings-me-avatar-remove')).toBeVisible();
  await expect(page.getByTestId('settings-me-avatar-msg')).toHaveText('只有你自己看得到，各台设备同步显示');
  expect(fake.signs, '刚传的那一张直接显示，不去签名取').toEqual([]);

  const cached = await page.evaluate(async () => (await (await caches.open('lemo-me-avatar')).keys()).map((r) => new URL(r.url).pathname));
  expect(cached).toEqual([`/__me-avatar/${id}`]);
  // 运行日志攒一会儿才落盘：轮询。rlog 的行前面是 t=秒数 app；全局网络日志本来就记请求路径（run-log.ts 的 net 行，插图、纪念日头像同样），这里只核头像自己写的行
  await expect.poll(() => runLog(page), { timeout: 5_000 }).toMatch(/ app me avatar-change ok$/m);
  const mine = (await runLog(page)).split(/\r?\n/).filter((l) => / app me avatar-/.test(l));
  expect(mine.length).toBeGreaterThan(0);
  for (const l of mine) expect(l, '头像自己的日志行不记 id').not.toContain(id);

  // 设置首页账号一行、今天页右上角（手机宽度）或电脑版侧栏的设置入口（≥ 900px 时右上角那个藏起来，见 MeLink.tsx）
  await page.goto('/app/#/settings');
  await expect(page.getByTestId('settings-account-avatar')).toHaveAttribute('data-has-img', '', { timeout: 15_000 });
  await page.goto('/app/#/today');
  const wide = (page.viewportSize()?.width ?? 0) >= 900;
  const entry = () => page.getByTestId(wide ? 'tabbar-settings' : 'today-settings').locator('[data-has-img] img');
  await expect(entry()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('today-settings').locator('[data-has-img]'), '右上角的 MeLink 宽屏也画了图（只是藏着）').toBeAttached();

  // 重开：从 Cache Storage 读，不签名
  await page.reload();
  await expect(entry()).toBeVisible({ timeout: 30_000 });
  expect(fake.signs).toEqual([]);

  await shots(page, browserName, 'r384');
});

test('去掉头像：原来的头像经签名取图显示 → 点“去掉头像” → 两列写 null、变回首字', async ({ page, baseURL }) => {
  const fake = await fakeServer(page, baseURL, { avatar_id: OLD_ID, avatar_bytes: 300 });
  await openAccount(page);
  await expect(face(page)).toHaveAttribute('data-has-img', '', { timeout: 30_000 });
  expect(fake.signs).toEqual([`${FAKE_USER_ID}/me/${OLD_ID}.webp`]);
  await page.getByTestId('settings-me-avatar-remove').click();
  await expect(face(page)).toHaveText('柠', { timeout: 15_000 });
  await expect(face(page)).not.toHaveAttribute('data-has-img', '');
  expect(fake.patches).toEqual([{ avatar_id: null, avatar_bytes: null }]);
  await expect(page.getByTestId('settings-me-avatar-remove')).toHaveCount(0);
  await expect.poll(() => runLog(page), { timeout: 5_000 }).toMatch(/ app me avatar-clear ok$/m);
});

test('上传失败回滚：PUT 一直 503 → 共试 3 次 → 两列写回原值、提示没传上、仍是首字', async ({ page, baseURL }) => {
  const fake = await fakeServer(page, baseURL);
  fake.putStatus = 503;
  await openAccount(page);
  await pickAndCrop(page);
  const msg = page.getByTestId('settings-me-avatar-msg');
  await expect(msg).toHaveText('头像没传上，已换回原来的，联网后再试一次', { timeout: 30_000 });
  await expect(msg).toHaveAttribute('role', 'alert');
  expect(fake.puts, '退避重试 2 次').toHaveLength(3);
  expect(fake.patches).toHaveLength(2);
  expect(fake.patches[0]?.['avatar_id']).toMatch(UUID);
  expect(fake.patches[1], '写回原值（原来没头像）').toEqual({ avatar_id: null, avatar_bytes: null });
  await expect(face(page)).toHaveText('柠');
  const cached = await page.evaluate(async () => (await (await caches.open('lemo-me-avatar')).keys()).length);
  expect(cached, '没传上的不进缓存').toBe(0);
});

test('没网：两个按钮置灰并提示；联网后恢复', async ({ page, context, baseURL }) => {
  await fakeServer(page, baseURL, { avatar_id: OLD_ID, avatar_bytes: 300 });
  await openAccount(page);
  await expect(page.getByTestId('settings-me-avatar-remove')).toBeVisible({ timeout: 30_000 });
  await context.setOffline(true);
  try {
    await expect(page.getByTestId('settings-me-avatar-change')).toBeDisabled();
    await expect(page.getByTestId('settings-me-avatar-remove')).toBeDisabled();
    await expect(page.getByTestId('settings-me-avatar-msg')).toHaveText('没有网络，联网后才能换头像');
  } finally {
    await context.setOffline(false);
  }
  await expect(page.getByTestId('settings-me-avatar-change')).toBeEnabled();
  await expect(page.getByTestId('settings-me-avatar-msg')).toHaveText('只有你自己看得到，各台设备同步显示');
});
