// R-381（负责人 11-11“进入设置的头像页面在日历跟代办上也放一个吧，不然不和谐”）：今天、待办、日历、随手记四页右上角都是同一个设置入口头像（kit 的 MeLink）。
// • 手机 375 宽：四页头像都看得见，大小一样（44 × 44），右边缘离视口右边一样远，竖直位置相差不超过 ROW_TOL（四页标题行高本来不同，只要求在同一带）；
//   点了都进设置首页；日历上从头像起手往左划不翻月（手势挂在下面的翻页容器上）。
// • 电脑宽屏（≥ 900）：四页都藏掉（设置入口在侧栏）。
// • LEMO_R381_SHOTS 指一个目录时（只在 chromium 上）：四页浅色、深色各截一张整屏图，给主持人对照（不进仓库）
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const PAGES = [
  ['today', 'today-settings'],
  ['todos', 'todos-settings'],
  ['calendar', 'cal-settings'],
  ['notes', 'notes-settings'],
] as const;
/** 四页标题行的高度不同（今天页日期 + 头像、日历胶囊 44、待办和随手记标题 22 号字），头像中心竖直位置允许差这么多 */
const ROW_TOL = 12;

test.use({ loggedIn: true, locale: 'zh-CN', timezoneId: 'Asia/Seoul' });

async function openPage(page: Page, route: string): Promise<void> {
  await page.goto(`/app/#/${route}`);
  await page.locator(`main[data-feature]`).first().waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30_000 });
}

test('手机 375 宽：四页右上角都有设置头像，大小、右边距一样，竖直在同一带；点了进设置', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 375, height: 812 });
  const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const [route, id] of PAGES) {
    await openPage(page, route);
    const me = page.getByTestId(id);
    await expect(me).toBeVisible();
    await expect(me).toHaveAttribute('href', /#\/settings$/);
    await expect(me).toHaveAccessibleName('设置');
    const b = await me.boundingBox();
    expect(b, id).not.toBeNull();
    if (b) boxes[route] = b;
    await me.click();
    await page.locator('[data-testid^="settings-card-"]').first().waitFor({ timeout: 10_000 });
  }
  const ref = boxes['today'];
  expect(ref).toBeDefined();
  if (!ref) return;
  for (const [route] of PAGES) {
    const b = boxes[route];
    if (!b) throw new Error(route);
    expect([route, Math.round(b.width), Math.round(b.height)]).toEqual([route, 44, 44]);
    expect([route, Math.round(375 - b.x - b.width)]).toEqual([route, Math.round(375 - ref.x - ref.width)]);
    expect(Math.abs(b.y + b.height / 2 - (ref.y + ref.height / 2)), `${route} 竖直位置`).toBeLessThanOrEqual(ROW_TOL);
  }
});

/** 用手指（pointerType touch；横滑不认鼠标，motion/swipe-pager.ts）从 (x, y) 往左划 200px：事件发给落点上的元素，往上冒泡 */
async function dragLeft(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    async ([x0, y0]) => {
      const el = document.elementFromPoint(x0, y0);
      if (!el) throw new Error('nothing at point');
      const at = (type: string, x: number): boolean =>
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y0, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
      at('pointerdown', x0);
      for (let k = 1; k <= 8; k++) {
        at('pointermove', x0 - k * 25);
        await new Promise((r) => setTimeout(r, 16));
      }
      at('pointerup', x0 - 200);
    },
    [x, y] as const,
  );
  await page.waitForTimeout(600);
}

test('日历：从头像起手往左划不翻月；对照：同样划翻页容器会翻到下个月（横滑只认翻页容器）', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openPage(page, 'calendar');
  const title = page.getByTestId('cal-title');
  const before = (await title.textContent()) ?? '';
  const b = await page.getByTestId('cal-settings').boundingBox();
  if (!b) throw new Error('no avatar');
  await dragLeft(page, b.x + b.width / 2, b.y + b.height / 2);
  await expect(title).toHaveText(before);
  const p = await page.getByTestId('cal-pager').boundingBox();
  if (!p) throw new Error('no pager');
  await dragLeft(page, p.x + p.width - 40, p.y + p.height / 2);
  await expect(title).not.toHaveText(before);
});

test('电脑宽屏：四页右上角头像都藏掉（设置入口在侧栏）', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const [route, id] of PAGES) {
    await openPage(page, route);
    await expect(page.getByTestId(id), id).toBeHidden();
  }
});

test('对照截图（LEMO_R381_SHOTS 给了目录才截；只在 chromium）', async ({ page, browserName }) => {
  const dir = process.env['LEMO_R381_SHOTS'];
  test.skip(!dir || browserName !== 'chromium', '不截图');
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 375, height: 812 });
  // 深浅：入口页写死 data-theme="light"，页面画好以后直接改（不经设置页；同 visual/tabbar-lock.spec.ts 改 data-theme 的口径）
  for (const scheme of ['light', 'dark'] as const) {
    for (const [route] of PAGES) {
      await openPage(page, route);
      await page.evaluate((v) => (document.documentElement.dataset['theme'] = v), scheme);
      await page.waitForTimeout(600);
      expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBe(scheme);
      await page.screenshot({ path: `${dir}/r381-${route}-${scheme}.png` });
    }
  }
});
