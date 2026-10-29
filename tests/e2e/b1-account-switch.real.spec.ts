// B1 K6：换账号清本机（架构 4.1、0.38 第 17 条）的真后端端到端（E2E-REAL 第 5 步，从 b1-account-switch.spec.ts 的 test.fixme 搬来，10-30）
// npm run e2e:real 跑：/sb 接 lemo-e2e，A、B 两个账号都是 createAccount + loginViaOtp（不发信）。
// 偏差（照实写）：
//   ① B2 之前没有能新记条目的界面，“A 有没发出去的改动”用注入代替：页面不在 App 上时（同源的 /robots.txt），往本机库 planner-v4 的
//      outbox 仓写一条 todos 的 insert（格式按 src/core/outbox-types.ts 的 OutboxItem，v = OUTBOX_V = 1）。
//      第一条对照用例证明这个注入格式是对的：不换账号、联网打开 App，K8 真把它发到服务器、行归 A。
//   ② “以 B 登录”不走登录页（真发信只留给 TC-B1-16、17）：loginViaOtp 直接写 B 的会话再打开 /app/，判断时机是冷启动（boot.ts 的 coldStart）；
//      本页 SIGNED_IN 的时机由单元测试覆盖（src/core/__tests__/account.test.ts、src/platform/__tests__/session.test.ts）。
//   ③ 第二条换账号用例是别的标签页换账号：两个标签页同一个 context（共用 localStorage、IndexedDB），第二个标签页停在 A 的 /app/，
//      第一个标签页写入 B 的会话 → 第二个标签页收到 storage 事件，清库并重新载入，载入后是 B。
// 每条用例自己建账号，互不依赖。
import { type Page } from '@playwright/test';
import { expect, test } from './csp-fixture.ts';
import { createAccount, loginViaOtp, realBackend } from './real-backend.ts';

/** 打开 /app/；首次登录先过告知页（点“先不同意，直接用”），等到主界面出来 */
async function openApp(page: Page): Promise<void> {
  await page.goto('/app/');
  const consent = page.locator('main[data-feature="onboarding"][data-step="consent"]');
  const app = page.locator('main[data-feature]:not([data-feature="onboarding"])').first();
  await expect(consent.or(app)).toBeVisible();
  if (await consent.isVisible()) {
    await consent.getByRole('button', { name: '先不同意，直接用' }).click();
  }
  await expect(app).toBeVisible();
}

interface IdbView {
  owner: string | null;
  outbox: number;
  todoIds: string[];
}

/** 读本机库 planner-v4：owner、outbox 条数、todos 仓里的 id（库不存在就全空） */
async function readIdb(page: Page): Promise<IdbView> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === 'planner-v4')) return { owner: null, outbox: 0, todoIds: [] };
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('planner-v4');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = <T,>(store: string, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> =>
      db.objectStoreNames.contains(store)
        ? new Promise((res, rej) => {
            const q = op(db.transaction(store, 'readonly').objectStore(store));
            q.onsuccess = () => res(q.result);
            q.onerror = () => rej(q.error);
          })
        : Promise.resolve(null);
    const owner = (await all<{ value?: string } | undefined>('owner', (s) => s.get('user_id')))?.value ?? null;
    const outbox = (await all<number>('outbox', (s) => s.count())) ?? 0;
    const todoIds = ((await all<IDBValidKey[]>('todos', (s) => s.getAllKeys())) ?? []).map(String);
    db.close();
    return { owner, outbox, todoIds };
  });
}

