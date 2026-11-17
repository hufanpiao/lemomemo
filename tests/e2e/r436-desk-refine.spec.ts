// 电脑版精致化 e2e（R-436 最后一处：侧栏、详情抽屉、随手记分类栏；照待办页 518f49a0 的做法，视觉稿 皮肤视觉稿.html .desk、电脑版布局-对比.html 方案 B）：
// • 随手记分类栏是 kit 的 Chip（负责人 11-16“胶囊太大了！参考现在的待办页”）：高 30、没有描边、条数等宽字；没选中的不铺浅底，选中的是 kit .chipOn
// • 详情抽屉：圆角 24、磨砂玻璃皮肤下背景模糊 24px（视觉稿 .desk .col.ed 带 blur(var(--b-blur))，底下列表的字不再透上来）；
//   换边把手和编辑器顶行（随手记的分类胶囊、待办的“待办”）、“×”在同一行；抽屉里的类型名是 14px 常规字重
// • 小块标题（“今天的安排”等）挂 kit groupLabelClass（等宽小字）；侧栏页签没选中常规字重、选中半粗（视觉稿 .rail .rt）
// chromium、webkit 都跑；视口和数据同 b6-desk-*（b6-desk-helpers.ts）
import type { Locator } from '@playwright/test';
import { FADE_GUARD_MS } from '../../src/motion/index.ts';
import { DESK_USE, openToday, seedNotes, seedToday, TODAY_IDS } from './b6-desk-helpers.ts';
import { expect, test } from './session-fixture.ts';

test.use(DESK_USE);

/** 元素竖直中线（视口坐标，取整） */
const midY = (l: Locator) => l.evaluate((el) => Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2));
/** 背景模糊（WebKit 旧版只认带前缀的那个） */
const blurOf = (l: Locator) =>
  l.evaluate((el) => {
    const cs = getComputedStyle(el) as CSSStyleDeclaration & { webkitBackdropFilter?: string };
    return cs.backdropFilter || cs.webkitBackdropFilter || '';
  });

test('随手记页：分类栏是 kit 胶囊；抽屉圆角 24、背景模糊，换边把手和分类胶囊、“×”同一行', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-12T12:00:00+09:00'));
  await page.goto('/app/#/notes');
  await expect(page.getByTestId('desk-panel-list')).toBeVisible({ timeout: 20_000 });
  await seedNotes(page);
  const cats = page.getByTestId('desk-panel-cats');
  const all = cats.getByTestId('notes-filter-all');
  await expect(all).toContainText('6', { timeout: 20_000 });
  const one = cats.getByTestId('notes-filter-0e2e0000-0000-4000-8000-0000000006a2');
  const look = (l: Locator) =>
    l.evaluate((el) => {
      const cs = getComputedStyle(el);
      const n = el.lastElementChild;
      return { h: Math.round(el.getBoundingClientRect().height), border: cs.borderTopWidth, bg: cs.backgroundColor, mono: n ? getComputedStyle(n).fontFamily : '' };
    });
  const on = await look(all);
  const off = await look(one);
  expect(on.h).toBe(30);
  expect(off.h).toBe(30);
  expect(off.border).toBe('0px');
  expect(off.mono).toMatch(/mono/i);
  expect(off.bg).toBe('rgba(0, 0, 0, 0)');
  expect(on.bg).not.toBe('rgba(0, 0, 0, 0)');

  await page.waitForTimeout(FADE_GUARD_MS);
  await page.locator('[data-testid^="notes-card-"]', { hasText: '牛奶' }).locator('button').first().click();
  const drawer = page.getByTestId('note-drawer');
  await expect(drawer).toBeVisible();
  expect(await drawer.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('24px');
  expect(await blurOf(drawer)).toContain('blur(24px)');
  const grip = page.getByTestId('desk-drawer-side');
  // 滑入动画走完再量（竖直方向不动，只是稳妥起见等一等位置稳定）
  await expect.poll(async () => Math.abs((await midY(grip)) - (await midY(page.getByTestId('note-edit-chip'))))).toBeLessThanOrEqual(1);
  expect(Math.abs((await midY(grip)) - (await midY(page.getByTestId('note-edit-close'))))).toBeLessThanOrEqual(1);
  // 把手在胶囊左边、不压住它
  const gripRight = await grip.evaluate((el) => el.getBoundingClientRect().right);
  const chipLeft = await page.getByTestId('note-edit-chip').evaluate((el) => el.getBoundingClientRect().left);
  expect(gripRight).toBeLessThanOrEqual(chipLeft);
});

test('今天页：小块标题等宽小字；待办抽屉类型名 14px 常规、和换边把手同一行；侧栏页签字重', async ({ page }) => {
  await openToday(page);
  await seedToday(page);
  const todo = page.locator(`[data-open="${TODAY_IDS.todo}"]`);
  await expect(todo).toBeVisible({ timeout: 20_000 });
  const title = page.getByTestId('desk-panel-week').getByRole('heading').first();
  expect(await title.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono/i);

  const nav = page.getByRole('navigation');
  const weight = (name: string) => nav.getByRole('link', { name }).evaluate((el) => getComputedStyle(el).fontWeight);
  expect(await weight('今天')).toBe('600');
  expect(await weight('待办')).toBe('400');

  await page.waitForTimeout(FADE_GUARD_MS);
  await todo.click();
  const drawer = page.getByTestId('today-drawer');
  await expect(drawer).toBeVisible();
  const kind = drawer.getByRole('heading', { name: '待办' });
  const k = await kind.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { size: cs.fontSize, weight: cs.fontWeight };
  });
  expect(k).toEqual({ size: '14px', weight: '400' });
  await expect.poll(async () => Math.abs((await midY(page.getByTestId('desk-drawer-side'))) - (await midY(kind)))).toBeLessThanOrEqual(1);
});
