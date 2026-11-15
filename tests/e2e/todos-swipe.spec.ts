// 待办左滑删除（负责人 11-15“代办后面的x去掉，改成滑动删除”，已选“露按钮 + 拉到底直删”）：不要后端，往本机库 planner-v4 写好待办再重新载入
// • 行尾没有 ×；轻拉露出红色“删除”，点了删：行没了、出 8 秒撤销条、outbox 里有这一行的 patch，撤销回来
// • 一口气拉过大半行：松手直接删，不用再点
// • 电脑上鼠标也能拖开
import type { Page } from '@playwright/test';
import { cached, idbPut, idbRead } from './idb.ts';
import { swipeRow } from './page-helpers.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
test.use({ loggedIn: true, timezoneId: TZ, viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null, project: '', due: null, due_time: null, done: false, important: false, rev: 1 };

const outboxOf = async (page: Page) =>
  ((await idbRead<{ table: string; id: string; op: string }[]>(page, 'outbox', 'getAll')) ?? []).map((i) => `${i.table}:${i.id}:${i.op}`);

async function seed(page: Page): Promise<void> {
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30000 });
  await idbPut(page, [{ ...base, id: 's1', title: '买牛奶' }, { ...base, id: 's2', title: '写周报' }].map((r) => ['todos', cached(r)] as const));
  await page.reload();
  await page.getByTestId('todos-row-s1').waitFor({ timeout: 30000 });
}

test.describe('待办左滑删除', () => {
  test('行尾没有 ×；轻拉露出“删除”，点了删、出撤销条、进 outbox；撤销回来', async ({ page }) => {
    await seed(page);
    await expect(page.getByTestId('todos-row-s1').getByText('×', { exact: true })).toHaveCount(0);
    await swipeRow(page, 'todos-row-s1', 0.3);
    await expect(page.getByTestId('todos-swipe-s1')).toHaveAttribute('data-swipe', 'open');
    const del = page.getByTestId('todos-swipe-del-s1');
    await expect(del).toBeVisible();
    await expect(del).toHaveText('删除');
    await del.click();
    await expect(page.getByTestId('todos-row-s1')).toHaveCount(0);
    await expect(page.getByTestId('todos-toast')).toBeVisible();
    await expect.poll(() => outboxOf(page)).toContain('todos:s1:patch');
    await page.getByTestId('todos-toast').getByRole('button').first().click();
    await expect(page.getByTestId('todos-row-s1')).toBeVisible();
  });

  test('一口气拉过大半行：松手直接删，不用再点；别的行不动', async ({ page }) => {
    await seed(page);
    await swipeRow(page, 'todos-row-s1');
    await expect(page.getByTestId('todos-row-s1')).toHaveCount(0);
    await expect(page.getByTestId('todos-toast')).toBeVisible();
    await expect(page.getByTestId('todos-row-s2')).toBeVisible();
  });

  test('电脑上鼠标也能拖开', async ({ page }) => {
    await seed(page);
    const b = await page.getByTestId('todos-row-s2').boundingBox();
    if (!b) throw new Error('找不到行');
    const y = b.y + Math.min(b.height / 2, 22);
    await page.mouse.move(b.x + b.width - 30, y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i += 1) await page.mouse.move(b.x + b.width - 30 - i * 12, y);
    await page.mouse.up();
    await expect(page.getByTestId('todos-swipe-s2')).toHaveAttribute('data-swipe', 'open');
    await expect(page.getByTestId('todos-swipe-del-s2')).toBeVisible();
  });
});
