// 电脑版今天页（B6 返工 11-14，主持人对照定稿线框 s1 和电脑版布局-对比“共用拖动规则”退回的几条）的真浏览器用例，chromium、webkit 都跑（1280×820）：
//   ⑦ 时间河是一整块（“现在”卡、没赶上、今天的安排都在 river 块里）；日期行有农历、下面有纪念日胶囊，不在任何可拖的块里
//   ⑧ 选中一条：详情抽屉从右边盖上来（日程、待办各一次）；Esc、× 关上，焦点回到那一行
//   ⑨ 本周、快到了、今天记的标题右边有跳转，“今天记的 N”带条数；点“日历 ›”进日历页
//   ⑩ 右栏的块全收起：右栏不画（不留空栏），左栏占满；同一时间只有一个撤销条（“布局已保存”和删除的“已删除 · 撤销”不叠在一起）
//   ⑪ “＋”气泡（前 3 次打开出）在侧栏“＋”右边、整块在视口里，三角朝左
//   ⑫ 已过去折成一行（线框 s1“已过去的折叠成一行”）：结束了的日程不在列表里，点这一行展开、再点收起；手机宽度同样折
//   ⑬ “今天记的”里点一条：在今天页的详情抽屉里打开（不换页），Esc 关上焦点回到那一行
//   ⑭ 列表里删掉抽屉开着的那一条：抽屉一起关（独立评审第 11 条）
// 评审截图（设了 LEMO_SHOT_DIR 才截、只在 Chromium 上截）：今天页（含抽屉打开）、随手记页（含抽屉），1280×800、1440×900，浅色、深色
// 点按前等 FADE_GUARD_MS（页面分包挂上后这段时间里落在 main 里的点按按设计吞掉）
import { FADE_GUARD_MS } from '../../src/motion/index.ts';
import { DESK_USE, inCol, openToday, PAST_ID, seedNotes, seedToday, shot, SHOT_DIR, TODAY_IDS } from './b6-desk-helpers.ts';
import { expect, test } from './session-fixture.ts';

test.use(DESK_USE);

