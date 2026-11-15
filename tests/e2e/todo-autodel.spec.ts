// 完成满 7 天的待办自动删除（负责人 11-15 方案；src/features/todos/data/todo-autodel.ts）：默认组这一半
// 审查 11-15 第 1 条起改成“同步第一次拉取成功以后才扫”：不能拿本机的旧数据删（别处可能已经取消完成、改过）。
// 默认组的构建没配 supabase 地址、没有后端，拉取永远不会成功，所以这里验的是“拉不成功就不扫、不删”：
// • 本机库里有完成满 8 天、没再动过的待办，重新载入、等一会儿：不进 outbox、不进“最近删除”，运行日志里没有 todo autodel
// 拉取成功以后删、开关关着不删、离线启动不删再联网删：快读组 todo-autodel-pull.spec.ts
import type { Page } from '@playwright/test';
import { cached, idbPut, idbRead } from './idb.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
test.use({ loggedIn: true, timezoneId: TZ, viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
const DAY = 86400000;
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, deleted_at: null, undone: false, short: null, due: null, due_time: null, important: false, project: '' };
const at = Date.now() - 8 * DAY;
const OLD = { ...base, id: 'old', title: '八天前完成', done: true, done_at: at, updated_at: at };

const outboxOf = async (page: Page) =>
  ((await idbRead<{ table: string; id: string; op: string }[]>(page, 'outbox', 'getAll')) ?? []).map((i) => `${i.table}:${i.id}:${i.op}`);

test('同步没拉成功（没有后端）：完成满 7 天的也不删，日志里没有 todo autodel', async ({ page }) => {
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30000 });
  await idbPut(page, [['todos', cached(OLD)]]);
  await page.reload();
  await expect(page.getByTestId('todos-done-fold')).toContainText('已完成 1', { timeout: 30000 });
  await page.waitForTimeout(3000);
  expect((await outboxOf(page)).filter((x) => x.startsWith('todos:'))).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '')).not.toContain('todo autodel');
  await page.goto('/app/#/trash');
  await page.getByTestId('trash').waitFor({ timeout: 30000 });
  await expect(page.getByTestId('trash-row-old')).toHaveCount(0);
});
