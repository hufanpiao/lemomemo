// 待办打勾后离开原位（负责人 11-17 定的勾选特效分镜，替换原来审查 11-15 第 4 条“撤销条开着期间都留在原组”）：不要后端，往本机库 planner-v4 写好三条没做完的待办再重新载入
// • 勾一条：先在原处停一下（勾上加划线），约 700ms 后这一行收起、页底升起撤销条，收完归进默认收起的“已完成 1”；撤销条照旧开着（kit 默认 8 秒）
// • 连着勾两条：各自停留、各自收起，最后都归进“已完成 2”；这时点撤销，撤的是最后勾的那条（回到原组、没勾），先勾的那条留在“已完成 1”
import type { Page } from '@playwright/test';
import { cached, idbPut } from './idb.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
test.use({ loggedIn: true, timezoneId: TZ, viewport: { width: 393, height: 852 }, locale: 'zh-CN' });
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null, project: '', due: null, due_time: null, done: false, important: false, priority: 'mid', rev: 1 };

async function seed(page: Page): Promise<void> {
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30000 });
  await idbPut(page, [{ ...base, id: 'l1', title: '买牛奶' }, { ...base, id: 'l2', title: '写周报' }, { ...base, id: 'l3', title: '订机票' }].map((r) => ['todos', cached(r)] as const));
  await page.reload();
  await page.getByTestId('todos-row-l1').waitFor({ timeout: 30000 });
}

const inDone = (page: Page, id: string) => page.getByTestId('todos-g-done').getByTestId(`todos-row-${id}`);

test.describe('待办打勾后离开原位（分镜）', () => {
  test('勾一条：停留时还在原组、勾上；随后收起、出撤销条、归进“已完成 1”', async ({ page }) => {
    await seed(page);
    await page.getByTestId('todos-done-l1').click();
    await expect(page.getByTestId('todos-done-l1')).toBeChecked();
    await expect(page.getByTestId('todos-row-l1')).toBeVisible();
    await expect(page.getByTestId('todos-done-toast')).toBeVisible();
    await expect(page.getByTestId('todos-done-fold')).toContainText('已完成 1');
    await expect(page.getByTestId('todos-row-l1')).toHaveCount(0);
    // 撤销条比这一行收起得晚（8 秒倒计时），行走了它还在
    await expect(page.getByTestId('todos-done-toast')).toBeVisible();
    await expect(page.locator('[data-undo-toast]')).toHaveCount(1);
  });

  test('连着勾两条都归进“已完成 2”；再点撤销：最后勾的那条回到原组、没勾，先勾的那条留在“已完成 1”', async ({ page }) => {
    await seed(page);
    await page.getByTestId('todos-done-l1').click();
    await page.getByTestId('todos-done-l2').click();
    await expect(page.getByTestId('todos-done-fold')).toContainText('已完成 2');
    await expect(page.getByTestId('todos-row-l1')).toHaveCount(0);
    await expect(page.getByTestId('todos-row-l2')).toHaveCount(0);
    await expect(page.getByTestId('todos-row-l3')).toBeVisible();
    await expect(inDone(page, 'l1')).toHaveCount(0);
    await page.getByTestId('todos-done-toast').getByRole('button').first().click();
    await expect(page.getByTestId('todos-done-l2')).not.toBeChecked();
    await expect(page.getByTestId('todos-done-fold')).toContainText('已完成 1');
    await expect(page.getByTestId('todos-row-l2')).toBeVisible();
    await expect(page.getByTestId('todos-row-l1')).toHaveCount(0);
  });
});