/** 不在 App 上时（同源 /robots.txt）往 outbox 仓注入一条 todos 的 insert；返回记录 id */
async function injectTodoInsert(page: Page, title: string): Promise<string> {
  await page.goto('/robots.txt');
  return page.evaluate(async (title) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('planner-v4');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise<void>((res, rej) => {
      const t = db.transaction('outbox', 'readwrite');
      t.objectStore('outbox').put({
        op_id: crypto.randomUUID(),
        table: 'todos',
        id,
        rec: `todos:${id}`,
        op: 'insert',
        data: { id, title, created_at: now, updated_at: now },
        base_rev: null,
        own_revs: [],
        client_ts: now,
        tries: 0,
        next_at: 0,
        state: 'pending',
        v: 1,
        app: '4.0.0',
        seq: 1,
        remind: false,
        deps: [],
        error: null,
      });
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
    db.close();
    return id;
  }, title);
}

/** 用 service role 查服务器上这个 id 的 todos 行（不分账号） */
async function serverTodo(id: string): Promise<{ id: string; user_id: string; title: string }[]> {
  const b = realBackend();
  const r = await fetch(new URL(`/rest/v1/todos?select=id,user_id,title&id=eq.${id}`, b.api), {
    headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}` },
  });
  expect(r.status).toBe(200);
  return (await r.json()) as { id: string; user_id: string; title: string }[];
}

/**
 * A 登录、过告知页、本机库归 A；离开 App（停在 /robots.txt）后注入一条没发的 todos insert。
 * 不用断网：页面不在 App 上就没有同步在跑，注入的这一条只有下次打开 App 才可能被发出去
 */
async function aWithPendingOutbox(page: Page): Promise<{ a: string; todoId: string }> {
  const a = await createAccount();
  await loginViaOtp(page, a.email);
  await openApp(page);
  await expect.poll(async () => (await readIdb(page)).owner).toBe(a.userId);
  const todoId = await injectTodoInsert(page, 'A 没发出去的待办');
  return { a: a.userId, todoId };
}

test.describe('换账号清本机（架构 4.1、0.38 第 17 条）', () => {
  test('对照：不换账号，重新打开 App，注入的 outbox 真的发到服务器、行归 A（证明注入格式对）', async ({ page }) => {
    const { a, todoId } = await aWithPendingOutbox(page);
    await openApp(page);
    await expect.poll(() => serverTodo(todoId), { timeout: 20_000 }).toEqual([{ id: todoId, user_id: a, title: 'A 没发出去的待办' }]);
    await expect.poll(async () => (await readIdb(page)).outbox, { timeout: 20_000 }).toBe(0);
  });

  test('同一个标签页：A 有没发的 outbox → 换成 B 的会话、打开 /app/ → 本机库归 B、outbox 空、没有 A 的行，服务器上没有那一条', async ({ page }) => {
    const { a, todoId } = await aWithPendingOutbox(page);
    const before = await readIdb(page);
    expect(before.owner).toBe(a);
    expect(before.outbox).toBe(1);

    const b = await createAccount();
    await loginViaOtp(page, b.email);
    await openApp(page);

    await expect.poll(async () => (await readIdb(page)).owner).toBe(b.userId);
    const after = await readIdb(page);
    expect(after.outbox).toBe(0);
    expect(after.todoIds).not.toContain(todoId);
    // 给同步留时间：真发出去的话几秒内就到服务器（对照用例里是这样）
    await page.waitForTimeout(3_000);
    expect(await serverTodo(todoId)).toEqual([]);
  });

  test('别的标签页换了账号：停在 A 的 /app/ 的标签页收到 storage 事件后清库并重新载入，载入后是 B', async ({ context, page }) => {
    const a = await createAccount();
    await loginViaOtp(page, a.email);
    await openApp(page);
    await expect.poll(async () => (await readIdb(page)).owner).toBe(a.userId);

    // 载入前在 window 上做个标记：真的重新载入过，新页面里就没有它（审查建议 2：不再主动 openApp，免得把“自己打开”当成“重新载入”）
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>)['__e2eBeforeSwitch'] = true;
    });
    const other = await context.newPage();
    const b = await createAccount();
    const reloaded = page.waitForEvent('load');
    await loginViaOtp(other, b.email);   // 写 localStorage → page 收到 storage 事件
    await reloaded;

    // 重新载入后的页面出来了：标记没了，还在 /app/（没跳去登录页），主界面或告知页（B 首次登录）出现
    await expect.poll(() => page.evaluate(() => '__e2eBeforeSwitch' in window)).toBe(false);
    expect(new URL(page.url()).pathname).toBe('/app/');
    await expect(page.locator('main[data-feature]').first()).toBeVisible();
    await expect.poll(async () => (await readIdb(page)).owner).toBe(b.userId);
    const uid = await page.evaluate(() => {
      const k = Object.keys(localStorage).find((x) => /^sb-.+-auth-token$/.test(x)) ?? '';
      return (JSON.parse(localStorage.getItem(k) ?? '{}') as { user?: { id?: string } }).user?.id ?? null;
    });
    expect(uid).toBe(b.userId);
    await other.close();
  });
});
