// 完成满 7 天的待办自动删除，等同步第一次拉取成功以后才扫（审查 11-15 第 1 条；src/features/todos/data/todo-autodel.ts、app/sync-wiring.ts 的 afterFirstPull）
// /sb/rest 在浏览器这一层答（fake-rest.ts 存行模式）：服务器上三条已完成的待办——八天前完成没再动过、两天前完成、八天前完成昨天又改过
//   ① 拉取成功以后：只有八天前那条删掉（本机 deleted_at 有值、发出了这一行的 rpc/apply_patch），进“最近删除”；运行日志 todo autodel scan=3 due=1 n=1，不带标题
//   ② 服务器上 settings 的 todo.autodel = false：不删，日志 todo autodel off
//   ③ 启动时后端连不上（/sb 一律断网中止，拉取不成功）：不扫、不删、日志里不多一行 todo autodel；连得上了再刷新，拉取成功以后照常删
// 跑在快读组（playwright.fastread.config.ts）：要会话令牌和同步引擎，默认组的构建没配 supabase 地址、同步不会拉成功（默认组那一半见 todo-autodel.spec.ts）
import type { Page } from '@playwright/test';
import { fakeRest, type FakeRest } from './fake-rest.ts';
import { idbRead } from './idb.ts';
import { expect, seedFakeSession, test } from './session-fixture.ts';
import { logOnFail } from './fail-log.ts';

logOnFail(test);
test.setTimeout(120_000);
test.use({ trace: 'off', timezoneId: 'Asia/Seoul', locale: 'zh-CN', viewport: { width: 390, height: 844 } });

const USER = '0e2e0000-0000-4000-8000-000000000001';
const id = (n: number) => `0e2e0000-0000-4000-8000-0000000ad1${String(n).padStart(2, '0')}`;
const OLD = id(1);
const NEW = id(2);
const EDITED = id(3);
const DAY = 86400000;

const runLog = (page: Page) => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');
const viewOf = async (page: Page, rid: string) => (await idbRead<{ view: { deleted_at: unknown } }>(page, 'todos', 'get', rid))?.view;

/** autodel：服务器上 settings 的 todo.autodel（不给就没有这一行，默认开）；rev 越大越新，③ 联网后改回 true 用 rev 2 */
async function fakeServer(page: Page, baseURL: string | undefined, o: { autodel?: { value: boolean; rev: number } } = {}): Promise<FakeRest> {
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  const now = Date.now();
  const at = new Date(now).toISOString();
  const c = { user_id: USER, created_at: 1, deleted_at: null, undone: false, rev: 1, synced_at: at };
  // 待办要带齐必填列（shared/schema/rows-read.ts 的 requiredColsOf，同 b4b2-find.spec.ts）；remind_time 要是字符串，null 会被宽容读取当坏行（refetch）
  const item = { project: '', source: 'page', raw_text: '', short: null, short_by: null, push_show_title: null, batch_id: null, notified_for: null, snooze_at: null };
  const todo = (rid: string, title: string, ago: number, editedAgo?: number) => {
    const done = now - ago * DAY;
    return {
      id: rid, ...c, ...item, title, note: '', due: null, done: true, important: false, priority: 'mid', from_note_id: null, from_anniv_id: null, done_at: done,
      updated_at: editedAgo === undefined ? done : now - editedAgo * DAY, remind_days: null, remind_time: '09:00', due_time: null, remind_before_min: null,
    };
  };
  const tables: Record<string, Record<string, unknown>[]> = {
    todos: [todo(OLD, '八天前完成', 8), todo(NEW, '两天前完成', 2), todo(EDITED, '完成后改过', 8, 1)],
    settings: o.autodel ? [{ id: id(30), ...c, rev: o.autodel.rev, updated_at: now, key: 'todo.autodel', value: o.autodel.value }] : [],
  };
  return fakeRest(page, { user: USER, tables, store: { patch: true } });
}

