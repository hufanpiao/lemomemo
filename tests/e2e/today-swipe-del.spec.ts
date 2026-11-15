// 今天页待办行左滑删除（负责人 11-15“代办后面的x去掉”，同待办页；R-428）：不要后端，往本机库 planner-v4 写好今天到期的待办再重新载入
// • 行尾没有 ×（today-del-* 不存在）；轻拉露出“删除”，点了删：行没了、出撤销条、outbox 里有这一行的 patch；撤销回来
// • 一口气拉过大半行：松手直接删，别的行不动
import type { Page } from '@playwright/test';
import { cached, idbPut, idbRead } from './idb.ts';
import { swipeRow } from './page-helpers.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
test.use({ loggedIn: true, timezoneId: TZ, viewport: { width: 393, height: 852 }, locale: 'zh-CN' });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null, project: '', due_time: null, done: false, important: false, priority: 'mid', rev: 1 };

const outboxOf = async (page: Page) =>
  ((await idbRead<{ table: string; id: string; op: string }[]>(page, 'outbox', 'getAll')) ?? []).map((i) => `${i.table}:${i.id}:${i.op}`);

async function seed(page: Page): Promise<void> {
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30000 });
  await idbPut(page, [{ ...base, id: 'd1', title: '买牛奶', due: today() }, { ...base, id: 'd2', title: '写周报', due: today() }].map((r) => ['todos', cached(r)] as const));
  await page.goto('/app/#/today');
  await page.reload();
  await page.getByTestId('today-todo-d1').waitFor({ timeout: 30000 });
  await expect(page.locator('[data-testid="today"] [data-state="entering"]')).toHaveCount(0);
}

test.describe('今天页待办左滑删除', () => {
  test('行尾没有 ×；轻拉露出“删除”，点了删、出撤销条、进 outbox；撤销回来', async ({ page }) => {
    await seed(page);
    await expect(page.locator('[data-testid^="today-del-"]')).toHaveCount(0);
    await swipeRow(page, 'today-swipe-d1', 0.3);
    await expect(page.getByTestId('today-swipe-d1')).toHaveAttribute('data-swipe', 'open');
    const del = page.getByTestId('today-swipe-del-d1');
    await expect(del).toHaveText('删除');
    await del.click();
    await expect(page.getByTestId('today-todo-d1')).toHaveCount(0);
    await expect(page.getByTestId('today-toast')).toBeVisible();
    await expect.poll(() => outboxOf(page)).toContain('todos:d1:patch');
    await page.getByTestId('today-toast').getByRole('button').first().click();
    await expect(page.getByTestId('today-todo-d1')).toBeVisible();
  });

  test('一口气拉过大半行：松手直接删，别的行不动', async ({ page }) => {
    await seed(page);
    await swipeRow(page, 'today-swipe-d1');
    await expect(page.getByTestId('today-todo-d1')).toHaveCount(0);
    await expect(page.getByTestId('today-toast')).toBeVisible();
    await expect(page.getByTestId('today-todo-d2')).toBeVisible();
  });
});
