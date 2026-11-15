// 待办左滑删除（负责人 11-15“代办后面的x去掉，改成滑动删除”，已选“露按钮 + 拉到底直删”）：不要后端，往本机库 planner-v4 写好待办再重新载入
// • 行尾没有 ×；轻拉露出红色“删除”，点了删：行没了、出 8 秒撤销条、outbox 里有这一行的 patch，撤销回来
// • 一口气拉过大半行：松手直接删，不用再点
// • 电脑上鼠标也能拖开
// • 拉到底直删的阈值反馈（审查 11-15 第 3 条）：按住没松手时，没过 60% 行底是中性灰、外框没有 data-full；拉过了打上 data-full、整行换红底；
//   拉回来又摘掉、底色回灰；在线下松手只是停在露按钮的位置，不删
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

  test('拉到底直删的阈值：过 60% 打 data-full、整行红底；拉回来摘掉、回灰；没过线松手不删', async ({ page }) => {
    await seed(page);
    const wrap = page.getByTestId('todos-swipe-s1');
    const b = await page.getByTestId('todos-row-s1').boundingBox();
    if (!b) throw new Error('找不到行');
    const y = b.y + Math.min(b.height / 2, 22);
    const x0 = b.x + b.width - 30;
    const bg = () => wrap.evaluate((el) => getComputedStyle(el).backgroundColor);
    // 页面令牌算出来的颜色：同一个 var 放在临时元素上读，避免写死色值（浅色、深色都对）
    const tok = (name: string) =>
      page.evaluate((v) => {
        const p = document.createElement('div');
        p.style.backgroundColor = `var(${v})`;
        document.body.append(p);
        const c = getComputedStyle(p).backgroundColor;
        p.remove();
        return c;
      }, name);
    const [danger, panel2] = [await tok('--danger-bg'), await tok('--panel-2')];
    expect(danger).not.toBe(panel2);
    await page.mouse.move(x0, y);
    await page.mouse.down();
    await page.mouse.move(x0 - b.width * 0.4, y, { steps: 6 });
    await expect(wrap).not.toHaveAttribute('data-full', /.*/);
    await expect.poll(bg).toBe(panel2);
    await page.mouse.move(x0 - b.width * 0.75, y, { steps: 4 });
    await expect(wrap).toHaveAttribute('data-full', '');
    await expect.poll(bg).toBe(danger);
    await page.mouse.move(x0 - b.width * 0.35, y, { steps: 4 });
    await expect(wrap).not.toHaveAttribute('data-full', /.*/);
    await expect.poll(bg).toBe(panel2);
    await page.mouse.up();
    await expect(wrap).toHaveAttribute('data-swipe', 'open');
    await expect(page.getByTestId('todos-row-s1')).toBeVisible();
    await expect(page.getByTestId('todos-toast')).toHaveCount(0);
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