test.describe('完成 7 天后自动删除：第一次拉取成功以后才扫', () => {
  test('① 拉取成功以后删掉完成满 7 天、没再动过的那条，进最近删除；日志只记条数', async ({ page, baseURL }) => {
    await fakeServer(page, baseURL);
    // 写走 rpc/apply_patch（fake-rest 不答 rpc，回 404，outbox 留着重试）：只认请求发出去、带的是八天前那一条
    const sent = page.waitForRequest((r) => r.url().includes('/sb/rest/v1/rpc/apply_patch') && (r.postData() ?? '').includes(OLD), { timeout: 20000 });
    await page.goto('/app/#/todos');
    await page.getByTestId('todos').waitFor({ timeout: 30000 });
    await expect.poll(() => runLog(page), { timeout: 20000 }).toContain('todo autodel scan=3 due=1 n=1');
    expect(await runLog(page)).not.toContain('八天前完成');
    await expect.poll(async () => (await viewOf(page, OLD))?.deleted_at ?? null, { timeout: 10000 }).not.toBeNull();
    expect((await viewOf(page, NEW))?.deleted_at ?? null).toBeNull();
    expect((await viewOf(page, EDITED))?.deleted_at ?? null).toBeNull();
    expect((await sent).postData() ?? '').not.toContain(NEW);
    await page.goto('/app/#/trash');
    await expect(page.getByTestId(`trash-row-${OLD}`)).toContainText('八天前完成');
    await expect(page.getByTestId(`trash-row-${NEW}`)).toHaveCount(0);
  });

  test('② 开关关着（settings todo.autodel = false）：不删，日志 todo autodel off', async ({ page, baseURL }) => {
    await fakeServer(page, baseURL, { autodel: { value: false, rev: 1 } });
    await page.goto('/app/#/todos');
    await page.getByTestId('todos').waitFor({ timeout: 30000 });
    await expect.poll(() => runLog(page), { timeout: 20000 }).toContain('todo autodel off');
    expect(await runLog(page)).not.toContain('todo autodel scan=');
    expect((await viewOf(page, OLD))?.deleted_at ?? null).toBeNull();
  });
});

// ③ 不用 SW（serviceWorkers: 'block'）：webkit 里 SW 接管以后页面发的请求不经 page.route，拦不住也答不了；这里要的是“后端连不上”，
// 用 page.route 把 /sb 一律按断网中止（context.setOffline 拦不住 page.route 当场答的请求），比真断网更稳
test.describe('完成 7 天后自动删除：后端连不上', () => {
  test.use({ serviceWorkers: 'block' });

  test('③ 启动时后端连不上、拉不成功：不扫、不删；连得上了再刷新，拉取成功以后照常删', async ({ page, baseURL }) => {
    await fakeServer(page, baseURL, { autodel: { value: false, rev: 1 } });
    // 先让本机库有这三条（开关关着，这一轮不删）
    await page.goto('/app/#/todos');
    await expect.poll(() => runLog(page), { timeout: 20000 }).toContain('todo autodel off');
    const times = async () => (await runLog(page)).split('todo autodel').length - 1;
    await page.waitForTimeout(500);
    const before = await times();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.route(/\/sb\//, (r) => r.abort('internetdisconnected'));
    await page.reload();
    await page.getByTestId('todos').waitFor({ timeout: 30000 });
    await page.waitForTimeout(4000);
    const lines = (await runLog(page)).split('\n').filter((l) => /autodel|=== start|GET \/sb\/rest\/v1\/todos/.test(l));
    expect(await times(), `连不上这次不该扫：\n${lines.join('\n')}`).toBeLessThanOrEqual(before);
    expect((await viewOf(page, OLD))?.deleted_at ?? null).toBeNull();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await fakeServer(page, baseURL, { autodel: { value: true, rev: 2 } });   // 连得上了，服务器上开关改回开：拉取成功以后要删
    await page.reload();
    await expect.poll(() => runLog(page), { timeout: 20000 }).toContain('todo autodel scan=3 due=1 n=1');
    await expect.poll(async () => (await viewOf(page, OLD))?.deleted_at ?? null, { timeout: 10000 }).not.toBeNull();
  });
});
