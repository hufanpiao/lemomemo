// FA-2 只读行界面（架构 0.27 第 1 点、开发计划三之二：B2 验收日程、待办、今天页、日历，含重复事项横幅）和 B2 全站视觉审查 A2
// • 不要后端：直接往本机库 planner-v4 写“宽容读取以后”的样子——带 repeat 的行 ro: true（4.1.0 的重复事项，4.0.x 只读），
//   重新载入后 boot 把 ro 带进 core/store 的只读 id；页面据它画行尾标记、拦下写入
// • 拦下以后本机库和 outbox 都不变（真的没写）；可写的行照常进编辑页
// • A2：日历“纪念日”置灰、不跳 #/anniv 占位页，点了出“纪念日即将推出”
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
// 浏览器时区和造数据用的时区要一致：不然本机时区和首尔跨零点的那几个小时里“今天”对不上，今天页找不到这几条
test.use({ loggedIn: true, timezoneId: TZ });
const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null, project: '', rev: 1 };

/** 本机库：日程 e-ro（重复、只读）、e-ok；待办 t-ro（重复、只读）、t-ok */
async function seed(page: Page): Promise<void> {
  await page.goto('/app/#/today');
  await page.getByTestId('today').waitFor({ timeout: 30000 });
  const d = today();
  await page.evaluate(
    async ({ d, base }) => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('planner-v4');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const tx = db.transaction(['events', 'todos'], 'readwrite');
      const ev = (id: string, title: string, over: Record<string, unknown>) => ({
        ...base, id, title, date: d, time: '23:00', duration_min: 30, remind_min: null, remind_days: null, location: null, ...over,
      });
      const td = (id: string, title: string, over: Record<string, unknown>) => ({
        ...base, id, title, due: d, due_time: null, done: false, important: false, ...over,
      });
      const eRo = ev('e-ro', '每周例会', { repeat: { freq: 'week' } });
      const eOk = ev('e-ok', '看牙', { time: '23:30' });
      const tRo = td('t-ro', '每天吃药', { repeat: { freq: 'day' } });
      const tOk = td('t-ok', '买牛奶', {});
      tx.objectStore('events').put({ id: 'e-ro', server: eRo, view: eRo, ro: true });
      tx.objectStore('events').put({ id: 'e-ok', server: eOk, view: eOk });
      tx.objectStore('todos').put({ id: 't-ro', server: tRo, view: tRo, ro: true });
      tx.objectStore('todos').put({ id: 't-ok', server: tOk, view: tOk });
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    },
    { d, base },
  );
  await page.reload();
  await page.getByTestId('today-todo-t-ok').waitFor({ timeout: 30000 });
}

/** 换页：整页重新载入后再等 ready（不走切页的 View Transition，免得切页动画期间的点按被吞，那是 UI4-B1-C2，不归这里） */
async function open(page: Page, hash: string, ready: string): Promise<void> {
  await page.goto(`/app/${hash}`);
  await page.reload();
  await page.getByTestId(ready).waitFor({ timeout: 30000 });
}

/** 本机库里 t-ro 的 view.done 和 outbox 的项数 */
async function stateOf(page: Page): Promise<{ done: unknown; outbox: number }> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('planner-v4');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const get = <T,>(store: string, f: (s: IDBObjectStore) => IDBRequest) =>
      new Promise<T>((res, rej) => {
        const q = f(db.transaction(store).objectStore(store));
        q.onsuccess = () => res(q.result as T);
        q.onerror = () => rej(q.error);
      });
    const row = await get<{ view: { done: unknown } } | undefined>('todos', (s) => s.get('t-ro'));
    const n = await get<number>('outbox', (s) => s.count());
    db.close();
    return { done: row?.view.done, outbox: n };
  });
}

