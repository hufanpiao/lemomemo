// 待办编辑页：没设截止时改了提醒，截止日期自动填今天（R-375，11-10 负责人选“动了提醒就自动设截止为今天”）。
// 11-21 起日期、时刻、下拉是 kit 选择器（pick-helpers.ts）。时钟固定在首尔 2026-11-05 20:00：改提醒时刻 → 截止填 11-05、灰字消失；改成“前一天” → 灰字“这个提醒时刻已经过了”；再改截止日期 → 灰字没了
import { pick, pickOption } from './pick-helpers.ts';
import { expect, test } from './session-fixture.ts';

test.describe('没设截止时改了提醒（R-375）', () => {
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Seoul' });

  test('新建待办：改提醒时刻自动填今天；“前一天”出已过灰字；再改截止日期就没了', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-11-05T20:00:00+09:00') });
    await page.goto('/app/#/todo/new');
    const due = page.getByTestId('todo-edit-due');
    await expect(due).toHaveAttribute('data-value', '');
    await expect(page.getByText('设了提醒，截止日期会自动填今天')).toBeVisible();
    const title = page.getByTestId('todo-edit-title');
    await title.fill('交材料');
    await title.blur();
    await pick(page, 'todo-edit-remind-time', { time: '21:00' });
    await expect(due).toHaveAttribute('data-value', '2026-11-05');
    await expect(page.getByText('设了提醒，截止日期会自动填今天')).toHaveCount(0);
    await expect(page.getByText('这个提醒时刻已经过了，不会再提醒')).toHaveCount(0);
    await pickOption(page, 'todo-edit-days', '1');
    await expect(page.getByText('这个提醒时刻已经过了，不会再提醒')).toBeVisible();
    await pick(page, 'todo-edit-due', { date: '2026-11-08' });
    await expect(due).toHaveAttribute('data-value', '2026-11-08');
    await expect(page.getByText('这个提醒时刻已经过了，不会再提醒')).toHaveCount(0);
  });
});
