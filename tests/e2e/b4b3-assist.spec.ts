// B4b-3 “＋”统一入口与 AI 助手（架构 5.14 第 2～4、7 点；线框 s12、sFind、sPlus）。
// /sb 在浏览器这一层答：一条日程、一条待办、一条随手记；ai-parse、ai-summarize 按用例回。
//   ① 手机：“＋”打“总结一下这周的随手记”→ 本机有把握，不调 ai-parse，打开结果层：“理解成”一行、列表、总结卡（ai-summarize 回的那段）；
//   ② 手机：“＋”打“查一下 洗牙”→ 查找面板（页脚“改成记下”）→ 待办那行“⋯”→ 完成 → “已完成 · 撤销”→ 撤销写回；
//   ③ 手机：AI 判成取消（ai-parse 回 cancel，本机也看出迹象）→ 结果层的确认卡列出那条日程；
//   ④ 电脑（1280）：同 ①，结果层居中；
//   运行日志有 assist send / list / sum，没有原话；设了 LEMO_SHOT_DIR 时在 Chromium 上存评审截图（浅色、深色）。
// 跑在快读组（playwright.fastread.config.ts）：ai-parse、ai-summarize 要会话令牌，默认组的构建没配 supabase 地址。
import type { Page } from '@playwright/test';
import { FADE_GUARD_MS } from '../../src/motion/index.ts';
import { logOnFail } from './fail-log.ts';
import { expect, seedFakeSession, test } from './session-fixture.ts';

test.skip(!process.env['VITE_PUBLIC_SUPABASE_URL'], '要会话令牌和 /sb 地址，只在快读组跑（npm run e2e:fastread）');
test.setTimeout(120_000);
test.use({ trace: 'off', timezoneId: 'Asia/Seoul', locale: 'zh-CN' });

const SHOT_DIR = process.env['LEMO_SHOT_DIR'];
const USER = '0e2e0000-0000-4000-8000-000000000001';
const id = (n: number) => `0e2e0000-0000-4000-8000-0000000b4b${String(n).padStart(2, '0')}`;
const EV = id(41);
const TD = id(42);
const NT = id(43);
const V = '2026-10-29';
/** ai-summarize 回的正文：[1] 是服务器改写好的角标（relinkCites），页面上画成小号数字 */
const SUMMARY = '这周记了一家拉面店[1]，汤头很浓。';
const SUMMARY_SHOWN = '这周记了一家拉面店1，汤头很浓。';

type Fake = { parses: unknown[]; sums: unknown[]; writes: { table: string; body: unknown }[]; pulled: Set<string> };

async function fakeServer(page: Page, baseURL: string | undefined, parse: Record<string, unknown> | null = null): Promise<Fake> {
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  const now = Date.now();
  const at = new Date(now).toISOString();
  const c = { user_id: USER, created_at: now, updated_at: now, deleted_at: null, undone: false, rev: 1, synced_at: at };
  const item = { project: '', source: 'page', raw_text: '', short: null, short_by: null, push_show_title: null, batch_id: null, notified_for: null, snooze_at: null };
  const day = new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
  const tables: Record<string, Record<string, unknown>[]> = {
    events: [{ id: EV, ...c, ...item, title: '看牙医', date: day, time: '23:30', tz: 'Asia/Seoul', duration_min: 30, location: '江南站 3 号口', note: '', remind_min: null, remind_days: null }],
    todos: [{ id: TD, ...c, ...item, title: '预约洗牙', note: '', project: '健康', due: null, done: false, important: false, from_note_id: null, from_anniv_id: null, done_at: 0, remind_days: null, remind_time: '09:00', due_time: null, remind_before_min: null }],
    notes: [{ id: NT, ...c, title: '拉面店', body: '弘大那家拉面店，汤头很浓。', is_private: false, category_id: null, category_source: 'none', category_seen: true, tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null }],
    settings: [{ id: id(50), ...c, key: 'ai.enabled', value: true }],
  };
  const fake: Fake = { parses: [], sums: [], writes: [], pulled: new Set() };
  await page.route(/\/sb\/rest\/v1\//, (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const name = u.pathname.split('/').pop() ?? '';
    // 结果层页脚的“今天 已用 / 上限”（platform/ai-usage.ts）
    if (name === 'my_ai_usage') return route.fulfill({ json: { ai_used: 19, ai_limit: 50, pacific_date: '2026-11-14' } });
    if (req.method() !== 'GET') {
      fake.writes.push({ table: name, body: req.postDataJSON() });
      return route.fulfill({ status: 201, json: [{ rev: 2 }] });
    }
    fake.pulled.add(name);
    if (tables[name]) return route.fulfill({ json: tables[name] });
    if (name === 'profiles') return route.fulfill({ json: [{ user_id: USER, consent_policy_ver: V, consent_ai_at: at }] });
    if (name === 'app_config' && u.searchParams.get('select') === 'notice') return route.fulfill({ json: [{ notice: { policy_ver: V, min_consent_ver: V } }] });
    return route.fulfill({ json: [] });
  });
  await page.route(/\/sb\/functions\/v1\/ai-parse/, (route) => {
    fake.parses.push(route.request().postDataJSON());
    return route.fulfill({ json: parse ?? { fallback: true, reason: 'error' } });
  });
  await page.route(/\/sb\/functions\/v1\/ai-summarize/, (route) => {
    fake.sums.push(route.request().postDataJSON());
    return route.fulfill({ json: { summary: SUMMARY, cited: [NT], missing: [], quota_left: 40 } });
  });
  await page.route(/\/sb\/functions\/v1\/note-search/, (route) => route.fulfill({ json: { hits: [] } }));
  return fake;
}

