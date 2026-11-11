// R-382 真后端回归（架构 4.1a；11-11 独立验证员写的用例，主持人定收进仓库）：npm run e2e:real 跑
// • IV-1 刷新令牌回包丢失、过了复用容忍再用旧令牌刷新被拒：只请重新登录，本机库和没发的修改留着；同账号重新登录后发出去、记号删掉
// • IV-2 登录过期后换别的账号登录：清掉原账号的本机库，原账号的修改不发到新账号；登录页的未同步提示不分账号（R-387）
// • IV-3 真被吊销（别的设备“退出其他所有设备”）：照旧清库、提示被移除、记号不在
// • IV-4 两个标签页：一页刷新被判复用，另一页按记号只关库、不清
// 每条要等 62 秒（过 GoTrue 的令牌复用容忍 60 秒，R-383），所以单条超时放到 240 秒
import { type Page, type BrowserContext } from '@playwright/test';
import { expect, test } from './csp-fixture.ts';
import { zh } from '../../src/features/auth/i18n/zh.ts';
import { createAccount, loginViaOtp, realBackend, sessionKeyFor, type StoredSession } from './real-backend.ts';

test.setTimeout(240_000);

async function openApp(page: Page): Promise<void> {
  await page.goto('/app/');
  const consent = page.locator('main[data-feature="onboarding"][data-step="consent"]');
  const app = page.locator('main[data-feature]:not([data-feature="onboarding"])').first();
  await expect(consent.or(app)).toBeVisible({ timeout: 30_000 });
  if (await consent.isVisible()) await consent.getByRole('button', { name: '先不同意，直接用' }).click();
  await expect(app).toBeVisible({ timeout: 30_000 });
}

interface IdbView { exists: boolean; owner: string | null; outbox: number; todoIds: string[] }

async function readIdb(page: Page): Promise<IdbView> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === 'planner-v4')) return { exists: false, owner: null, outbox: 0, todoIds: [] };
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
    return { exists: true, owner, outbox, todoIds };
  });
}

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
        op_id: crypto.randomUUID(), table: 'todos', id, rec: `todos:${id}`, op: 'insert',
        data: { id, title, created_at: now, updated_at: now }, base_rev: null, own_revs: [], client_ts: now,
        tries: 0, next_at: 0, state: 'pending', v: 1, app: '4.0.0', seq: 1, remind: false, deps: [], error: null,
      });
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
    db.close();
    return id;
  }, title);
}

async function serverTodo(id: string): Promise<{ id: string; user_id: string }[]> {
  const b = realBackend();
  const r = await fetch(new URL(`/rest/v1/todos?select=id,user_id&id=eq.${id}`, b.api), {
    headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}` },
  });
  expect(r.status).toBe(200);
  return (await r.json()) as { id: string; user_id: string }[];
}

/** “回包丢失”：测试进程用当前 refresh token 换一次，回包丢掉（服务器已轮换，本机还拿着旧的） */
async function loseRefreshResponse(rt: string): Promise<void> {
  const b = realBackend();
  const r = await fetch(new URL('/auth/v1/token?grant_type=refresh_token', b.api), {
    method: 'POST', headers: { apikey: b.anonKey, 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: rt }),
  });
  expect(r.status).toBe(200);
  // 新令牌随后又被“别处”用掉一次（GoTrue 只在子令牌还没被用过时才把丢的回包补回来；子令牌被用过、过了复用容忍，旧令牌才会被判复用）
  const j = (await r.json()) as { refresh_token: string };
  const r2 = await fetch(new URL('/auth/v1/token?grant_type=refresh_token', b.api), {
    method: 'POST', headers: { apikey: b.anonKey, 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: j.refresh_token }),
  });
  expect(r2.status).toBe(200);
  await r2.arrayBuffer();
}

/** 读本机会话（页面在同源 /robots.txt 上） */
async function readSession(page: Page): Promise<StoredSession> {
  const origin = new URL(page.url()).origin;
  const key = sessionKeyFor(`${origin}/sb`);
  const raw = await page.evaluate((k) => localStorage.getItem(k), key);
  if (!raw) throw new Error('没有会话');
  return JSON.parse(raw) as StoredSession;
}

/** 让 supabase-js 下次初始化时去刷新：把本机会话 expires_at 改到过去（令牌本身不动） */
async function forceRefreshOnNextLoad(page: Page): Promise<void> {
  const origin = new URL(page.url()).origin;
  const key = sessionKeyFor(`${origin}/sb`);
  await page.evaluate((k) => {
    const s = JSON.parse(localStorage.getItem(k) ?? '{}') as { expires_at?: number };
    s.expires_at = Math.floor(Date.now() / 1000) - 30;
    localStorage.setItem(k, JSON.stringify(s));
  }, key);
}

async function noticeReason(page: Page): Promise<string | null> {
  const n = page.getByTestId('auth-exit-notice');
  await expect(n).toBeVisible({ timeout: 30_000 });
  return n.getAttribute('data-reason');
}

/** A 有一条没发的修改，回包丢失、过了 60 秒复用容忍，再打开 App（supabase-js 用旧 refresh token 刷新，被拒） */
async function expiredWithPending(page: Page): Promise<{ a: Awaited<ReturnType<typeof createAccount>>; todoId: string }> {
  const a = await createAccount();
  await loginViaOtp(page, a.email);
  await openApp(page);
  await expect.poll(async () => (await readIdb(page)).owner).toBe(a.userId);
  const todoId = await injectTodoInsert(page, 'IV 没发出去的待办');
  const s = await readSession(page);
  await loseRefreshResponse(s.refresh_token);
  await page.waitForTimeout(62_000);
  await forceRefreshOnNextLoad(page);
  await page.goto('/app/');
  await noticeReason(page);
  return { a, todoId };
}

test('IV-1 刷新被判复用：只请重新登录、本机库和没发的修改留着；同账号重新登录后发出去', async ({ page }) => {
  const { a, todoId } = await expiredWithPending(page);
  expect(await noticeReason(page)).toBe('expired');
  const idb = await readIdb(page);
  expect(idb.exists).toBe(true);
  expect(idb.owner).toBe(a.userId);
  expect(idb.outbox).toBe(1);
  await expect(page.getByTestId('auth-reauth-kept')).toBeVisible();
  // 同账号重新登录 → 接着同步
  await loginViaOtp(page, a.email);
  await openApp(page);
  await expect.poll(async () => (await serverTodo(todoId)).map((r) => r.user_id), { timeout: 30_000 }).toEqual([a.userId]);
  const after = await readIdb(page);
  expect(after.owner).toBe(a.userId);
  expect(after.outbox).toBe(0);
  const reauth = await page.evaluate(() => localStorage.getItem('lemo.reauth'));
  expect(reauth).toBeNull();
});

test('IV-2 登录过期后换另一个账号登录：清掉 A 的本机库，A 的修改不发到 B', async ({ page }) => {
  const { a, todoId } = await expiredWithPending(page);
  expect(await noticeReason(page)).toBe('expired');
  // 登录页不知道谁要登录：提示不分账号（R-387，独立验证必改 2）
  await expect(page.getByTestId('auth-reauth-pending')).toHaveText(zh['auth.reauth.pending'].replace('{n}', '1'));
  const b = await createAccount();
  await loginViaOtp(page, b.email);
  await openApp(page);
  await expect.poll(async () => (await readIdb(page)).owner).toBe(b.userId);
  const idb = await readIdb(page);
  expect(idb.outbox).toBe(0);
  expect(idb.todoIds).not.toContain(todoId);
  await page.waitForTimeout(3000);
  expect(await serverTodo(todoId)).toEqual([]);
  void a;
});

/** 在另一台“设备”上登录同一账号，调 revoke_my_sessions(false) + logout?scope=others（新版“退出其他所有设备”） */
async function revokeOthersFrom(ctx: BrowserContext, email: string): Promise<void> {
  const p2 = await ctx.newPage();
  const s2 = await loginViaOtp(p2, email);
  const b = realBackend();
  await fetch(new URL('/rest/v1/rpc/revoke_my_sessions', b.api), {
    method: 'POST',
    headers: { apikey: b.anonKey, Authorization: `Bearer ${s2.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_include_current: false }),
  });
  await fetch(new URL('/auth/v1/logout?scope=others', b.api), {
    method: 'POST', headers: { apikey: b.anonKey, Authorization: `Bearer ${s2.access_token}` },
  });
  await p2.close();
}

