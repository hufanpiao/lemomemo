// K8 冲突提示的端到端（方案 docs/09-路线图/B2-K8-冲突提示-实现方案.md 第六节）：gone 卡的两个按钮、叠在撤销条上面、别的对话框打开时隐藏
// • 不要后端：e2e 的 /sb 指向假后端，同步拉不到东西，也发不出去（探针看过：登录后 8 秒内没有一条 /sb 请求）。
//   所以直接往本机库 planner-v4 写“gone 之后”的样子——这一行在服务器上已删（server.deleted_at 有值），outbox 里有一项 failed + gone 的 patch，
//   重新载入后 gate 启动时读 outbox，出 gone 卡。按钮走的是真的 core/write-gone.ts → outbox-gone.ts
// • 冲突卡（conflict、forked）要同步引擎发事件，这里造不出来；它的界面逻辑在 src/features/sync-notice/__tests__/SyncNoticeHost.test.tsx
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

// 浏览器时区和造数据用的首尔一致：本机不在首尔时，跨零点那一小时“今天”对不上（11-06 23 点实测挂）
test.use({ loggedIn: true, timezoneId: 'Asia/Seoul' });

const TZ = 'Asia/Seoul';
const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, undone: false, short: null, project: '', due_time: null, done: false };

/** 写本机库：g1 在服务器上已删、outbox 有它的 gone 项（改了标题）；n1 是一条普通待办（删它出撤销条） */
async function seed(page: Page): Promise<void> {
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30000 });
  const due = today();
  await page.evaluate(
    async ({ due, base }) => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('planner-v4');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const tx = db.transaction(['todos', 'outbox'], 'readwrite');
      const g1 = { ...base, id: 'g1', title: '交周报', due, rev: 3, deleted_at: Date.now() - 60000 };
      const n1 = { ...base, id: 'n1', title: '买牛奶', due, rev: 1, deleted_at: null };
      tx.objectStore('todos').put({ id: 'g1', server: g1, view: g1 });
      tx.objectStore('todos').put({ id: 'n1', server: n1, view: n1 });
      tx.objectStore('outbox').put({
        op_id: '0e2e0000-0000-4000-8000-0000000000a1', table: 'todos', id: 'g1', rec: 'todos:g1', op: 'patch', data: { title: '交周报（改）' },
        base_rev: 2, own_revs: [], client_ts: Date.now() - 120000, tries: 0, next_at: 0, state: 'failed', v: 1, app: '4.0.0', seq: 1,
        remind: false, deps: [], error: 'gone', sent: true,
      });
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    },
    { due, base },
  );
  await page.reload();
  await page.getByTestId('todos-row-n1').waitFor({ timeout: 30000 });
}

/** outbox 里 todos:g1 还剩的项（state、error） */
async function outboxOf(page: Page): Promise<{ state: string; error: string | null }[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('planner-v4');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = await new Promise<{ rec: string; state: string; error: string | null }[]>((res, rej) => {
      const q = db.transaction('outbox').objectStore('outbox').getAll();
      q.onsuccess = () => res(q.result as never);
      q.onerror = () => rej(q.error);
    });
    db.close();
    return all.filter((i) => i.rec === 'todos:g1').map((i) => ({ state: i.state, error: i.error }));
  });
}

const card = (page: Page) => page.getByTestId('sync-notice-card');

/** 卡的位置稳下来以后的 y（进场动画走完：隔 100ms 量两次一样） */
async function settledY(page: Page): Promise<number> {
  let last = Number.NaN;
  await expect.poll(async () => {
    const y = (await card(page).boundingBox())?.y ?? Number.NaN;
    const same = y === last;
    last = y;
    return same;
  }, { intervals: [100] }).toBe(true);
  return last;
}

test.describe('K8 gone 卡', () => {
  test('恢复：这一行回到待办列表和今天页（标题是本机改过的），outbox 里不再有 gone 项', async ({ page }) => {
    await seed(page);
    await expect(card(page)).toBeVisible({ timeout: 15000 });
    await expect(card(page)).toContainText('“交周报（改）”已在另一台设备上删除');
    await expect(page.getByTestId('todos-row-g1')).toHaveCount(0);
    await page.getByTestId('sync-notice-restore').click();
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByTestId('todos-row-g1')).toContainText('交周报（改）');
    await expect.poll(() => outboxOf(page)).toEqual([{ state: 'pending', error: null }]);
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today-todo-g1')).toBeVisible({ timeout: 15000 });
  });

  test('不用了：卡收起，这一行留在“最近删除”，outbox 里这条记录的项都没了', async ({ page }) => {
    await seed(page);
    await expect(card(page)).toBeVisible({ timeout: 15000 });
    await page.getByTestId('sync-notice-drop').click();
    await expect(card(page)).toHaveCount(0);
    await expect.poll(() => outboxOf(page)).toEqual([]);
    await page.goto('/app/#/trash');
    await expect(page.getByTestId('trash-row-g1')).toBeVisible({ timeout: 15000 });
    await page.reload();
    await expect(page.getByTestId('trash-row-g1')).toBeVisible({ timeout: 15000 });
    await expect(card(page)).toHaveCount(0);   // 重新载入也不再出
  });

  test('撤销条开着时卡在撤销条上面（间隔 8px），撤销条真实高度 = --undo-h（56px）；撤销条走了卡落回去', async ({ page }) => {
    await seed(page);
    await expect(card(page)).toBeVisible({ timeout: 15000 });
    const before = await settledY(page);
    await page.getByTestId('todos-del-n1').click();
    const toast = page.locator('[data-undo-toast]');
    await expect(toast).toBeVisible();
    const t = await toast.boundingBox();
    expect(t?.height).toBe(56);
    await expect.poll(async () => {
      const c = await card(page).boundingBox();
      return c && t ? Math.round(t.y - (c.y + c.height)) : null;
    }).toBeGreaterThanOrEqual(8);
    const c = await card(page).boundingBox();
    expect(c && t ? c.y + c.height <= t.y : false).toBe(true);
    await page.getByTestId('todos-toast').getByRole('button').first().click();   // 撤销：撤销条收起
    await expect(toast).toHaveCount(0);
    await expect.poll(async () => (await card(page).boundingBox())?.y).toBe(before);
  });

  test('别的对话框打开时（scroll-locked）卡隐藏，关上后回来', async ({ page }) => {
    await seed(page);
    await page.goto('/app/#/settings');
    await expect(card(page)).toBeVisible({ timeout: 15000 });
    await page.getByTestId('settings-signout').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(card(page)).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(card(page)).toBeVisible();
  });
});