test.describe('B6 电脑版今天页', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
    await seedToday(page);
    await expect(page.getByTestId('desk-panel-river').locator(`[data-open="${TODAY_IDS.live}"]`)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(FADE_GUARD_MS);
  });

  test('⑦ 时间河一整块；日期行带农历和纪念日胶囊，不在可拖的块里', async ({ page }) => {
    const river = page.getByTestId('desk-panel-river');
    await expect(river.getByTestId('today-late')).toBeVisible();
    await expect(river.getByTestId('today-list')).toBeVisible();
    await expect(river.locator(`[data-open="${TODAY_IDS.late}"]`)).toBeVisible();
    await expect(page.getByTestId('desk-panel-now')).toHaveCount(0);
    await expect(page.locator('h1')).toContainText('农历');
    const chip = page.getByTestId('today-anniv');
    await expect(chip).toContainText('김지민');
    await expect(page.getByTestId('desk').getByTestId('today-anniv')).toHaveCount(0);
    await expect(inCol(page, 1, 'keys')).toContainText('Ctrl+N');
  });

  test('⑧ 详情抽屉：日程、待办；Esc、× 关上，焦点回到那一行', async ({ page }) => {
    const live = page.locator(`[data-open="${TODAY_IDS.live}"]`);
    await live.click();
    const drawer = page.getByTestId('today-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('event-edit-title')).toHaveValue('NEOX 横版对片');
    await expect(live).toHaveAttribute('aria-current', 'true');
    await expect(page).toHaveURL(/#\/today$/);
    // 抽屉从右边盖上来：右沿离窗口右边 16
    await expect.poll(() => drawer.evaluate((el) => Math.round(window.innerWidth - el.getBoundingClientRect().right))).toBe(16);
    // 抽屉开着时 Ctrl+N 打开打字条、在里面按 Esc：只关打字条，抽屉还在（独立评审第 1 条）
    await page.keyboard.press('ControlOrMeta+n');
    await expect(page.getByTestId('type-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('type-bar')).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(live).toBeFocused();

    const todo = page.locator(`[data-open="${TODAY_IDS.todo}"]`);
    await todo.click();
    await expect(drawer.getByTestId('todo-edit-title')).toHaveValue('NEOX 竖版 4K 导出');
    await drawer.getByTestId('todo-edit-close').click();
    await expect(drawer).toHaveCount(0);
    await expect(todo).toBeFocused();
  });

  test('⑨ 标题右边的跳转和条数', async ({ page }) => {
    await expect(page.getByTestId('desk-go-week')).toHaveText('日历 ›');
    await expect(page.getByTestId('desk-go-soon')).toHaveText('纪念日 ›');
    await expect(page.getByTestId('desk-go-notes-today')).toHaveText('随手记 ›');
    await expect(page.getByTestId('desk-panel-notes-today').locator('h2')).toHaveText('今天记的 0');
    await page.getByTestId('desk-go-week').click();
    await expect(page).toHaveURL(/#\/calendar/);
  });

  test('⑩ 右栏全收起不留空栏；撤销条同一时间只有一条', async ({ page }) => {
    const a = await page.getByTestId('desk-col-0').boundingBox();
    const b = await page.getByTestId('desk-col-1').boundingBox();
    const total = a && b ? b.x + b.width - a.x : 0;
    for (const id of ['week', 'soon', 'notes-today', 'keys']) await page.getByTestId(`desk-fold-${id}`).click();
    await expect(page.getByTestId('desk-col-1')).toHaveCount(0);
    await expect.poll(async () => Math.abs(((await page.getByTestId('desk-col-0').boundingBox())?.width ?? 0) - total)).toBeLessThan(2);
    await expect(page.getByTestId('desk-saved')).toBeVisible();
    // 删一条待办：出“已删除 · 撤销”，“布局已保存”收起
    await page.getByTestId(`today-del-${TODAY_IDS.todo}`).click();
    await expect(page.getByTestId('today-toast')).toBeVisible();
    await expect(page.getByTestId('desk-saved')).toHaveCount(0);
    await expect(page.locator('[data-undo-toast]')).toHaveCount(1);
  });

  test('⑪ 电脑宽度不出“＋”气泡（B4b-3，定稿线框 R-126 方案 B 侧栏没有提示；原来放“＋”右边盖住纪念日胶囊）', async ({ page }) => {
    await expect(page.getByTestId('tabbar-add')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);
    await expect(page.getByTestId('plus-hint')).toHaveCount(0);
  });
});

test.describe('B6 对齐线框：已过去、今天记的、删开着的那条', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
    await seedToday(page);
    await expect(page.getByTestId('desk-panel-river').locator(`[data-open="${TODAY_IDS.live}"]`)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(FADE_GUARD_MS);
  });

  test('⑫ 已过去折成一行：结束了的日程收进去，点了展开、再点收起', async ({ page, browserName }) => {
    const fold = page.getByTestId('desk-panel-river').getByTestId('today-past');
    await expect(fold).toContainText('已过去 1 件：');
    await expect(fold).toContainText('SignPlex 字幕校对');
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator(`[data-open="${PAST_ID}"]`)).toHaveCount(0);
    await shot(page, browserName, '对齐-今天已过去收起-1280');
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(`[data-open="${PAST_ID}"]`)).toBeVisible();
    await shot(page, browserName, '对齐-今天已过去展开-1280');
    await fold.click();
    await expect(page.locator(`[data-open="${PAST_ID}"]`)).toHaveCount(0);
  });

  test('⑬ “今天记的”点一条：今天页的详情抽屉里打开随手记，不换页；Esc 关上焦点回到那一行', async ({ page, browserName }) => {
    await seedNotes(page);
    const row = page.getByTestId('today-notes').locator('[data-open]').first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(FADE_GUARD_MS);
    await row.click();
    const drawer = page.getByTestId('today-drawer');
    await expect(drawer.getByTestId('note-edit-body')).toBeVisible({ timeout: 20_000 });
    await expect(drawer.getByTestId('note-edit-body')).toBeFocused();
    await expect(page).toHaveURL(/#\/today$/);
    await expect(row).toHaveAttribute('aria-current', 'true');
    await shot(page, browserName, '对齐-今天记的抽屉-1280');
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(row).toBeFocused();
  });

  test('⑭ 列表里删掉抽屉开着的那一条：抽屉一起关，只剩页底一个撤销', async ({ page }) => {
    await page.locator(`[data-open="${TODAY_IDS.todo}"]`).click();
    const drawer = page.getByTestId('today-drawer');
    await expect(drawer.getByTestId('todo-edit-title')).toHaveValue('NEOX 竖版 4K 导出');
    await page.getByTestId(`today-del-${TODAY_IDS.todo}`).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByTestId('today-toast')).toBeVisible();
  });
});

