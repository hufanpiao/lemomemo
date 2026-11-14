// B4b-2 识图：随手记编辑器里每张图下面的识别状态 + 看图页（线框 sAIst；架构 5.13 第 5 点）。/sb 在浏览器这一层答（一条带 4 张图的随手记），签名、取图也在这一层假装
//   ① AI 开着：识别中（一行小字、没按钮）、没识别（“重新识别”→ file-check {action: retry_ai, kind: image, id}，回 pending 后改显示识别中）、
//      没交给 AI（skip / consent，“去打开”进 设置 › 语音与 AI）；识别好了的那张在编辑器里什么都不出；运行日志只记状态码，不记描述
//   ② AI 关着：还是 pending 的那张也显示“没交给 AI”
//   ③ 看图页（手机整屏、电脑浮层）：点图打开，“第几张 / 共几张”、识别好了的底部有“AI 看到的”，左右键、横滑换张，Esc、✕ 关上后焦点回到原图
//   ④ 设了 LEMO_SHOT_DIR 时在 Chromium 上存评审截图（手机 390×844 浅色、深色；电脑 1280×800）；断言两种浏览器都跑
// 跑在快读组（playwright.fastread.config.ts）：签名、file-check 要会话令牌，默认组的构建没配 supabase 地址
import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { FADE_GUARD_MS } from '../../src/motion/index.ts';
import { expect, seedFakeSession, test } from './session-fixture.ts';

test.skip(!process.env['VITE_PUBLIC_SUPABASE_URL'], '要会话令牌和 /sb 地址，只在快读组跑（npm run e2e:fastread）');
test.setTimeout(90_000);
test.use({ trace: 'off', timezoneId: 'Asia/Seoul', locale: 'zh-CN', viewport: { width: 390, height: 844 }, hasTouch: true });

const SHOT_DIR = process.env['LEMO_SHOT_DIR'];
const USER = '0e2e0000-0000-4000-8000-000000000001';
const NOTE = '0e2e0000-0000-4000-8000-0000000b4c01';
const img = (n: number) => `019a0000-0000-7000-8000-0000000b4c1${n}`;
const [PEND, FAIL, OFF, DONE] = [img(1), img(2), img(3), img(4)];
const V = '2026-10-29';

/** full：整页长图；浮层开着时用 false（固定定位的浮层在整页长图里会画在滚动位置上） */
async function shot(page: Page, browserName: string, name: string, full = true): Promise<void> {
  if (browserName !== 'chromium' || !SHOT_DIR) return;
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, animations: 'disabled', fullPage: full });
}

/** 一张 JPEG（页面里画，内容随便；默认 320×200 横图） */
async function jpeg(page: Page, hue: number, w = 320, h = 200): Promise<Buffer> {
  const b64 = await page.evaluate(([hue, w, h]) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) return '';
    g.fillStyle = `hsl(${hue} 45% 70%)`;
    g.fillRect(0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.8).split(',')[1] ?? '';
  }, [hue, w, h] as const);
  return Buffer.from(b64, 'base64');
}

type Fake = { retries: unknown[] };

