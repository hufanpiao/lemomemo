// 随手记输入行（R-416，负责人 11-13：“随手记输入完内容按回车记下后输入框应该消失，不是继续记下一条”“随手记选择要上传的图片后不应该直接记录”）
// jsdom 不算布局，这里用真浏览器守：
// ① 回车记下：输入框失焦（键盘收起）、模糊层没了、字清空；
// ② 选了图：先挂成待记下的小图（输入行正上方、和输入行左对齐、不压住输入行），不新建随手记；“×”去掉一张；
//    “×”看得见 24、点按区 44（离中心 18px 处点到的还是它）；手机上输入框有焦点时点“×”，输入框不失焦（台账 Q-25）
// ③ 提示条和小图同在输入行正上方的外框里：选一张 HEIC 点“记下”，出“请先转成 JPG”、图放回，提示条在小图上面、互不压住
// 键盘弹起时小图跟着输入行贴在键盘上（iOS 合成）这里测不了，只能 iPhone 看
import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

// 这份不录 trace（失败照样有截图）：③ 的假 HEIC 解不出来，Playwright 录 trace 截 DOM 快照时会去 fetch 这张坏图的 blob: 地址，
// 被页面 connect-src 拦下、记成 CSP 违规（11-13 查明：同一条 --trace=off 就 0 违规；页面自己不 fetch blob:）。
// trace 只能整份文件关（Playwright 不准在 describe 里改 trace）
// 截图只在 Chromium 上截：WebKit 下 page.screenshot() 会往页面插一个 <style>（加 caret: 'initial' 也一样），被页面 CSP 拦下、记成违规
// （11-13 CI #319 挂、本机逐步排查定位到截图这一步）；断言两种浏览器都跑
test.use({ trace: 'off' });

const SIZES = [
  { name: '手机', viewport: { width: 390, height: 844 }, hasTouch: true },
  { name: '电脑', viewport: { width: 1280, height: 800 }, hasTouch: false },
] as const;

/** 页面里用 canvas 画一张小 JPEG（选图用，内容随便） */
async function jpeg(page: Page, hue: number): Promise<Buffer> {
  const bytes = await page.evaluate(async (h) => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 240;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no_ctx');
    ctx.fillStyle = `hsl(${h} 70% 55%)`;
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = '#fff';
    ctx.fillRect(100, 70, 120, 100);
    const b = await new Promise<Blob>((res) => c.toBlob((x) => res(x as Blob), 'image/jpeg', 0.9));
    return [...new Uint8Array(await b.arrayBuffer())];
  }, hue);
  return Buffer.from(Uint8Array.from(bytes));
}

const box = async (page: Page, id: string) => {
  const b = await page.getByTestId(id).boundingBox();
  if (!b) throw new Error(`没有 ${id}`);
  return b;
};
/** 小图那一排看得见的范围（量第一张小图） */
const thumbs = async (page: Page) => {
  const b = await page.getByTestId('notes-pend').locator('li').first().boundingBox();
  if (!b) throw new Error('没有小图');
  return b;
};

