// 完成满 7 天的待办自动删除（负责人 11-15 方案；src/features/todos/data/todo-autodel.ts）：不要后端，往本机库 planner-v4 写好待办再重新载入
// • 启动首屏画完扫一遍：完成满 8 天、之后没动过的 → 写进 outbox（patch）、进“最近删除”；完成 2 天的、完成后又改过的不动
// • 设置里关掉“完成 7 天后自动删除”再重新载入：不删
import type { Page } from '@playwright/test';
import { cached, idbPut, idbRead } from './idb.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
test.use({ loggedIn: true, timezoneId: TZ, viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
const DAY = 86400000;
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, deleted_at: null, undone: false, short: null, due: null, due_time: null, important: false, project: '' };
const done = (id: string, title: string, ago: number, editedAgo?: number) => {
  const at = Date.now() - ago * DAY;
  return { ...base, id, title, done: true, done_at: at, updated_at: editedAgo === undefined ? at : Date.now() - editedAgo * DAY };
};

const outboxOf = async (page: Page) =>
  ((await idbRead<{ table: string; id: string; op: string }[]>(page, 'outbox', 'getAll')) ?? []).map((i) => `${i.table}:${i.id}:${i.op}`);

async function seed(page: Page): Promise<void> {
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30000 });
  await idbPut(page, [done('old', '八天前完成', 8), done('new', '两天前完成', 2), done('edited', '完成后改过', 8, 1)].map((r) => ['todos', cached(r)] as const));
}

test.describe('完成 7 天后自动删除', () => {
  test('启动后完成满 7 天、没再动过的那条写进 outbox、进最近删除；别的不动', async ({ page }) => {
    await seed(page);
    await page.reload();
    await expect.poll(() => outboxOf(page), { timeout: 15000 }).toContain('todos:old:patch');
    expect((await outboxOf(page)).filter((x) => x.startsWith('todos:'))).toEqual(['todos:old:patch']);
    await page.goto('/app/#/todos');
    await expect(page.getByTestId('todos-done-fold')).toContainText('已完成 2');
    await page.goto('/app/#/trash');
    await expect(page.getByTestId('trash-row-old')).toContainText('八天前完成');
    await expect(page.getByTestId('trash-row-new')).toHaveCount(0);
  });

  test('设置里关掉开关：重新载入后不删', async ({ page }) => {
    await seed(page);
    await page.goto('/app/#/settings');
    const sw = page.getByTestId('settings-todo-autodel');
    await expect(sw).toBeChecked();
    await sw.click();
    await expect(sw).not.toBeChecked();
    await page.reload();
    await page.getByTestId('settings-todo-autodel').waitFor({ timeout: 30000 });
    await expect(page.getByTestId('settings-todo-autodel')).not.toBeChecked();
    await page.waitForTimeout(1500);
    expect((await outboxOf(page)).filter((x) => x.startsWith('todos:'))).toEqual([]);
  });
});