const runLog = (page: Page) => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');

// 失败时带运行日志、控制台错误（tests/e2e/fail-log.ts）
logOnFail(test);

async function shot(page: Page, browserName: string, name: string): Promise<void> {
  if (browserName !== 'chromium' || !SHOT_DIR) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, animations: 'disabled' });
}

/** 浅色、深色各截一张，截完回到浅色 */
async function shots(page: Page, browserName: string, name: string): Promise<void> {
  await shot(page, browserName, `${name}-浅色`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, browserName, `${name}-深色`);
  await page.emulateMedia({ colorScheme: 'light' });
}

/** 首次同步要用到的表：settings 的 ai.enabled、profiles 的同意版本没落地前，“＋”按 AI 没开走本机规则（11-14 运行日志 assist list … n=0、③ 记成了“已记下”） */
const FIRST_PULL = ['events', 'todos', 'notes', 'settings', 'profiles'];

async function openToday(page: Page, fake: Fake): Promise<void> {
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today')).toBeVisible({ timeout: 30_000 });
  // 等首次同步拉完、日程出现在今天页，再留一点时间让本机库写完；不然打字时数据还没到，结果层查不到、AI 也当没开
  await expect.poll(() => FIRST_PULL.filter((t) => !fake.pulled.has(t)), { timeout: 20_000 }).toEqual([]);
  await expect(page.getByText('看牙医').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(Math.max(FADE_GUARD_MS, 300));
}

async function typeAndSend(page: Page, text: string): Promise<void> {
  await page.getByTestId('tabbar-add').click();
  await expect(page.getByTestId('type-input')).toBeFocused({ timeout: 10_000 });
  await page.getByTestId('type-input').fill(text);
  await page.getByTestId('type-input').press('Enter');
}

async function summarizeFlow(page: Page, fake: Fake): Promise<void> {
  await typeAndSend(page, '总结一下这周的随手记');
  await expect(page.getByTestId('assist-panel')).toBeVisible({ timeout: 10_000 });
  // 线框 22：顶部“✕ 关闭”、引号原话；焦点在面板本身，不在“关闭”上
  await expect(page.getByTestId('assist-panel')).toBeFocused();
  await expect(page.getByTestId('assist-close')).not.toBeFocused();
  await expect(page.getByTestId('assist-said')).toHaveText('“总结一下这周的随手记”');
  await expect(page.getByTestId('assist-understand')).toBeVisible();
  await expect(page.getByTestId('assist-edit')).toBeVisible();
  await expect(page.getByTestId('assist-row')).toHaveCount(1);
  await expect(page.getByTestId('assist-summary-text')).toHaveText(SUMMARY_SHOWN, { timeout: 10_000 });
  await expect(page.getByTestId('assist-cite')).toHaveText('1');
  await expect(page.getByTestId('assist-num')).toHaveText('1');
  await expect(page.getByTestId('assist-usage')).toHaveText('这次用了 1 次 AI · 今天 19 / 50');
  // 本机有把握：不调 ai-parse；总结只送 id，不送正文
  expect(fake.parses).toEqual([]);
  expect(fake.sums).toHaveLength(1);
  expect(JSON.stringify(fake.sums[0])).toContain(NT);
  expect(JSON.stringify(fake.sums[0])).not.toContain('汤头');
}

test.describe('B4b-3 结果层：手机', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('① 总结这周的随手记：不调 ai-parse，结果层列出依据、总结卡；日志不带原话', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL);
    await openToday(page, fake);
    await summarizeFlow(page, fake);
    await shots(page, browserName, '手机-结果层-总结');
    await page.getByTestId('assist-close').click();
    await expect(page.getByTestId('assist-panel')).toHaveCount(0);
    await expect.poll(() => runLog(page), { timeout: 10_000 }).toMatch(/assist sum /);
    const log = await runLog(page);
    expect(log).toMatch(/assist send intent=summarize from=plus ai=0 len=10/);
    expect(log).toMatch(/assist list intent=summarize n=1/);
    expect(log).not.toContain('随手记');
  });

  test('⑤ “理解成”那一行的“改”：回到打字条，原话带回去可以改', async ({ page, baseURL }) => {
    const fake = await fakeServer(page, baseURL);
    await openToday(page, fake);
    await summarizeFlow(page, fake);
    await page.getByTestId('assist-edit').click();
    await expect(page.getByTestId('assist-panel')).toHaveCount(0);
    await expect(page.getByTestId('type-input')).toHaveValue('总结一下这周的随手记', { timeout: 10_000 });
    expect(await runLog(page)).toMatch(/assist edit from=plus opener=1/);
  });

  test('② 查找面板：待办那行“⋯”→ 完成 → 撤销写回；页脚有“改成记下”', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL);
    await openToday(page, fake);
    await typeAndSend(page, '查一下 洗牙');
    await expect(page.getByTestId('find-panel')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('find-record')).toBeVisible();
    const row = page.getByTestId('find-row').first();
    await expect(row).toHaveAttribute('data-kind', 'todo');
    await shots(page, browserName, '手机-查找面板-页脚');
    await page.getByTestId('find-row-more').first().click();
    await shots(page, browserName, '手机-查找面板-每行菜单');
    await page.getByTestId('find-m-done').click();
    await expect(page.getByTestId('find-undo')).toContainText('已完成');
    // 标完成以后这一行左边画成打勾圆、标题删除线（同待办列表）
    await expect(page.getByTestId('find-row').first()).toHaveAttribute('data-done', 'true');
    await shots(page, browserName, '手机-查找面板-撤销条');
    await page.getByTestId('find-undo-undo').click();
    await expect(page.getByTestId('find-undo')).toHaveCount(0);
    await expect.poll(() => runLog(page), { timeout: 10_000 }).toMatch(/find act undo n=1/);
    expect(await runLog(page)).toMatch(/find act done kind=todo ok=1/);
    expect(fake.parses).toEqual([]);
  });

  test('③ AI 判成取消：确认卡列出那条日程，不新建、不直接改', async ({ page, baseURL, browserName }) => {
    const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const fake = await fakeServer(page, baseURL, { intent: 'cancel', confidence: 0.9, target: { text: '牙医', date: day, time: null, kinds: ['event'] }, to: null, quota_left: 30 });
    await openToday(page, fake);
    await typeAndSend(page, '今天看牙医不去了');
    await expect(page.getByTestId('assist-panel')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('assist-target')).toBeVisible();
    await expect(page.getByTestId('assist-cand')).toContainText('看牙医');
    await shots(page, browserName, '手机-结果层-取消确认卡');
    // 没点确认：什么都没写
    expect(fake.writes.filter((w) => w.table === 'events')).toEqual([]);
  });
});

test.describe('B4b-3 结果层：电脑', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('④ 总结这周的随手记：结果层居中', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL);
    await openToday(page, fake);
    await summarizeFlow(page, fake);
    await shots(page, browserName, '电脑-结果层-总结');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('assist-panel')).toHaveCount(0);
  });
});