for (const size of SIZES) {
  test.describe(`随手记输入行（R-416）· ${size.name}`, () => {
    test.use({ loggedIn: true, viewport: size.viewport, hasTouch: size.hasTouch, timezoneId: 'Asia/Seoul' });

    test('回车记下后输入框失焦、模糊层没了、字清空', async ({ page }) => {
      await page.goto('/app/#/notes');
      const input = page.getByTestId('notes-input');
      await expect(input).toBeVisible({ timeout: 20_000 });
      await input.click();
      await expect(page.getByTestId('notes-mist')).toBeVisible();
      await input.fill('买牛奶');
      await input.press('Enter');
      await expect(input).not.toBeFocused();
      await expect(page.getByTestId('notes-mist')).toHaveCount(0);
      await expect(input).toHaveValue('');
    });

    test('选图先挂在输入行正上方、不新建；“×”去掉一张', async ({ page, browserName }, info) => {
      await page.goto('/app/#/notes');
      const input = page.getByTestId('notes-input');
      await expect(input).toBeVisible({ timeout: 20_000 });
      // 电脑：等电脑版面板换上（B6；换上时输入行重挂，正在换的那一刻选的图会落在卸下的 input 上）
      if (!size.hasTouch) await expect(page.getByTestId('desk')).toBeVisible();
      const cards = await page.locator('[data-testid^="notes-card-"]').count();
      const pickInput = page.getByTestId('notes-img-input');
      await pickInput.setInputFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: await jpeg(page, 20) });
      await pickInput.setInputFiles({ name: 'b.jpg', mimeType: 'image/jpeg', buffer: await jpeg(page, 200) });
      const pend = page.getByTestId('notes-pend');
      await expect(pend.locator('li')).toHaveCount(2);
      await expect(pend.locator('img').first()).toHaveJSProperty('complete', true);
      await expect(page.getByTestId('notes-add')).toBeVisible();
      await page.waitForTimeout(300);
      expect(await page.locator('[data-testid^="notes-card-"]').count(), '选了图不新建随手记').toBe(cards);

      const row = await box(page, 'notes-input-row');
      const strip = await thumbs(page);
      expect(strip.y + strip.height, '小图在输入行上面、不压住').toBeLessThanOrEqual(row.y - 4);
      expect(row.y - (strip.y + strip.height), '离输入行不远（8px 左右）').toBeLessThanOrEqual(12);
      expect(Math.abs(strip.x - row.x), '和输入行左边对齐').toBeLessThanOrEqual(1);
      const del = await box(page, 'notes-pend-del-0');
      expect(del.width).toBe(24);
      // 点按区 44：离“×”中心往左下 18px 处，最上面的元素仍是这个按钮
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid]')?.getAttribute('data-testid') ?? null, { x: del.x + 12 - 18, y: del.y + 12 + 18 });
      expect(hit).toBe('notes-pend-del-0');
      if (browserName === 'chromium') {
        writeFileSync(info.outputPath('pend.png'), await page.screenshot());
        await info.attach('挂着两张图', { path: info.outputPath('pend.png'), contentType: 'image/png' });
      }

      // 输入框有焦点（手机上键盘弹着）时点“×”：输入框不失焦
      await input.click();
      await expect(input).toBeFocused();
      if (size.hasTouch) await page.getByTestId('notes-pend-del-0').tap();
      else await page.getByTestId('notes-pend-del-0').click();
      await expect(pend.locator('li')).toHaveCount(1);
      await expect(input).toBeFocused();
    });

    test('HEIC 点“记下”：提示条在小图上面、互不压住，图放回输入行', async ({ page, browserName }, info) => {
      await page.goto('/app/#/notes');
      await expect(page.getByTestId('notes-input')).toBeVisible({ timeout: 20_000 });
      if (!size.hasTouch) await expect(page.getByTestId('desk')).toBeVisible(); // 同上一条：等电脑版面板换上
      const heic =Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99, 0, 0, 0, 0]);
      await page.getByTestId('notes-img-input').setInputFiles({ name: 'IMG_1.HEIC', mimeType: 'image/heic', buffer: heic });
      await page.getByTestId('notes-add').click();
      const tip = page.getByTestId('notes-img-tip');
      await expect(tip).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('notes-pend').locator('li')).toHaveCount(1);
      // 浏览器打不开这张：不画破图标，只留灰底方块
      await expect(page.getByTestId('notes-pend').locator('img')).toHaveCount(0);
      const t = await box(page, 'notes-img-tip');
      const strip = await thumbs(page);
      const row = await box(page, 'notes-input-row');
      expect(t.y + t.height, '提示条在小图上面、不压住').toBeLessThanOrEqual(strip.y - 4);
      expect(strip.y + strip.height, '小图在输入行上面、不压住').toBeLessThanOrEqual(row.y - 4);
      if (browserName === 'chromium') {
        writeFileSync(info.outputPath('tip.png'), await page.screenshot());
        await info.attach('提示条和小图', { path: info.outputPath('tip.png'), contentType: 'image/png' });
      }
    });
  });
}
