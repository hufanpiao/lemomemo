// kit 选择器跳月（负责人 11-23 弹窗“点周标题弹月份”：原来只能一周一周翻，选几个月以后要连点“›”）。
// 待办编辑页截止日：时钟固定首尔 2026-11-23 → 点周标题弹出月份列表（往后 24 个月、跨年）→ 点 3 个月后的 2027-02 → 周条跳到含 2 月 1 号的那一周
// → 选 2 月 3 日、“确定” → 值按钮写回 2027-02-03。chromium、webkit 都跑
import { openPick, jumpMonth } from './pick-helpers.ts';
import { monthCellOf } from '../../src/kit/components/__tests__/pick-const.ts';
import { expect, test } from './session-fixture.ts';

test.describe('选择器点周标题跳月（负责人 11-23）', () => {
  test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, timezoneId: 'Asia/Seoul' });

  test('点标题弹出月份、点 3 个月后跳到那个月、选一天写回去', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-11-23T10:00:00+09:00') });
    await page.goto('/app/#/todo/new');
    const due = page.getByTestId('todo-edit-due');
    await expect(due).toHaveAttribute('data-value', '');
    const box = await openPick(page, 'todo-edit-due');
    const title = box.getByTestId('pick-title');
    await expect(title).toHaveAttribute('aria-expanded', 'false');
    await title.click();
    await expect(title).toHaveAttribute('aria-expanded', 'true');
    const list = page.locator(`[id="${await title.getAttribute('aria-controls')}"]`);
    await expect(list).toHaveAttribute('role', 'radiogroup');
    // 正在看的月选中；往后 24 个月到 2028-11
    await expect(list.locator(monthCellOf('2026-11'))).toHaveAttribute('aria-checked', 'true');
    await expect(list.locator(monthCellOf('2028-11'))).toHaveCount(1);
    await title.click();
    await expect(list).toHaveCount(0);
    await jumpMonth(box, '2027-02');
    await expect(box.locator('[data-v="2027-02-01"]')).toBeVisible();
    await expect(box.locator('[data-v="2026-11-23"]')).not.toBeInViewport();
    await box.locator('[data-v="2027-02-03"]').click();
    await box.getByTestId('pick-ok').click();
    await expect(box).toHaveCount(0);
    await expect(due).toHaveAttribute('data-value', '2027-02-03');
  });
});
