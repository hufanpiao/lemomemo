// B4b-2 识图：随手记编辑器里每张图下面的识别状态 + 看图页（线框 sAIst；架构 5.13 第 5 点）。/sb 在浏览器这一层答（一条带 4 张图的随手记），签名、取图也在这一层假装
//   ① AI 开着：识别中（一行小字、没按钮）、没识别（“重新识别”→ file-check {action: retry_ai, kind: image, id}，回 pending 后改显示识别中）、
//      没交给 AI（skip / consent，“去打开”进 设置 › 语音与 AI）；识别好了的那张在编辑器里什么都不出；运行日志只记状态码，不记描述
//   ② AI 关着：还是 pending 的那张也显示“没交给 AI”
//   ③ 看图页（手机整屏、电脑浮层）：点图打开，“第几张 / 共几张”、识别好了的底部有“AI 看到的”，左右键、横滑换张，Esc、✕ 关上后焦点回到原图
//   ④ 设了 LEMO_SHOT_DIR 时在 Chromium 上存评审截图（手机 390×844 浅色、深色；电脑 1280×800）；断言两种浏览器都跑
// 跑在快读组（playwright.fastread.config.ts）：签名、file-check 要会话令牌，默认组的构建没配 supabase 地址
import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { fakeRest } from './fake-rest.ts';
import { afterPageFade, jpeg, readRunLogInPage, shot } from './page-helpers.ts';
import { expect, seedFakeSession, test } from './session-fixture.ts';

test.setTimeout(90_000);
test.use({ trace: 'off', timezoneId: 'Asia/Seoul', locale: 'zh-CN', viewport: { width: 390, height: 844 }, hasTouch: true });

const USER = '0e2e0000-0000-4000-8000-000000000001';
const NOTE = '0e2e0000-0000-4000-8000-0000000b4c01';
const img = (n: number) => `019a0000-0000-7000-8000-0000000b4c1${n}`;
const [PEND, FAIL, OFF, DONE] = [img(1), img(2), img(3), img(4)];

type Fake = { retries: unknown[] };

async function fakeServer(page: Page, baseURL: string | undefined, ai: boolean, list = false): Promise<Fake> {
  if (!baseURL) throw new Error('没有 baseURL');
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  const bytes = new Map<string, Buffer>();
  const now = Date.now();
  const at = new Date(now).toISOString();
  const c = { user_id: USER, created_at: now, updated_at: now, deleted_at: null, undone: false, rev: 1, synced_at: at };
  const image = async (id: string, hue: number, o: Record<string, unknown>, size: [number, number] = [320, 200]) => {
    const path = `${USER}/${NOTE}/${id}.webp`;
    bytes.set(`/files/v1/o/images/${path}`, await jpeg(page, { hue, w: size[0], h: size[1], tone: '45% 70%', quality: 0.8, ...(size[1] > 1000 ? { tiles: { n: 80, w: 64, h: 64 } } : {}) }));
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
    settings: [
      { id: '0e2e0000-0000-4000-8000-0000000b4c30', ...c, key: 'ai.enabled', value: ai },
      // 随手记显示方式两类设备都明确写（负责人 11-18 首装默认改列表）：量列表行的那一条手机写 list，其余看瀑布流卡片
      { id: '0e2e0000-0000-4000-8000-0000000b4c31', ...c, key: 'notes.view@mobile', value: list ? 'list' : 'masonry' },
      { id: '0e2e0000-0000-4000-8000-0000000b4c32', ...c, key: 'notes.view@desktop', value: 'masonry' },
    ],
  };
  await fakeRest(page, { user: USER, tables, profile: { consent_ai_at: at } });
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
  await afterPageFade(page);
}

const runLog = (page: Page) => page.evaluate(readRunLogInPage);

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
  await shot(page, browserName, '手机-浅色-三种状态', { fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, browserName, '手机-深色-三种状态', { fullPage: true });
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
  await shot(page, browserName, '手机-浅色-AI关着', { fullPage: true });
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
  await shot(page, browserName, '手机-看图页');
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
  await shot(page, browserName, '电脑-看图浮层');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('img-view')).toHaveCount(0);
  // Esc 只关看图浮层，编辑器（抽屉）还在
  await expect(page.getByTestId(`note-image-${DONE}`)).toBeVisible();
  await expect(page.getByTestId(`note-image-open-${DONE}`)).toBeFocused();
});

