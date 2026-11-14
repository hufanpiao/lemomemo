// 电脑版可拖动布局（B6，架构 5.9b，R-120、R-126 方案 B；定稿线框 s1、s7 电脑画面）的真浏览器用例，chromium、webkit 都跑（视口一律 1280×820 电脑宽度）：
//   ① 今天页两栏：鼠标按住把手把“本周”拖到左栏，出“布局已保存”，刷新后还在；点“撤销”回原位；再拖一次，“⋯ › 恢复默认布局”回默认
//   ② 栏宽（竖条 → 键）、收起再从“⋯”放回、锁定后把手和竖条都不画
//   ③ 键盘拖动：把手上空格拿起、← 挪到左栏、空格放下，每一步 aria-live 有播报；axe（WCAG 2.1 A/AA）无 serious、critical
//   ④ 1099px 宽排成一列（同一棵树，各栏竖着叠、块不重挂）、不能拖；回到 1280 恢复分栏
//   ⑤ 随手记页：分类一栏（点了筛选）+ 列表一栏；点卡片开抽屉，点抽屉顶上的把手换到左边，关了再开还在左边
// 点按前等 FADE_GUARD_MS（页面分包挂上后这段时间里落在 main 里的点按按设计吞掉，见 b5-anniv.spec.ts）
// 共用的打开、拖动、读本机库、种数据在 b6-desk-helpers.ts；今天页抽屉、标题跳转、撤销条、“＋”气泡和评审截图在 b6-desk-today.spec.ts
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { FADE_GUARD_MS } from '../../src/motion/index.ts';
import { DESK_USE, drag, inCol, openToday, seedNotes, stored } from './b6-desk-helpers.ts';
import { expect, test } from './session-fixture.ts';

test.use(DESK_USE);

const AXE_SRC = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

