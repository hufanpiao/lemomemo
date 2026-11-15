// 待办“完成后离开原位”（审查 11-15 第 4 条）：不要后端，往本机库 planner-v4 写好三条没做完的待办再重新载入
// • 连着勾两条：撤销条开着期间勾过的都留在原组（不进“已完成”），最后一条撤销条收起时一起归进默认收起的“已完成 2”
// • 勾两条后点撤销：撤的是最后勾的那条（回到没勾），先勾的那条在撤销条收起后归进“已完成 1”
import type { Page } from '@playwright/test';
import { cached, idbPut } from './idb.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
test.use({ loggedIn: true, timezoneId: TZ, viewport: { width: 393, height: 852 }, locale: 'zh-CN' });
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null, project: '', due: null, due_time: null, done: false, important: false, rev: 1 };

async function seed(page: Page): Promise<void> {
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30000 });
  await idbPut(page, [{ ...base, id: 'l1', title: '买牛奶' }, { ...base, id: 'l2', title: '写周报' }, { ...base, id: 'l3', title: '订机票' }].map((r) => ['todos', cached(r)] as const));
  await page.reload();
  await page.getByTestId('todos-row-l1').waitFor({ timeout: 30000 });
}

const inDone = (page: Page, id: string) => page.getByTestId('todos-g-done').getByTestId(`todos-row-${id}`);

test.describe('待办打勾后离开原位', () => {
  test('连着勾两条：撤销条开着期间都留在原位，收起时一起归进“已完成 2”', async ({ page }) => {
    await seed(page);
    await page.getByTestId('todos-done-l1').click();
    await expect(page.getByTestId('todos-done-toast')).toBeVisible();
    await page.getByTestId('todos-done-l2').click();
    // 两条都还在原来那组、都勾上了，“已完成”组还没有它们
    for (const id of ['l1', 'l2']) {
      await expect(page.getByTestId(`todos-row-${id}`)).toBeVisible();
      await expect(page.getByTestId(`todos-done-${id}`)).toBeChecked();
      await expect(inDone(page, id)).toHaveCount(0);
    }
    await expect(page.getByTestId('todos-done-fold')).toHaveCount(0);
    await expect(page.locator('[data-undo-toast]')).toHaveCount(1);
    // 撤销条收起（3 秒）以后一起进默认收起的“已完成 2”
    await expect(page.getByTestId('todos-done-toast')).toHaveCount(0, { timeout: 8000 });
    await expect(page.getByTestId('todos-done-fold')).toContainText('已完成 2');
    await expect(page.getByTestId('todos-row-l1')).toHaveCount(0);
    await expect(page.getByTestId('todos-row-l2')).toHaveCount(0);
    await expect(page.getByTestId('todos-row-l3')).toBeVisible();
  });

  test('勾两条后点撤销：最后勾的那条回到没勾、留在原位；先勾的那条归进“已完成 1”', async ({ page }) => {
    await seed(page);
    await page.getByTestId('todos-done-l1').click();
    await page.getByTestId('todos-done-l2').click();
    await expect(page.getByTestId('todos-done-l2')).toBeChecked();
    await page.getByTestId('todos-done-toast').getByRole('button').first().click();
    await expect(page.getByTestId('todos-done-l2')).not.toBeChecked();
    await expect(page.getByTestId('todos-done-fold')).toContainText('已完成 1', { timeout: 8000 });
    await expect(page.getByTestId('todos-row-l1')).toHaveCount(0);
    await expect(page.getByTestId('todos-row-l2')).toBeVisible();
  });
});
