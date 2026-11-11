// TC-B2-01（B2 QA 缺口 G-01；接手清单 K8-e2e 里 b1-sync.spec.ts 那几条 fixme 的 B2 部分）：真后端里新建、编辑、完成、删除日程和待办，
// 四种类型（全天日程、有时刻的日程；有截止日的待办、有截止日加时刻的待办；无日期的待办）都要：保存上服务器、刷新后保持、另一端同步。
// npm run e2e:real 跑（/sb 接 lemo-e2e）。同一个账号在两个浏览器上下文（X、Y，两台设备）各自 loginViaOtp（不发信）：
//   ① X 在编辑页新建（真界面：填标题、日期、时刻，失焦自动保存）→ 服务器上（X 的会话经 /sb 打 REST，RLS 下）有这一行、各列对；
//   ② X 整页刷新再打开这一条：编辑页的值还在（本机库 planner-v4 + 拉取）；
//   ③ Y 不刷新：本机库 planner-v4 里出现这一行、各列对（Realtime 或 60 秒轮询，等 75 秒）；
//   ④ X 改标题 → 服务器和 Y 都变；待办再勾“完成” → 服务器和 Y 的 done 都是 true；
//   ⑤ X 点“删除”（进最近删除，软删）→ 服务器和 Y 的 deleted_at 都有值。
// 冲突、离线、永久删除墓碑那几条（TC-B1-23、24、27、59）不在这里，仍在 b1-sync.spec.ts 里 fixme。
import type { Browser, Page } from '@playwright/test';
import { expect, test } from './csp-fixture.ts';
import { createAccount, loginViaOtp, restInPage } from './real-backend.ts';

const TZ = 'Asia/Seoul';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const SYNC_MS = 75_000;
test.setTimeout(240_000);

/** 打开 /app/；首次登录先过告知页（点“先不同意，直接用”），等到主界面出来（5 条并发、10 个上下文冷启动，给 30 秒） */
async function openApp(page: Page, hash = '#/today'): Promise<void> {
  await page.goto(`/app/${hash}`);
  const consent = page.locator('main[data-feature="onboarding"][data-step="consent"]');
  const app = page.locator('main[data-feature]:not([data-feature="onboarding"])').first();
  await expect(consent.or(app)).toBeVisible({ timeout: 30_000 });
  if (await consent.isVisible()) await consent.getByRole('button', { name: '先不同意，直接用' }).click();
  await expect(app).toBeVisible({ timeout: 30_000 });
}

/** 同一账号的两台设备 X、Y */
async function twoDevices(browser: Browser): Promise<{ x: Page; y: Page; close: () => Promise<void> }> {
  const acc = await createAccount();
  const cx = await browser.newContext({ timezoneId: TZ, locale: 'zh-CN' });
  const cy = await browser.newContext({ timezoneId: TZ, locale: 'zh-CN' });
  const x = await cx.newPage();
  const y = await cy.newPage();
  await loginViaOtp(x, acc.email);
  await loginViaOtp(y, acc.email);
  await openApp(x);
  await openApp(y);
  return { x, y, close: async () => void (await Promise.all([cx.close(), cy.close()])) };
}

/** 本机库 planner-v4 某个仓里一行的 view（界面上看到的那份；没有就 null） */
async function idbRow(page: Page, store: 'todos' | 'events', id: string): Promise<Record<string, unknown> | null> {
  return page.evaluate(
    async ({ store, id }) => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('planner-v4');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      try {
        if (!db.objectStoreNames.contains(store)) return null;
        return await new Promise<Record<string, unknown> | null>((res, rej) => {
          const q = db.transaction(store, 'readonly').objectStore(store).get(id);
          // 本机行存成 {id, server, view}（core/cache-schema.ts）：看界面上用的 view
          q.onsuccess = () => res((q.result as { view?: Record<string, unknown> } | undefined)?.view ?? null);
          q.onerror = () => rej(q.error);
        });
      } finally {
        db.close();
      }
    },
    { store, id },
  );
}

/** 服务器上的一行（X 的会话、RLS 下） */
async function serverRow(page: Page, table: 'todos' | 'events', id: string, cols: string): Promise<Record<string, unknown> | null> {
  const r = await restInPage(page, 'GET', `/rest/v1/${table}?id=eq.${id}&select=${cols}`);
  expect(r.status).toBe(200);
  return (r.body as Record<string, unknown>[])[0] ?? null;
}

const pick = (row: Record<string, unknown> | null, keys: string[]): Record<string, unknown> | null =>
  row === null ? null : Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));

/** 服务器和 Y 的本机库都变成 want（只比 want 里的列） */
async function expectBoth(x: Page, y: Page, table: 'todos' | 'events', id: string, want: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(want);
  await expect.poll(async () => pick(await serverRow(x, table, id, keys.join(',')), keys), { timeout: 15_000, message: `服务器上的 ${table} 行` }).toEqual(want);
  await expect.poll(async () => pick(await idbRow(y, table, id), keys), { timeout: SYNC_MS, message: `另一台设备本机库里的 ${table} 行` }).toEqual(want);
}