test.describe('B6 电脑版布局：今天页', () => {
  test.beforeEach(async ({ page }) => openToday(page));

  test('① 拖一块跨栏、刷新还在、撤销、恢复默认', async ({ page }) => {
    await expect(inCol(page, 1, 'week')).toBeVisible();
    await drag(page, page.getByTestId('desk-handle-week'), page.getByTestId('desk-panel-river'));
    await expect(inCol(page, 0, 'week')).toBeVisible();
    await expect(page.getByTestId('desk-saved')).toContainText('布局已保存');
    // 存下的第一栏里有 week（落在 river 前还是后看落点，两种浏览器会差一点，不比顺序）
    await expect.poll(() => stored(page, 'today'), { timeout: 10_000 }).toMatch(/"cols":\[\{"w":[\d.]+,"panels":\[[^\]]*"week"/);
    await page.reload();
    await expect(inCol(page, 0, 'week')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(FADE_GUARD_MS);

    // 刷新后提示条没了：再拖一次（拖回右栏）再撤销，回到左栏
    await drag(page, page.getByTestId('desk-handle-week'), page.getByTestId('desk-panel-notes-today'));
    await expect(inCol(page, 1, 'week')).toBeVisible();
    await page.getByTestId('desk-saved-undo').click();
    await expect(inCol(page, 0, 'week')).toBeVisible();

    await page.getByTestId('desk-more').click();
    await page.getByTestId('desk-reset').click();
    await expect(inCol(page, 1, 'week')).toBeVisible();
    await expect.poll(() => stored(page, 'today'), { timeout: 10_000 }).toContain('"panels":["river"]');
    await page.reload();
    await expect(inCol(page, 1, 'week')).toBeVisible({ timeout: 20_000 });
  });

  test('② 调栏宽、收起再放回、锁定', async ({ page }) => {
    // “⋯”在侧栏底部、设置入口正上方（横向同一中线，在它上面）
    await expect(page.getByTestId('desk-more')).toBeVisible();
    const moreBox = await page.getByTestId('desk-more').boundingBox();
    const meBox = await page.getByTestId('tabbar-settings').boundingBox();
    expect(moreBox && meBox && Math.abs(moreBox.x + moreBox.width / 2 - (meBox.x + meBox.width / 2))).toBeLessThan(1);
    expect(moreBox && meBox && meBox.y - (moreBox.y + moreBox.height)).toBeGreaterThanOrEqual(4);
    const col0 = page.getByTestId('desk-col-0');
    await expect(page.getByTestId('desk-col-1')).toBeVisible();
    // 等两栏排好（WebKit 刚挂上时偶尔还是上一帧的宽度）：默认左栏约占 0.56
    await expect.poll(async () => (await col0.boundingBox())?.width ?? 0).toBeLessThan(800);
    const w0 = (await col0.boundingBox())?.width ?? 0;
    await page.getByTestId('desk-sep-0').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await col0.boundingBox())?.width ?? 0).toBeGreaterThan(w0 + 40);
    await expect(page.getByTestId('desk-saved')).toBeVisible();

    await page.getByTestId('desk-fold-soon').click();
    await expect(page.getByTestId('desk-panel-soon')).toHaveCount(0);
    await page.getByTestId('desk-more').click();
    await page.getByTestId('desk-restore-soon').click();
    await expect(inCol(page, 1, 'soon')).toBeVisible();

    await page.getByTestId('desk-more').click();
    await page.getByTestId('desk-lock').click();
    await expect(page.getByTestId('desk')).toHaveAttribute('data-locked', '');
    await expect(page.locator('[data-testid^="desk-handle-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="desk-sep-"]')).toHaveCount(0);
    await page.getByTestId('desk-more').click();
    await page.getByTestId('desk-lock').click();
    await expect(page.getByTestId('desk-handle-week')).toBeVisible();
  });

  test('③ 键盘拖动有播报；拿起后 Tab 走开回原位；axe 无严重问题', async ({ page }) => {
    const live = page.getByTestId('desk-live');
    await page.getByTestId('desk-handle-soon').focus();
    await page.keyboard.press('Space');
    await expect(live).toContainText('拿起了“快到了”，第 2 栏');
    await page.keyboard.press('ArrowLeft');
    await expect(live).toContainText('“快到了”，第 1 栏');
    await page.keyboard.press('Space');
    await expect(live).toContainText('放下了“快到了”，第 1 栏');
    await expect(inCol(page, 0, 'soon')).toBeVisible();
    await expect(page.getByTestId('desk-handle-soon')).toBeFocused();

    // Esc 取消：拿起、挪、Esc，回到原位
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    await expect(live).toContainText('已取消');
    await expect(inCol(page, 0, 'soon')).toBeVisible();

    // 拿起、挪、Tab 走开：放弃，回原位、不保存（评审第 2 条）
    await page.getByTestId('desk-handle-soon').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await expect(inCol(page, 1, 'soon')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(inCol(page, 0, 'soon')).toBeVisible();
    await expect(page.locator('[data-held]')).toHaveCount(0);

    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    await page.evaluate(AXE_SRC);
    const bad = await page.evaluate(async () => {
      type Res = { violations: { id: string; impact: string | null; nodes: { target: unknown[] }[] }[] };
      const w = window as unknown as { axe: { run: (ctx: Document, o: unknown) => Promise<Res> } };
      const r = await w.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] });
      return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} ${JSON.stringify(v.nodes.slice(0, 3).map((n) => n.target))}`);
    });
    expect(bad, bad.join('\n')).toEqual([]);
  });

  test('④ 1099px 排成一列（各栏竖着叠）、不能拖；回到 1280 恢复分栏；两种排法是同一棵树，块不重挂', async ({ page }) => {
    // 给块的元素打个记号：跨过 1100px 以后还是同一个元素（重挂了记号就没了）
    await page.getByTestId('desk-panel-week').evaluate((el) => Object.assign(el, { __b6mark: 1 }));
    await page.setViewportSize({ width: 1099, height: 820 });
    await expect(page.getByTestId('desk')).toHaveAttribute('data-desk', 'one');
    await expect(page.locator('[data-testid^="desk-handle-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="desk-sep-"]')).toHaveCount(0);
    const a = await page.getByTestId('desk-col-0').boundingBox();
    const b = await page.getByTestId('desk-col-1').boundingBox();
    // 第二栏排在第一栏下面、左边对齐
    expect(b && a && b.y >= a.y + a.height - 1 && Math.abs(b.x - a.x) < 1).toBe(true);
    await expect(inCol(page, 1, 'week')).toBeVisible();
    expect(await page.getByTestId('desk-panel-week').evaluate((el) => (el as unknown as { __b6mark?: number }).__b6mark)).toBe(1);
    await page.setViewportSize({ width: 1280, height: 820 });
    await expect(page.getByTestId('desk')).toHaveAttribute('data-desk', 'cols');
    await expect(inCol(page, 1, 'week')).toBeVisible();
    expect(await page.getByTestId('desk-panel-week').evaluate((el) => (el as unknown as { __b6mark?: number }).__b6mark)).toBe(1);
  });
});

test.describe('B6 电脑版布局：随手记页', () => {
  test('⑤ 分类一栏 + 列表一栏；抽屉换边、记住', async ({ page }) => {
    await page.goto('/app/#/notes');
    await expect(page.getByTestId('desk-panel-list')).toBeVisible({ timeout: 20_000 });
    await seedNotes(page);
    await expect(page.getByTestId('desk-panel-cats').getByTestId('notes-filter-all')).toContainText('6', { timeout: 20_000 });
    await page.waitForTimeout(FADE_GUARD_MS);

    await page.getByTestId('notes-filter-0e2e0000-0000-4000-8000-0000000006a3').click();
    await expect(page.locator('[data-testid^="notes-card-"]')).toHaveCount(1);
    await expect(page.getByTestId('desk-panel-list')).toContainText('读书 1');
    await page.getByTestId('notes-filter-all').click();
    await expect(page.locator('[data-testid^="notes-card-"]')).toHaveCount(6);

    const card = page.locator('[data-testid^="notes-card-"]', { hasText: '牛奶' }).locator('button').first();
    await card.click();
    const drawer = page.getByTestId('note-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).not.toHaveAttribute('data-side', 'left');
    await page.getByTestId('desk-drawer-side').click();
    await expect(drawer).toHaveAttribute('data-side', 'left');
    // 换到左边时不压住侧栏：左沿离侧栏右沿 16（NoteEditPage.module.css 的 --drawer-left 110 = 侧栏左 16 + 宽 78 + 16；滑入动画走完再量）
    const railRight = await page.getByRole('navigation').evaluate((el) => el.getBoundingClientRect().right);
    await expect.poll(() => drawer.evaluate((el) => Math.round(el.getBoundingClientRect().left))).toBe(Math.round(railRight) + 16);
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect.poll(() => stored(page, 'notes'), { timeout: 10_000 }).toContain('"drawer":"left"');
    // 提示条还在时，在输入行里按 Ctrl+Z 是撤销打字，不撤销布局（评审第 1 条）；list 块不能收起（输入行在里面，评审第 3 条）
    await expect(page.getByTestId('desk-saved')).toBeVisible();
    await page.getByTestId('notes-input').click();
    await page.keyboard.type('ab');
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('desk-saved')).toBeVisible();
    expect(await stored(page, 'notes')).toContain('"drawer":"left"');
    await expect(page.getByTestId('desk-fold-list')).toHaveCount(0);
    await expect(page.getByTestId('desk-fold-cats')).toHaveCount(1);
    await page.reload();
    await expect(page.locator('[data-testid^="notes-card-"]', { hasText: '牛奶' })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(FADE_GUARD_MS);
    await page.locator('[data-testid^="notes-card-"]', { hasText: '牛奶' }).locator('button').first().click();
    await expect(page.getByTestId('note-drawer')).toHaveAttribute('data-side', 'left');
  });

  test('⑥ 窗口宽窄跨过 900px（电脑版和手机排法互换、输入行重挂）：打的字不丢、不留模糊层', async ({ page }) => {
    await page.goto('/app/#/notes');
    await expect(page.getByTestId('desk')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(FADE_GUARD_MS);
    await page.getByTestId('notes-input').click();
    await page.keyboard.type('换排法');
    await page.setViewportSize({ width: 800, height: 820 });
    await expect(page.getByTestId('desk')).toHaveCount(0);
    await expect(page.getByTestId('notes-input')).toHaveValue('换排法');
    await expect(page.getByTestId('notes-mist')).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 820 });
    await expect(page.getByTestId('desk')).toBeVisible();
    await expect(page.getByTestId('notes-input')).toHaveValue('换排法');
  });
});