// 台账 #383 负责人 11-22“随手记跟隐私记里的图片改成可以保存到相册”：看图页底部“存到相册”（样式、位置照附件预览的底部按钮）。
// 系统分享面板在测试里换成桩（记下交出去的文件名、类型）；面板里点“存储图像”真的进了 iPhone 相册，电脑上验不了，只能真机看
async function stubShare(page: Page, can: boolean): Promise<void> {
  await page.addInitScript((ok) => {
    const w = window as unknown as { __shared: { name: string; type: string; size: number }[] };
    w.__shared = [];
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: ok ? (d: { files?: File[] }) => Array.isArray(d?.files) : undefined });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: ok ? async (d: { files: File[] }) => void w.__shared.push(...d.files.map((f) => ({ name: f.name, type: f.type, size: f.size }))) : undefined,
    });
  }, can);
}
const sharedFiles = (page: Page) => page.evaluate(() => (window as unknown as { __shared: { name: string; type: string; size: number }[] }).__shared);
// 测试图是 JPEG 字节（路径叫 .webp）：后缀按真实字节写 .jpg；没有拍摄时间，名字里是 id（uuidv7）的插入时间
const IMG_NAME = /^IMG_\d{8}_\d{6}\.jpg$/;

test('看图页存到相册（手机）：底部“存到相册”交给分享面板，文件名按时间、后缀按真实类型；日志不带文件名', async ({ page, baseURL, browserName }) => {
  await stubShare(page, true);
  await fakeServer(page, baseURL, true);
  await openNote(page);
  await viewer(page);
  const save = page.getByTestId('img-view-save');
  await expect(save).toHaveText('存到相册');
  // 和附件预览底部按钮同一套样式（PreviewLayer.module.css 的 .footBtn）：整条宽、高 44
  const box = await save.boundingBox();
  if (!box) throw new Error('没有存到相册按钮');
  expect(box.height).toBeGreaterThanOrEqual(43);
  expect(box.width).toBeGreaterThan(300);
  await save.click();
  await expect.poll(() => sharedFiles(page)).toHaveLength(1);
  const [f] = await sharedFiles(page);
  expect(f?.name).toMatch(IMG_NAME);
  expect(f?.type).toBe('image/jpeg');
  expect(f?.size).toBeGreaterThan(1000);
  await expect.poll(() => runLog(page)).toContain('img save shared');
  expect(await runLog(page)).not.toContain('IMG_');
  // 长按大图 iOS 自带的“存储到照片”没被挡（全局关了 touch-callout，大图单独开回来）
  expect(await page.getByTestId(`img-view-pic-${DONE}`).evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-touch-callout') || 'default')).toBe('default');
  await shot(page, browserName, '手机-看图页-存到相册');
});

test('看图页存图（手机，浏览器分享不了文件）：按钮写“下载”，点了下载', async ({ page, baseURL }) => {
  await stubShare(page, false);
  await fakeServer(page, baseURL, true);
  await openNote(page);
  await viewer(page);
  await expect(page.getByTestId('img-view-save')).toHaveText('下载');
  const dl = page.waitForEvent('download');
  await page.getByTestId('img-view-save').click();
  expect((await dl).suggestedFilename()).toMatch(IMG_NAME);
  await expect.poll(() => runLog(page)).toContain('img save downloaded');
});

test('看图浮层存图（电脑）：顶行“下载”（同附件预览电脑顶行），不弹分享面板', async ({ page, baseURL, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stubShare(page, true);
  await fakeServer(page, baseURL, true);
  await openNote(page);
  await viewer(page);
  await expect(page.getByTestId('img-view-save')).toHaveText('下载');
  const dl = page.waitForEvent('download');
  await page.getByTestId('img-view-save').click();
  expect((await dl).suggestedFilename()).toMatch(IMG_NAME);
  expect(await sharedFiles(page)).toEqual([]);
  await expect.poll(() => runLog(page)).toContain('img save downloaded');
  await shot(page, browserName, '电脑-看图浮层-下载');
});

// 负责人 11-18“有附件的将日期放到图片上面，不要左边突出来”（弹窗选“日期在图片正上方”）：列表里带图的行，
// 日期右边和缩略图右边对齐（和没图的行的日期同一条线），缩略图整个在日期下面
test('随手记列表带图的行：日期在缩略图正上方、右边对齐', async ({ page, baseURL, browserName }) => {
  await fakeServer(page, baseURL, true, true);
  await page.goto('/app/#/notes');
  const thumb = page.getByTestId(`notes-thumb-${NOTE}`);
  await expect(thumb).toBeVisible({ timeout: 30_000 });
  await afterPageFade(page); // 行的进场淡入走完再量
  const tm = page.getByTestId(`notes-row-${NOTE}`).locator('[class^="_tm_"]').first();
  // 评审截图同别处：设了 LEMO_SHOT_DIR、只在 Chromium（WebKit 截图往页面插 <style>、被 CSP 记成违规）；动画上面已经等完
  await shot(page, browserName, 'notes-thumb-date', { settleMs: 0 });
  const a = await tm.boundingBox();
  const b = await thumb.boundingBox();
  if (!a || !b) throw new Error('量不到日期或缩略图');
  expect(Math.abs(a.x + a.width - (b.x + b.width))).toBeLessThanOrEqual(1);
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
  // 负责人“前面的标题跟字要在中间”：左边标题 + 摘要整块的上下中线和右边“日期 + 缩略图”的中线对齐（差 ≤ 2px）
  const mid = await page.getByTestId(`notes-row-${NOTE}`).evaluate((r) => {
    const box = (sel: string) => r.querySelector(sel)?.getBoundingClientRect();
    const l = box('[class^="_tcol_"]');
    const s = box('[class^="_side_"]');
    return l && s ? Math.abs(l.top + l.height / 2 - (s.top + s.height / 2)) : 99;
  });
  expect(mid).toBeLessThanOrEqual(2);
});

// 负责人“随后记跟隐私记里的照片打开以后可以放大缩小查看”：手势用合成 pointer 在两种浏览器都跑；Chromium 再用 CDP 发真实双指，核整页没被放大
test.describe('看图页缩放', () => {
  test.use({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });

  test('捏合 1～4 倍、拖不出边界、双击切换；放大时不换张，1 倍时照常换张和关闭', async ({ page, baseURL, browserName }) => {
    await fakeServer(page, baseURL, true);
    await openNote(page);
    await viewer(page);
    const stage = page.getByTestId('img-view-stage');
    const layer = page.getByTestId('img-view-zoom');
    const pic = page.getByTestId(`img-view-pic-${DONE}`);
    const count = page.getByTestId('img-view-count');
    const box = await stage.boundingBox();
    if (!box) throw new Error('看图页没有图区');
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const fire = (type: string, id: number, x: number, y: number) =>
      stage.evaluate((el, a) => {
        el.dispatchEvent(new PointerEvent(a.type, { bubbles: true, cancelable: true, pointerId: a.id, pointerType: 'touch', isPrimary: a.id === 11, button: a.type === 'pointermove' ? -1 : 0, clientX: a.x, clientY: a.y }));
      }, { type, id, x, y });
    const pinch = async (from: number, to: number, cy = c.y) => {
      await fire('pointerdown', 11, c.x - from, cy);
      await fire('pointerdown', 12, c.x + from, cy);
      await fire('pointermove', 11, c.x - to, cy);
      await fire('pointermove', 12, c.x + to, cy);
      await fire('pointerup', 12, c.x + to, cy);
      await fire('pointerup', 11, c.x - to, cy);
    };
    const drag = async (dx: number, dy: number) => {
      await fire('pointerdown', 11, c.x, c.y);
      await fire('pointermove', 11, c.x + dx, c.y + dy);
      await fire('pointerup', 11, c.x + dx, c.y + dy);
    };
    const tap2 = async () => {
      for (let i = 0; i < 2; i++) {
        await fire('pointerdown', 11, c.x, c.y);
        await fire('pointerup', 11, c.x, c.y);
      }
    };
    const scale = () => layer.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
    const zoomed = () => layer.getAttribute('data-zoomed');

    if (process.env['LEMO_ZOOM_SHOT_DIR'] && browserName === 'chromium') await page.screenshot({ path: `${process.env['LEMO_ZOOM_SHOT_DIR']}/看图-1倍-430x932@3x.png` });

    // 看图区 touch-action 是 none，整页还是 pan-x pan-y
    expect(await stage.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe('pan-x pan-y');

    // 上限 4 倍；捏回去回到 1 倍
    await pinch(40, 400);
    expect(await scale()).toBeCloseTo(4, 2);
    await pinch(200, 10);
    await expect(layer).toHaveAttribute('data-zoomed', '0');

    // 以两指中点为中心：中点下面图上那一点的相对位置不变
    const before = await pic.boundingBox();
    if (!before) throw new Error('量不到图');
    const cy = before.y + before.height * 0.4;
    await pinch(50, 100, cy);
    expect(await scale()).toBeCloseTo(2, 2);
    const after = await pic.boundingBox();
    if (!after) throw new Error('量不到图');
    expect(Math.abs((cy - after.y) / after.height - 0.4)).toBeLessThan(0.01);

    // 放大后拖到头：图的边不进取景框；计数不变（不换张）
    const frame = await layer.evaluate((el) => {
      const r = (el.parentElement as HTMLElement).getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    });
    for (const [dx, dy] of [[-3000, -3000], [3000, 3000]] as const) {
      await drag(dx, dy);
      const r = await pic.boundingBox();
      if (!r) throw new Error('量不到图');
      expect(r.y).toBeLessThanOrEqual(frame.top + 1);
      expect(r.y + r.height).toBeGreaterThanOrEqual(frame.bottom - 1);
      if (r.width > frame.right - frame.left) {
        expect(r.x).toBeLessThanOrEqual(frame.left + 1);
        expect(r.x + r.width).toBeGreaterThanOrEqual(frame.right - 1);
      } else expect(Math.abs(r.x + r.width / 2 - (frame.left + frame.right) / 2)).toBeLessThan(1);
    }
    await expect(count).toHaveText('4 / 4');
    if (process.env['LEMO_ZOOM_SHOT_DIR'] && browserName === 'chromium') await page.screenshot({ path: `${process.env['LEMO_ZOOM_SHOT_DIR']}/看图-放大-430x932@3x.png` });

    // 双击：放大 → 1 倍 → 2.5 倍 → 1 倍；平时带过渡，减弱动态效果时不带
    await tap2();
    expect(await zoomed()).toBe('0');
    // data-rm 由 look.ts 在媒体查询变化后写，等它落定再点
    const rootRm = page.locator('html');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(rootRm).toHaveAttribute('data-rm', '1');
    await tap2();
    expect(await layer.getAttribute('data-anim')).toBeNull();
    expect(await scale()).toBeCloseTo(2.5, 2);
    await tap2();
    expect(await zoomed()).toBe('0');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(rootRm).not.toHaveAttribute('data-rm', '1');
    await page.waitForTimeout(350);
    await tap2();
    expect(await layer.getAttribute('data-anim')).toBe('1');
    await page.waitForTimeout(350);
    await tap2();
    await page.waitForTimeout(350);

    // 1 倍：横滑换张；放大后按键换张回到 1 倍
    await drag(160, 0);
    await expect(count).toHaveText('3 / 4');
    await page.keyboard.press('ArrowRight');
    await expect(count).toHaveText('4 / 4');
    await pinch(50, 100);
    expect(await zoomed()).toBe('1');
    await page.keyboard.press('ArrowLeft');
    await expect(count).toHaveText('3 / 4');
    expect(await zoomed()).toBe('0');
    await page.keyboard.press('ArrowRight');

    // Chromium：真实双指走浏览器手势管线，图放大、整页不放大
    if (browserName === 'chromium') {
      const cdp = await page.context().newCDPSession(page);
      const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', d: number) =>
        cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ id: 1, x: c.x - d, y: c.y }, { id: 2, x: c.x + d, y: c.y }] });
      await touch('touchStart', 40);
      for (const d of [60, 80, 100]) await touch('touchMove', d);
      await touch('touchEnd', 100);
      await expect.poll(scale).toBeGreaterThan(2);
      expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
    }

    // 放大时 Esc 照常关；日志只有状态
    if ((await zoomed()) !== '1') await pinch(50, 100);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('img-view')).toHaveCount(0);
    await expect.poll(() => runLog(page)).toContain('att view zoom in');
    const log = await runLog(page);
    expect(log).toContain('att view zoom out');
    expect(log).not.toContain('护照');
  });
});