async function commit(page: Page, testId: string, value: string): Promise<void> {
  const el = page.getByTestId(testId);
  await el.fill(value);
  await el.press('Tab');
}

interface TodoSpec {
  name: string;
  due: string | null;
  dueTime: string | null;
}
const TODOS: TodoSpec[] = [
  { name: '有截止日', due: '2026-11-20', dueTime: null },
  { name: '有截止日和时刻', due: '2026-11-20', dueTime: '17:00' },
  { name: '无日期', due: null, dueTime: null },
];

for (const s of TODOS) {
  test(`待办（${s.name}）：新建、刷新保持、另一端同步；改标题、完成、删除也同步`, async ({ browser }) => {
    const { x, y, close } = await twoDevices(browser);
    try {
      const title = `G01 待办 ${s.name}`;
      await x.goto('/app/#/todo/new');
      await expect(x.getByTestId('todo-edit')).toBeVisible();
      await commit(x, 'todo-edit-title', title);
      await expect(x).toHaveURL(new RegExp(`#/todo/${UUID.source}$`));
      const id = UUID.exec(x.url())?.[0] ?? '';
      if (s.due !== null) await commit(x, 'todo-edit-due', s.due);
      if (s.dueTime !== null) await commit(x, 'todo-edit-due-time', s.dueTime);
      const want = { title, due: s.due, due_time: s.dueTime, done: false, deleted_at: null };
      await expectBoth(x, y, 'todos', id, want);

      // 刷新后保持
      await x.reload();
      await expect(x.getByTestId('todo-edit-title')).toHaveValue(title);
      await expect(x.getByTestId('todo-edit-due')).toHaveValue(s.due ?? '');
      if (s.dueTime !== null) await expect(x.getByTestId('todo-edit-due-time')).toHaveValue(s.dueTime);

      // 改标题、完成
      await commit(x, 'todo-edit-title', `${title}（改）`);
      await expectBoth(x, y, 'todos', id, { ...want, title: `${title}（改）` });
      await x.getByTestId('todo-edit-done').check();
      await expectBoth(x, y, 'todos', id, { ...want, title: `${title}（改）`, done: true });

      // 删除（进最近删除）
      await x.getByTestId('todo-edit-delete').click();
      await expect(x.getByTestId('todo-edit-undo')).toBeVisible();
      await expect.poll(async () => (await serverRow(x, 'todos', id, 'deleted_at'))?.['deleted_at'] ?? null, { timeout: 15_000 }).not.toBeNull();
      await expect.poll(async () => (await idbRow(y, 'todos', id))?.['deleted_at'] ?? null, { timeout: SYNC_MS }).not.toBeNull();
    } finally {
      await close();
    }
  });
}

interface EventSpec {
  name: string;
  time: string | null;
}
const EVENTS: EventSpec[] = [
  { name: '全天', time: null },
  { name: '有时刻', time: '15:30' },
];

for (const s of EVENTS) {
  test(`日程（${s.name}）：新建、刷新保持、另一端同步；改标题、删除也同步`, async ({ browser }) => {
    const { x, y, close } = await twoDevices(browser);
    try {
      const title = `G01 日程 ${s.name}`;
      const date = '2026-11-21';
      await x.goto('/app/#/event/new');
      await expect(x.getByTestId('event-edit')).toBeVisible();
      await commit(x, 'event-edit-title', title);
      await expect(x).toHaveURL(new RegExp(`#/event/${UUID.source}$`));
      const id = UUID.exec(x.url())?.[0] ?? '';
      await commit(x, 'event-edit-date', date);
      const allDay = x.getByTestId('event-edit-allday');
      if (s.time === null) {
        if (!(await allDay.isChecked())) await allDay.check();
      } else {
        if (await allDay.isChecked()) await allDay.uncheck();
        await commit(x, 'event-edit-start', s.time);
      }
      const want = { title, date, time: s.time, deleted_at: null };
      await expectBoth(x, y, 'events', id, want);

      await x.reload();
      await expect(x.getByTestId('event-edit-title')).toHaveValue(title);
      await expect(x.getByTestId('event-edit-date')).toHaveValue(date);
      if (s.time === null) await expect(x.getByTestId('event-edit-allday')).toBeChecked();
      else await expect(x.getByTestId('event-edit-start')).toHaveValue(s.time);

      await commit(x, 'event-edit-title', `${title}（改）`);
      await expectBoth(x, y, 'events', id, { ...want, title: `${title}（改）` });

      await x.getByTestId('event-edit-delete').click();
      await expect(x.getByTestId('event-edit-undo')).toBeVisible();
      await expect.poll(async () => (await serverRow(x, 'events', id, 'deleted_at'))?.['deleted_at'] ?? null, { timeout: 15_000 }).not.toBeNull();
      await expect.poll(async () => (await idbRow(y, 'events', id))?.['deleted_at'] ?? null, { timeout: SYNC_MS }).not.toBeNull();
    } finally {
      await close();
    }
  });
}