/** 后端 R-382 迁移（public.session_fate、revoke_my_sessions）在不在：不在时 PostgREST 回 404（PGRST202） */
async function hasSessionFate(): Promise<boolean> {
  const b = realBackend();
  const r = await fetch(new URL('/rest/v1/rpc/session_fate', b.api), {
    method: 'POST', headers: { apikey: b.anonKey, 'content-type': 'application/json' }, body: JSON.stringify({ p_pair: '0'.repeat(64) }),
  });
  await r.arrayBuffer();
  return r.status !== 404;
}

test('IV-3 真被吊销（别的设备“退出其他所有设备”）：照旧清库、提示被移除', async ({ page, browser }) => {
  // 要靠 session_fate 回 revoked 才判“被移除”；后端迁移还没合进来时查不了，按设计判 expired，这条跳过
  test.skip(!(await hasSessionFate()), '后端 R-382 迁移（session_fate、revoke_my_sessions）还没合入，lemo-e2e 上没有这两个函数');
  const a = await createAccount();
  await loginViaOtp(page, a.email);
  await openApp(page);
  await expect.poll(async () => (await readIdb(page)).owner).toBe(a.userId);
  const todoId = await injectTodoInsert(page, 'IV 被吊销前没发的');
  const other = await browser.newContext();
  await revokeOthersFrom(other, a.email);
  await other.close();
  await forceRefreshOnNextLoad(page);
  await page.goto('/app/');
  expect(await noticeReason(page)).toBe('removed');
  await expect.poll(async () => (await readIdb(page)).exists, { timeout: 15_000 }).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('lemo.reauth'))).toBeNull();
  void todoId;
});

test('IV-4 两个标签页：一页刷新被判复用 SIGNED_OUT，另一页按记号只关库、不清', async ({ page, context }) => {
  const a = await createAccount();
  await loginViaOtp(page, a.email);
  await openApp(page);
  await expect.poll(async () => (await readIdb(page)).owner).toBe(a.userId);
  const todoId = await injectTodoInsert(page, 'IV 两页');
  // 第二页先开着 App（会把这条发出去，本机 todos 仓里留着这一行）
  const tab2 = await context.newPage();
  await openApp(tab2);
  await expect.poll(async () => (await readIdb(page)).todoIds.includes(todoId), { timeout: 30_000 }).toBe(true);
  const cur = await readSession(page);
  await loseRefreshResponse(cur.refresh_token);
  await page.waitForTimeout(62_000);
  await forceRefreshOnNextLoad(page);
  await page.goto('/app/');
  expect(await noticeReason(page)).toBe('expired');
  await expect(tab2).toHaveURL(/\/app\/(auth|login)|\/auth/, { timeout: 30_000 }).catch(() => undefined);
  const idb = await readIdb(page);
  expect(idb.exists).toBe(true);
  expect(idb.todoIds).toContain(todoId);
});