test.describe('B6 对齐线框：手机宽度的已过去', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('⑫ 手机宽度：已过去同样折成一行，点了展开', async ({ page, browserName }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible({ timeout: 20_000 });
    await seedToday(page);
    const fold = page.getByTestId('today-past');
    await expect(fold).toContainText('已过去 1 件：', { timeout: 20_000 });
    await expect(page.getByTestId('desk')).toHaveCount(0);
    await expect(page.locator(`[data-open="${PAST_ID}"]`)).toHaveCount(0);
    await expect(page.getByTestId('today-anniv')).toContainText('김지민 生日');
    await shot(page, browserName, '对齐-今天手机已过去收起-390');
    await page.waitForTimeout(FADE_GUARD_MS);
    await fold.click();
    await expect(page.locator(`[data-open="${PAST_ID}"]`)).toBeVisible();
    await shot(page, browserName, '对齐-今天手机已过去展开-390');
  });
});

test.describe('B6 评审截图', () => {
  test.skip(!SHOT_DIR, '设了 LEMO_SHOT_DIR 才截');

  for (const [w, h] of [
    [1280, 800],
    [1440, 900],
  ] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`截图 ${w}×${h} ${scheme}`, async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', '只在 Chromium 上截');
        await page.setViewportSize({ width: w, height: h });
        await page.emulateMedia({ colorScheme: scheme });
        const tag = `${w}x${h}-${scheme}`;
        // 前 3 次打开：电脑宽度不出“＋”气泡（B4b-3），纪念日胶囊不被盖住
        await openToday(page);
        await seedToday(page);
        await expect(page.locator(`[data-open="${TODAY_IDS.live}"]`)).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId('plus-hint')).toHaveCount(0);
        await shot(page, browserName, `今天首次打开-${tag}`);

        await page.goto('/app/#/notes');
        await expect(page.getByTestId('desk-panel-list')).toBeVisible({ timeout: 20_000 });
        await seedNotes(page);
        await expect(page.locator('[data-testid^="notes-card-"]')).toHaveCount(6, { timeout: 20_000 });
        await expect(page.getByTestId('plus-hint')).toHaveCount(0);
        await shot(page, browserName, `随手记-${tag}`);
        await page.waitForTimeout(FADE_GUARD_MS);
        await page.locator('[data-testid^="notes-card-"]', { hasText: '牛奶' }).locator('button').first().click();
        await expect(page.getByTestId('note-drawer')).toBeVisible();
        await shot(page, browserName, `随手记抽屉-${tag}`);
        await page.keyboard.press('Escape');

        await openToday(page);
        await expect(page.locator(`[data-open="${TODAY_IDS.live}"]`)).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('h1')).toContainText('农历');
        await shot(page, browserName, `今天-${tag}`);
        await page.waitForTimeout(FADE_GUARD_MS);
        await page.locator(`[data-open="${TODAY_IDS.live}"]`).click();
        await expect(page.getByTestId('today-drawer')).toBeVisible();
        await shot(page, browserName, `今天抽屉-${tag}`);
        await page.keyboard.press('Escape');
        await page.getByTestId('desk-more').click();
        await shot(page, browserName, `今天布局菜单-${tag}`);
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width: 1024, height: h });
        await shot(page, browserName, `今天一列1024-${tag}`);
      });
    }
  }
});