async function fakeServer(page: Page, baseURL: string | undefined, ai: boolean): Promise<Fake> {
  if (!baseURL) throw new Error('没有 baseURL');
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  const bytes = new Map<string, Buffer>();
  const now = Date.now();
  const at = new Date(now).toISOString();
  const c = { user_id: USER, created_at: now, updated_at: now, deleted_at: null, undone: false, rev: 1, synced_at: at };
  const image = async (id: string, hue: number, o: Record<string, unknown>, size: [number, number] = [320, 200]) => {
    const path = `${USER}/${NOTE}/${id}.webp`;
    bytes.set(`/files/v1/o/images/${path}`, await jpeg(page, hue, ...size));
    return { id, ...c, note_id: NOTE, bucket: 'images', path, bytes: 1000, width: 320, height: 200, mime: 'image/webp', taken_at: null, has_thumb: false,
      ai_status: 'pending', skip_reason: null, ai_desc: null, ai_tags: [], ai_tries: 0, ...o };
  };
  const tables: Record<string, Record<string, unknown>[]> = {
    notes: [{ id: NOTE, ...c, title: '外国人登录证更新要带的', body: '护照、照片 1 张、手续费 3 万韩元。', is_private: false, category_id: null, category_source: 'none', category_seen: true, tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null }],
    note_images: [
      await image(PEND, 40, {}),
      await image(FAIL, 200, { ai_status: 'failed', ai_tries: 3 }),
      await image(OFF, 120, { ai_status: 'skip', skip_reason: 'consent' }),
      await image(DONE, 260, { ai_status: 'done', ai_desc: '一本护照的首页，蓝色封面，有照片和姓名栏', ai_tags: ['证件', '신분증', '护照', '여권'] }, [600, 1800]),
    ],
    settings: [{ id: '0e2e0000-0000-4000-8000-0000000b4c30', ...c, key: 'ai.enabled', value: ai }],
  };
  await page.route(/\/sb\/rest\/v1\//, (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const name = u.pathname.split('/').pop() ?? '';
    if (req.method() !== 'GET') return route.fulfill({ status: 201, json: [{ rev: 1 }] });
    if (tables[name]) return route.fulfill({ json: tables[name] });
    if (name === 'profiles') return route.fulfill({ json: [{ user_id: USER, consent_policy_ver: V, consent_ai_at: at }] });
    if (name === 'app_config' && u.searchParams.get('select') === 'notice') return route.fulfill({ json: [{ notice: { policy_ver: V, min_consent_ver: V } }] });
    return route.fulfill({ json: [] });
  });
  const fake: Fake = { retries: [] };
  await page.route(/\/sb\/functions\/v1\/file-check/, (route) => {
    fake.retries.push(route.request().postDataJSON());
    return route.fulfill({ json: { ai_status: 'pending' } });
  });
  await page.route(/\/files\/v1\/sign$/, async (route) => {
    const body = route.request().postDataJSON() as { items: { bucket: string; path: string; purpose: string }[] };
    const origin = new URL(route.request().url()).origin;
    await route.fulfill({ json: { items: body.items.map((x, i) => ({ i, ok: true, url: `${origin}/files/v1/o/${x.bucket}/${x.path}`, sig: `p=${x.purpose}&e=9999999999&s=e2e` })) } });
  });
  await page.route(/\/files\/v1\/o\/images\//, (route) => {
    const b = bytes.get(new URL(route.request().url()).pathname);
    return b ? route.fulfill({ status: 200, contentType: 'image/jpeg', body: b }) : route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  return fake;
}

