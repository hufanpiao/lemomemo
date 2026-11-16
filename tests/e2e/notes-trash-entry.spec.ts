// “最近删除”入口在设置页（R-441 负责人 11-16“代办页跟随手记页的删除按钮去掉，删除确认放在设置页”，取代 R-438 的顶栏图标）：
// • 待办页、随手记页顶栏里没有垃圾桶图标（右上角只有设置头像）
// • 设置首页“最近删除”一组（卡名看得见）两行“待办”“随手记”，右边是“最近删除”里这一类的条数（没有就不写），读屏名称带条数；
//   点了进 #/trash/todos、#/trash/notes，只列这一类、删掉的那条在里面
// • 设了 LEMO_SHOT_DIR 时 Chromium 截三张（430×932、DPR 3）：待办页、随手记页顶栏，设置页“最近删除”那一组
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { cached, idbPut } from './idb.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, timezoneId: 'Asia/Seoul', locale: 'zh-CN' });

const SHOT_DIR = process.env['LEMO_SHOT_DIR'] ?? '';
const ago = (ms: number) => Date.now() - ms;

const note = (id: string, body: string, deletedAt: number | null) => ({
  id, user_id: FAKE_USER_ID, title: null, body, is_private: false, category_id: null, category_source: 'none', category_seen: true, ai_status: 'done',
  tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null, deleted_at: deletedAt, undone: false, created_at: ago(60000), updated_at: 1, rev: 1,
});
const todo = (id: string, title: string, deletedAt: number | null) => ({
  id, user_id: FAKE_USER_ID, title, tz: 'Asia/Seoul', created_at: 1, updated_at: 1, deleted_at: deletedAt, undone: false, short: null, project: '',
  due: null, due_time: null, done: false, important: false, priority: 'mid', rev: 1,
});

async function shot(page: Page, browserName: string, name: string): Promise<void> {
  if (!SHOT_DIR || browserName !== 'chromium') return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) });
}

test('待办页、随手记页顶栏没有“最近删除”；设置页“最近删除”两行带条数，点了进只列这一类的最近删除', async ({ page, browserName }) => {
  await page.goto('/app/#/notes');
  await page.getByTestId('notes').waitFor({ timeout: 30000 });
  await idbPut(page, [
    ...[note('n-live', '留着的一条', null), note('n-gone', '删掉的一条', ago(60000))].map((r) => ['notes', cached(r)] as const),
    ...[todo('t-live', '留着的待办', null), todo('t-gone1', '删掉的待办一', ago(60000)), todo('t-gone2', '删掉的待办二', ago(120000))].map((r) => ['todos', cached(r)] as const),
  ]);
  await page.reload();

  // 随手记页：右上角只有设置头像
  await page.getByText('留着的一条').first().waitFor({ timeout: 30000 });
  await expect(page.getByTestId('notes-settings')).toBeVisible();
  await expect(page.getByTestId('notes-open-trash')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /最近删除/ })).toHaveCount(0);
  await shot(page, browserName, 'r441-notes-top');

  // 待办页：同样
  await page.goto('/app/#/todos');
  await page.getByTestId('todos-row-t-live').waitFor({ timeout: 30000 });
  await expect(page.getByTestId('todos-settings')).toBeVisible();
  await expect(page.getByTestId('todos-open-trash')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /最近删除/ })).toHaveCount(0);
  await shot(page, browserName, 'r441-todos-top');

  // 设置首页：“最近删除”一组，卡名看得见；两行条数和最近删除页一致
  await page.goto('/app/#/settings');
  const card = page.getByTestId('settings-card-trash');
  await expect(card.getByRole('heading', { level: 2 })).toHaveText('最近删除');
  await expect(card.getByRole('heading', { level: 2 })).toBeVisible();
  const todosRow = page.getByTestId('settings-trash-todos-entry');
  const notesRow = page.getByTestId('settings-trash-notes-entry');
  await expect(page.getByTestId('settings-trash-todos-summary')).toHaveText('2 条');
  await expect(page.getByTestId('settings-trash-notes-summary')).toHaveText('1 条');
  await expect(todosRow).toHaveAccessibleName(/^待办\s*2 条$/);
  await expect(notesRow).toHaveAccessibleName(/^随手记\s*1 条$/);
  await card.scrollIntoViewIfNeeded();
  await shot(page, browserName, 'r441-settings-trash');

  // 点“待办”：只列待办，两条都在
  await todosRow.click();
  await expect(page).toHaveURL(/#\/trash\/todos$/);
  await expect(page.getByTestId('trash-row-t-gone1')).toContainText('删掉的待办一');
  await expect(page.getByTestId('trash-row-t-gone2')).toContainText('删掉的待办二');
  await expect(page.getByTestId('trash-row-n-gone')).toHaveCount(0);

  // 回设置点“随手记”：只列随手记
  await page.goto('/app/#/settings');
  await notesRow.click();
  await expect(page).toHaveURL(/#\/trash\/notes$/);
  await expect(page.getByTestId('trash-row-n-gone')).toContainText('删掉的一条');
  await expect(page.getByTestId('trash-row-t-gone1')).toHaveCount(0);
});

test('没有删掉的：两行不写条数，照样能点进去', async ({ page }) => {
  await page.goto('/app/#/settings');
  await expect(page.getByTestId('settings-trash-todos-entry')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('settings-trash-todos-summary')).toHaveText('');
  await expect(page.getByTestId('settings-trash-notes-summary')).toHaveText('');
  await expect(page.getByTestId('settings-trash-notes-entry')).toHaveAccessibleName(/^随手记$/);
  await page.getByTestId('settings-trash-notes-entry').click();
  await expect(page).toHaveURL(/#\/trash\/notes$/);
});
