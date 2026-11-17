// R-350 待办子任务（方案 5.1～5.6；TC-R350-01～05、12 的界面部分）：不要后端，直接往本机库 planner-v4 写好待办和子任务再重新载入
// • 列表页：副行“1/3”、摊开的勾选清单、分段进度条；勾一项写进 outbox（本机库 view 跟着变）；收起以后重新载入还是收起（每台设备各记各的）
// • 今天页（R-442）：待办行下面进度条和“1/3 · 展开”（按需下载那一包，下完才出现），默认收起；点了就地展开、勾一项写进 outbox，
//   勾完最后一项主待办自动完成、出“全部完成 · 撤销”，撤销以后主待办回到“今天的安排”；运行日志 subs today open n=3
// • 编辑页：“子任务”区列出各项，回车加一项写进 outbox
// • 启动清孤儿（5.6 第 1 条）：主待办在本机已经没有的子任务，重新载入后本机库里删掉
// • 环境变量 R350_SHOTS 指一个本机文件夹时（只在 Chromium），顺手截列表页、今天页、编辑页三张图给人看，不进仓库
import type { Page } from '@playwright/test';
import { cached, idbPut, idbRead } from './idb.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
test.use({ loggedIn: true, timezoneId: TZ, viewport: { width: 390, height: 844 } });
const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, rev: 1 };
const SHOTS = process.env['R350_SHOTS'];
/** 主待办“买菜”（编辑页路由只认 UUID 形状的 id） */
const T1 = '11111111-1111-4111-8111-111111111111';

/** 本机库里一张表的全部行 */
const readAll = async <T,>(page: Page, store: string): Promise<T[]> => (await idbRead<T[]>(page, store, 'getAll')) ?? [];

/** 待办 T1“买菜”（3 项，勾了 1 项）、t2“回邮件”（没有子任务）、孤儿子任务 x1（本机新建、没同步过，主待办 t-gone 本机没有） */
async function seed(page: Page): Promise<void> {
  await page.goto('/app/#/today');
  await page.getByTestId('today').waitFor({ timeout: 30000 });
  const d = today();
  const td = (id: string, title: string) => ({ ...base, id, title, due: d, due_time: null, done: false, important: false, priority: 'mid', project: '', short: null, undone: false });
  const it = (id: string, todo_id: string, title: string, sort: number, done: boolean) => ({ ...base, id, todo_id, title, sort, done });
  await idbPut(page, [
    ...[td(T1, '买菜'), td('t2', '回邮件')].map((r) => ['todos', cached(r)] as const),
    ...[it('a', T1, '牛奶', 1, true), it('b', T1, '鸡蛋', 2, false), it('c', T1, '猫砂', 3, false)].map((r) => ['todo_items', cached(r)] as const),
    ['todo_items', { id: 'x1', server: null, view: it('x1', 't-gone', '孤儿', 1, false) }],
  ]);
  await page.reload();
  await page.getByTestId(`today-todo-${T1}`).waitFor({ timeout: 30000 });
}

const itemIds = async (page: Page) => (await readAll<{ id: string }>(page, 'todo_items')).map((r) => r.id);
const outboxOf = async (page: Page) =>
  (await readAll<{ table: string; id: string; op: string }>(page, 'outbox')).map((i) => ({ table: i.table, id: i.id, op: i.op }));

test.describe('R-350 待办子任务', () => {
  test('今天页就地展开子任务、勾选、勾完自动完成和撤销；启动清掉孤儿子任务', async ({ page, browserName }) => {
    await seed(page);
    const fold = page.getByTestId(`today-fold-${T1}`);
    await expect(fold).toBeVisible({ timeout: 15000 });
    await expect(fold).toHaveText('1/3 · 展开');
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('today-sub-b')).toBeHidden();
    await expect(page.getByTestId('today-subs-t2')).toHaveCount(0);
    expect((await itemIds(page)).sort()).toEqual(['a', 'b', 'c']);
    // 点按区不小于 44
    expect((await fold.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('today-sub-b')).toBeVisible();
    if (SHOTS && browserName === 'chromium') await page.screenshot({ path: `${SHOTS}/today.png` });
    await page.getByTestId('today-sub-b').click();
    await expect(page.getByTestId(`today-bar-${T1}`)).toHaveAttribute('aria-valuenow', '2');
    await expect.poll(() => outboxOf(page)).toContainEqual({ table: 'todo_items', id: 'b', op: 'patch' });
    // 勾完最后一项：主待办自动完成，出“全部完成 · 撤销”；撤销以后两件一起回来
    await page.getByTestId('today-sub-c').click();
    const toast = page.getByTestId('today-auto-toast');
    await expect(toast).toContainText('全部完成');
    await expect.poll(() => outboxOf(page)).toContainEqual({ table: 'todos', id: T1, op: 'patch' });
    await toast.getByRole('button').click();
    await expect(page.getByTestId(`today-done-${T1}`)).not.toBeChecked();
    expect((await page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '')).includes('subs today open n=3')).toBe(true);
  });

  test('列表页：卡片、勾一项写进 outbox、收起后重新载入还是收起', async ({ page, browserName }) => {
    await seed(page);
    await page.goto('/app/#/todos');
    await page.reload();
    await page.getByTestId(`todos-subs-${T1}`).waitFor({ timeout: 30000 });
    // R-436 第 7 条：“已勾/总数”从副行最前面挪到进度条后面（“1/3 · 收起”）
    await expect(page.getByTestId(`todos-fold-${T1}`)).toHaveText('1/3 · 收起');
    if (SHOTS && browserName === 'chromium') await page.screenshot({ path: `${SHOTS}/todos.png` });
    await page.getByTestId('todos-sub-b').click();
    await expect(page.getByTestId(`todos-bar-${T1}`)).toHaveAttribute('aria-valuenow', '2');
    await expect.poll(() => outboxOf(page)).toContainEqual({ table: 'todo_items', id: 'b', op: 'patch' });
    const fold = page.getByTestId(`todos-fold-${T1}`);
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await page.reload();
    await expect(page.getByTestId(`todos-fold-${T1}`)).toHaveAttribute('aria-expanded', 'false', { timeout: 30000 });
  });

  test('编辑页：“子任务”区列出各项，回车加一项', async ({ page, browserName }) => {
    await seed(page);
    await page.goto(`/app/#/todo/${T1}`);
    await page.reload();
    const box = page.getByTestId('todo-subs');
    await box.waitFor({ timeout: 30000 });
    await expect(box.getByTestId('todo-sub-title-a')).toHaveValue('牛奶');
    if (SHOTS && browserName === 'chromium') await page.screenshot({ path: `${SHOTS}/edit.png`, fullPage: true });
    const add = page.getByTestId('todo-sub-add');
    await add.fill('葱');
    await add.press('Enter');
    await expect(add).toHaveValue('');
    await expect.poll(async () => (await outboxOf(page)).filter((i) => i.table === 'todo_items' && i.op === 'insert').length).toBe(1);
  });
});