async function openNote(page: Page): Promise<void> {
  await page.goto(`/app/#/note/${NOTE}`);
  await expect(page.getByTestId(`note-image-${DONE}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`img-ai-${PEND}`)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(FADE_GUARD_MS);
}

const runLog = (page: Page) => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');

// 失败时把运行日志附进报告（先看日志再定根因）
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const path = info.outputPath('run-log.txt');
  writeFileSync(path, await runLog(page).catch((e: unknown) => String(e)));
  await info.attach('运行日志', { path, contentType: 'text/plain' });
});

test('AI 开着：三种状态行，识别好了的不出东西；“重新识别”调 file-check 后改显示识别中；“去打开”进设置 › 语音与 AI', async ({ page, baseURL, browserName }) => {
  const fake = await fakeServer(page, baseURL, true);
  await openNote(page);
  await expect(page.getByTestId(`img-ai-${PEND}`)).toHaveAttribute('data-ai', 'pending');
  await expect(page.getByTestId(`img-ai-${PEND}`)).toHaveText('识别中 · 几分钟内好，好了就能按意思找到');
  await expect(page.getByTestId(`img-ai-${FAIL}`)).toContainText('没识别 · 试了 3 次没成功');
  await expect(page.getByTestId(`img-ai-${OFF}`)).toContainText('没交给 AI · AI 没打开或你没同意，这张图不能按意思找');
  // 识别好了：编辑器里这张图下面什么都不出（线框“好了就消失”），整页也没有“AI 看到的”
  await expect(page.getByTestId(`img-ai-${DONE}`)).toHaveCount(0);
  await expect(page.getByText('AI 看到的')).toHaveCount(0);
  await page.getByTestId(`img-ai-${OFF}`).scrollIntoViewIfNeeded();
  await shot(page, browserName, '手机-浅色-三种状态');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, browserName, '手机-深色-三种状态');
  await page.emulateMedia({ colorScheme: 'light' });

  await page.getByTestId(`img-ai-retry-${FAIL}`).click();
  await expect(page.getByTestId(`img-ai-${FAIL}`)).toHaveAttribute('data-ai', 'pending');
  expect(fake.retries).toEqual([{ action: 'retry_ai', kind: 'image', id: FAIL }]);
  // 运行日志隔一会儿才落进 localStorage，等它
  await expect.poll(() => runLog(page)).toContain('att ai retry ok=1 status=pending');
  expect(await runLog(page)).not.toContain('护照');

  await page.getByTestId(`img-ai-open-${OFF}`).click();
  await expect(page).toHaveURL(/#\/settings\/ai/);
  await expect.poll(() => runLog(page)).toContain('att ai open');
});

test('AI 关着：还是 pending 的那张也显示“没交给 AI”', async ({ page, baseURL, browserName }) => {
  await fakeServer(page, baseURL, false);
  await openNote(page);
  await expect(page.getByTestId(`img-ai-${PEND}`)).toHaveAttribute('data-ai', 'off');
  await expect(page.getByTestId(`img-ai-open-${PEND}`)).toHaveText('去打开');
  await page.getByTestId(`img-ai-${PEND}`).scrollIntoViewIfNeeded();
  await shot(page, browserName, '手机-浅色-AI关着');
});

/** 打开看图页、核“AI 看到的”（手机、电脑共用） */
async function viewer(page: Page): Promise<void> {
  const open = page.getByTestId(`note-image-open-${DONE}`);
  await open.scrollIntoViewIfNeeded();
  await open.click();
  await expect(page.getByTestId('img-view')).toBeVisible();
  await expect(page.getByTestId('img-view-close')).toBeFocused();
  await expect(page.getByTestId('img-view-count')).toHaveText('4 / 4');
  await expect(page.getByTestId(`img-view-pic-${DONE}`)).toBeVisible();
  // 竖长大图（600×1800）整张缩进图区，不被裁
  const stage = await page.getByTestId('img-view-stage').boundingBox();
  const pic = await page.getByTestId(`img-view-pic-${DONE}`).boundingBox();
  if (!stage || !pic) throw new Error('看图页没有图区或大图');
  expect(pic.y).toBeGreaterThanOrEqual(stage.y - 1);
  expect(pic.y + pic.height).toBeLessThanOrEqual(stage.y + stage.height + 1);
  expect(pic.height).toBeGreaterThan(pic.width * 2.5);
  const card = page.getByTestId(`img-view-ai-${DONE}`);
  await expect(card).toContainText('AI 看到的');
  await expect(card).toContainText('一本护照的首页，蓝色封面，有照片和姓名栏');
  await expect(card.getByRole('listitem')).toHaveText(['证件', '신분증', '护照', '여권']);
  await expect(card).toContainText('只写是什么东西，不抄号码');
}

test('看图页（手机）：点图打开，AI 看到的在底部；左右键、横滑换张；✕、Esc 关上后焦点回原图', async ({ page, baseURL, browserName }) => {
  await fakeServer(page, baseURL, true);
  await openNote(page);
  await viewer(page);
  await expect(page.getByRole('dialog')).toHaveAttribute('data-shell', 'full');
  await shot(page, browserName, '手机-看图页', false);
  // 左键换到第 3 张（没交给 AI 的那张）：计数跟着变，底部没有卡片
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('img-view-count')).toHaveText('3 / 4');
  await expect(page.getByText('AI 看到的')).toHaveCount(0);
  // 横滑（往左滑）回到第 4 张
  const box = await page.getByTestId('img-view-stage').boundingBox();
  if (!box) throw new Error('看图页没有图区');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.8, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('img-view-count')).toHaveText('4 / 4');
  await page.getByTestId('img-view-close').click();
  await expect(page.getByTestId('img-view')).toHaveCount(0);
  await expect(page.getByTestId(`note-image-open-${DONE}`)).toBeFocused();
  await page.getByTestId(`note-image-open-${DONE}`).click();
  await expect(page.getByTestId('img-view')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('img-view')).toHaveCount(0);
  await expect(page.getByTestId(`note-image-open-${DONE}`)).toBeFocused();
  await expect.poll(() => runLog(page)).toContain('att view close');
  expect(await runLog(page)).toContain('att view i=3/4');
  expect(await runLog(page)).not.toContain('护照');
});

test('看图浮层（电脑）：同一个组件，底部描述和标签；Esc 关上后焦点回原图', async ({ page, baseURL, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await fakeServer(page, baseURL, true);
  await openNote(page);
  await expect(page.getByTestId(`img-ai-${DONE}`)).toHaveCount(0);
  await viewer(page);
  await expect(page.getByTestId('img-view-close')).toContainText('Esc');
  await expect(page.getByRole('dialog')).toHaveAttribute('data-shell', 'box');
  await shot(page, browserName, '电脑-看图浮层', false);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('img-view')).toHaveCount(0);
  // Esc 只关看图浮层，编辑器（抽屉）还在
  await expect(page.getByTestId(`note-image-${DONE}`)).toBeVisible();
  await expect(page.getByTestId(`note-image-open-${DONE}`)).toBeFocused();
});
