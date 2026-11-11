// Q-15 真后端实测（11-11）：管理员停用账号后，本机有没发的“新建”（队列里只有 insert、没有 patch）。npm run e2e:real 跑
// • 新建走 PostgREST upsert，RLS with check 的 private.is_active() 拦下只回 403 / 42501，带不出 account_disabled；
//   修法（src/core/sync/send.ts + app/insert-denied.ts）是先探测 account status，确认停用才按 R-382 只退出、不清库
// • Q15-1 停用后在界面上新建一条待办：回登录页、提示“账号已停用”（data-reason=disabled）；本机库 planner-v4 和 outbox 里那一项都留着；
//   这一项没进失败区（state 不是 failed，不会在 App 里一直显示“未同步”）；服务器上没有这一行
// • Q15-2 对照：同样的步骤、账号不停用 → 照常发上服务器、outbox 清空、不退出
// • 停用：docker exec 进 supabase_db_lemo-e2e 调 private.admin_set_disabled(uid, true)（只认这个容器名，跑前核对它在跑；不碰 lemomemo）
import { spawnSync } from 'node:child_process';
import { type Page } from '@playwright/test';
import { expect, test } from './csp-fixture.ts';
import { zh } from '../../src/features/auth/i18n/zh.ts';
import { createAccount, loginViaOtp, realBackend } from './real-backend.ts';

test.setTimeout(180_000);

const DB_CONTAINER = 'supabase_db_lemo-e2e';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** 管理员停用账号（lemo-e2e 专用库，容器名写死） */
function adminDisable(userId: string): void {
  if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error('userId 不像 uuid');
  const ps = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
  if (ps.status !== 0 || !ps.stdout.split(/\r?\n/).includes(DB_CONTAINER)) throw new Error(`${DB_CONTAINER} 没在跑`);
  const r = spawnSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
    input: `select private.admin_set_disabled('${userId}', true);\nselect disabled_reason from public.profiles where user_id = '${userId}';\n`,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`停用失败：${(r.stderr || '').slice(0, 300)}`);
  expect(r.stdout.trim().split(/\r?\n/).pop()).toBe('admin');
}

async function openApp(page: Page): Promise<void> {
  await page.goto('/app/#/today');
  const consent = page.locator('main[data-feature="onboarding"][data-step="consent"]');
  const app = page.locator('main[data-feature]:not([data-feature="onboarding"])').first();
  await expect(consent.or(app)).toBeVisible({ timeout: 30_000 });
  if (await consent.isVisible()) await consent.getByRole('button', { name: '先不同意，直接用' }).click();
  await expect(app).toBeVisible({ timeout: 30_000 });
}

interface OutboxView { op_id: string; id: string; op: string; state: string; error: unknown }
interface IdbView { exists: boolean; owner: string | null; outbox: OutboxView[]; todoIds: string[] }

async function readIdb(page: Page): Promise<IdbView> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === 'planner-v4')) return { exists: false, owner: null, outbox: [], todoIds: [] };
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
    const items = (await all<Record<string, unknown>[]>('outbox', (s) => s.getAll())) ?? [];
    const outbox = items.map((x) => ({ op_id: String(x['op_id']), id: String(x['id']), op: String(x['op']), state: String(x['state']), error: x['error'] ?? null }));
    const todoIds = ((await all<IDBValidKey[]>('todos', (s) => s.getAllKeys())) ?? []).map(String);
    db.close();
    return { exists: true, owner, outbox, todoIds };
  });
}

/** 服务器上的这一行（service role，不受 RLS） */
async function serverTodo(id: string): Promise<{ id: string; user_id: string }[]> {
  const b = realBackend();
  const r = await fetch(new URL(`/rest/v1/todos?select=id,user_id&id=eq.${id}`, b.api), {
    headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}` },
  });
  expect(r.status).toBe(200);
  return (await r.json()) as { id: string; user_id: string }[];
}

/** 在编辑页新建一条待办（填标题、失焦自动保存），回这条的 id；同时记下 /sb/rest/v1/todos 的回包状态 */
async function newTodo(page: Page, title: string, statuses: number[]): Promise<string> {
  page.on('response', (r) => {
    if (/\/sb\/rest\/v1\/todos/.test(r.url()) && r.request().method() === 'POST') statuses.push(r.status());
  });
  await page.goto('/app/#/todo/new');
  await expect(page.getByTestId('todo-edit')).toBeVisible();
  const el = page.getByTestId('todo-edit-title');
  await el.fill(title);
  await el.press('Tab');
  await expect(page).toHaveURL(new RegExp(`#/todo/${UUID.source}$`));
  return UUID.exec(page.url())?.[0] ?? '';
}

test('Q15-1 停用后本机新建：回登录页提示已停用，本机库和 outbox 留着、不进失败区', async ({ page }) => {
  const a = await createAccount();
  await loginViaOtp(page, a.email);
  await openApp(page);
  await expect.poll(async () => (await readIdb(page)).owner).toBe(a.userId);

  adminDisable(a.userId);
  const statuses: number[] = [];
  const id = await newTodo(page, 'Q15 停用后新建', statuses);

  // ① 回登录页、提示“账号已停用”
  const notice = page.getByTestId('auth-exit-notice');
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveAttribute('data-reason', 'disabled');
  await expect(notice).toHaveText(zh['auth.exit.disabled']);
  await expect(page.locator('main[data-feature]:not([data-feature="onboarding"]):not([data-feature="auth"])')).toHaveCount(0);
  expect(statuses, '新建被 RLS 拒（403）').toContain(403);

  // ② 本机库和 outbox 留着（R-382：停用只退出、不清库）；这一项不在失败区
  const idb = await readIdb(page);
  expect(idb.exists).toBe(true);
  expect(idb.owner).toBe(a.userId);
  expect(idb.todoIds).toContain(id);
  const mine = idb.outbox.filter((x) => x.id === id);
  expect(mine.map((x) => x.op)).toEqual(['insert']);
  expect(mine[0]?.state).not.toBe('failed');

  // ③ 服务器上没有这一行；等一会儿再看还在登录页（没有又回到 App 里挂着“未同步”）
  expect(await serverTodo(id)).toEqual([]);
  await page.waitForTimeout(3000);
  await expect(notice).toBeVisible();
  console.log(`Q15-1 证据：POST todos 状态 ${JSON.stringify(statuses)}；notice=${await notice.getAttribute('data-reason')}；outbox=${JSON.stringify(mine.map((x) => ({ op: x.op, state: x.state })))}；本机 todos 含此行=${idb.todoIds.includes(id)}`);
});

test('Q15-2 对照：没停用的账号同样新建，照常同步上服务器', async ({ page }) => {
  const a = await createAccount();
  await loginViaOtp(page, a.email);
  await openApp(page);
  await expect.poll(async () => (await readIdb(page)).owner).toBe(a.userId);

  const statuses: number[] = [];
  const id = await newTodo(page, 'Q15 对照新建', statuses);
  await expect.poll(async () => (await serverTodo(id)).map((r) => r.user_id), { timeout: 30_000 }).toEqual([a.userId]);
  await expect.poll(async () => (await readIdb(page)).outbox.length, { timeout: 15_000 }).toBe(0);
  await expect(page.getByTestId('auth-exit-notice')).toHaveCount(0);
  await expect(page.getByTestId('todo-edit')).toBeVisible();
  console.log(`Q15-2 证据：POST todos 状态 ${JSON.stringify(statuses)}；服务器有此行；outbox=0`);
});