test.describe('只读行（FA-2）', () => {
  test('今天页：顶部重复事项横幅；只读行行尾标记；点、打勾、删除都拦下（× 是 aria-disabled），本机库和队列不变；可写的照常', async ({ page }) => {
    await seed(page);
    await expect(page.getByTestId('today-repeat')).toContainText('有 2 条重复事项要新版本才能完整显示');
    await expect(page.getByTestId('today-repeat-update')).toHaveText('更新');
    await expect(page.getByTestId('today-ro-t-ro')).toBeVisible();
    await expect(page.getByTestId('today-ro-e-ro')).toBeVisible();
    await expect(page.getByTestId('today-ro-t-ok')).toHaveCount(0);

    await page.getByTestId('today-todo-t-ro').getByRole('button', { name: /每天吃药/ }).click();
    await expect(page).toHaveURL(/#\/today$/);
    await expect(page.getByTestId('today-ro-toast')).toContainText('这条要新版本才能修改');
    await page.getByTestId('today-done-t-ro').click({ force: true });
    // 只读行的 × 和打勾圆圈一样（FA-2 视觉验收第二轮第 1 条）：aria-disabled、读屏名字接“要更新到新版本才能修改”，点了出提示、不写、行还在
    await expect(page.getByTestId('today-del-t-ro')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('today-del-t-ro')).toHaveAttribute('aria-label', '删除，要更新到新版本才能修改');
    await page.getByTestId('today-del-t-ro').click({ force: true });
    await expect(page.getByTestId('today-ro-toast')).toContainText('这条要新版本才能修改');
    await expect(page.getByTestId('today-todo-t-ro')).toBeVisible();
    await expect(page.getByTestId('today-del-t-ok')).not.toHaveAttribute('aria-disabled', 'true');
    expect(await stateOf(page)).toEqual({ done: false, outbox: 0 });

    await page.getByTestId('today-todo-t-ok').getByRole('button', { name: /买牛奶/ }).click();
    await expect(page).toHaveURL(/#\/todo\/t-ok$/);
  });

  test('待办页：只读行打勾、删除不写（× 是 aria-disabled），点了不进编辑页', async ({ page }) => {
    await seed(page);
    await open(page, '#/todos', 'todos-row-t-ro');
    await expect(page.getByTestId('todos-ro-t-ro')).toBeVisible();
    await expect(page.getByTestId('todos-done-t-ro')).toHaveAttribute('aria-disabled', 'true');
    await page.getByTestId('todos-done-t-ro').click({ force: true });
    await expect(page.getByTestId('todos-ro-toast')).toContainText('这条要新版本才能修改');
    await page.getByTestId('todos-row-t-ro').getByRole('button', { name: /每天吃药/ }).click();
    await expect(page).toHaveURL(/#\/todos$/);
    await expect(page.getByTestId('todos-del-t-ro')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('todos-del-t-ro')).toHaveAttribute('aria-label', '删除，要更新到新版本才能修改');
    await page.getByTestId('todos-del-t-ro').click({ force: true });
    await expect(page.getByTestId('todos-ro-toast')).toContainText('这条要新版本才能修改');
    await expect(page.getByTestId('todos-row-t-ro')).toBeVisible();
    await expect(page.getByTestId('todos-del-t-ok')).not.toHaveAttribute('aria-disabled', 'true');
    expect(await stateOf(page)).toEqual({ done: false, outbox: 0 });
  });

  test('日历：顶部横幅；日清单只读行有标记、点了拦下；“纪念日”置灰，点了只出“纪念日即将推出”（A2）', async ({ page }) => {
    await seed(page);
    await open(page, '#/calendar', 'cal-day-list');
    await expect(page.getByTestId('cal-repeat')).toContainText('有 2 条重复事项要新版本才能完整显示');
    await expect(page.getByTestId('cal-ro-e-ro')).toBeVisible();
    await page.getByTestId('cal-day-row-e-ro').click();
    await expect(page.getByTestId('cal-ro-toast')).toContainText('这条要新版本才能修改');
    await expect(page).not.toHaveURL(/#\/event\//);

    const anniv = page.getByTestId('cal-mode-anniv');
    await expect(anniv).toHaveAttribute('aria-disabled', 'true');
    const before = page.url();
    await anniv.click({ force: true });   // aria-disabled：Playwright 当它不可点，真人点得到（点了出提示）
    await expect(page.getByTestId('cal-anniv-soon')).toHaveText('纪念日即将推出');
    expect(page.url()).toBe(before);

    await page.getByTestId('cal-day-row-e-ok').click();
    await expect(page).toHaveURL(/#\/event\/e-ok$/);
  });
});
