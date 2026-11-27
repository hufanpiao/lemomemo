// kit 选择器日期滑条（负责人 11-23 截图：“这个日期没办法左右滑动，做成跟时间一样的那种滑动”）。
// 待办编辑页截止日：时钟固定首尔 2026-11-23（周一，周日起）→ 打开先看到 11-22～11-28 → 横向滚日期条能动、标题跟着变
// → › 挪 7 天、平滑滚到最左那天对齐 → 手滑后点一天、“确定”写回去。chromium、webkit 都跑
import { openPick } from './pick-helpers.ts';
import { expect, test } from './session-fixture.ts';

test.describe('选择器日期左右滑（负责人 11-23）', () => {
  test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, timezoneId: 'Asia/Seoul' });

  test('日期条和时、分条一样能左右滑，标题、‹ › 跟着走', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-11-23T10:00:00+09:00') });
    await page.goto('/app/#/todo/new');
    const box = await openPick(page, 'todo-edit-due');
    const strip = box.locator('[data-first]');
    const title = box.getByTestId('pick-title');
    await expect(strip).toHaveAttribute('data-first', '2026-11-22');
    await expect(box.locator('[data-v="2026-11-22"]')).toBeInViewport();
    await expect(box.locator('[data-v="2026-11-28"]')).toBeInViewport();
    await expect(box.locator('[data-v="2026-11-29"]')).not.toBeInViewport({ ratio: 0.5 });
    // 能横着滚：内容比条宽
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth * 10)).toBe(true);
    // › 挪 7 天：最左变成 11-29，标题“11月–12月”
    await box.getByTestId('pick-next').click();
    await expect(strip).toHaveAttribute('data-first', '2026-11-29');
    await expect(title).toHaveText('11月–12月');
    // 平滑滚到位：11-29 在最左
    const left = (d: string) => box.locator(`[data-v="${d}"]`).evaluate((c) => Math.round(c.getBoundingClientRect().left - (c.parentElement as HTMLElement).getBoundingClientRect().left));
    await expect.poll(() => left('2026-11-29')).toBe(0);
    // 手滑往后两屏（mobile WebKit 不支持滚轮，两边都直接改滚动位置，等于手指拖过去）：最左那天、标题跟着变到 12 月
    await strip.evaluate((el) => el.scrollBy({ left: el.clientWidth * 2 }));
    await expect.poll(() => strip.getAttribute('data-first')).toMatch(/^2026-12-/);
    await expect(title).toContainText('12月');
    const first = (await strip.getAttribute('data-first')) ?? '';
    await expect(box.locator(`[data-v="${first}"]`)).toBeInViewport({ ratio: 0.5 });
    await box.locator(`[data-v="${first}"]`).click();
    await box.getByTestId('pick-ok').click();
    await expect(box).toHaveCount(0);
    await expect(page.getByTestId('todo-edit-due')).toHaveAttribute('data-value', first);
  });
});
