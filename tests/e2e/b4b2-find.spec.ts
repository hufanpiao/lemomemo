// B4b-2 智能查找（线框 s12“查找（经＋）”、sFind“关键词先出，意思相近随后补上”、sPlus“点按＋打字：预览先显示查找”；架构 5.13 第 6 点、5.14 第 1 点）。
// /sb 在浏览器这一层答：几条日程、待办、随手记、文档（含一条隐私记），note-search 按用例回 hits 或 fallback。
//   ① 电脑（1280 宽）：Ctrl+K 打开居中面板 → 打“牙医”关键词当场出（隐私记不出）→ 停一下意思相近补上一组 → 右栏预览 → Enter 打开日程编辑页；
//     运行日志有 find open / kw / sem / pick，没有查询文字；
//   ② 手机（390 宽）：点“＋”打“查一下 牙医” → 打字条出“看起来是要查找 · Enter 查找”和“找：牙医” → Enter 打开整屏查找面板，输入框里是“牙医”；
//     点“找：…”改成记下 → 按钮回到“记下”；
//   ③ 只按关键词：AI 关着（consent，带“去打开”）、离线（offline）、服务器 quota；④ 没有结果：“没找到”；
//   ⑤ 设了 LEMO_SHOT_DIR 时在 Chromium 上存评审截图（手机 390×844、电脑 1280×800，浅色、深色），断言两种浏览器都跑。
// 跑在快读组（playwright.fastread.config.ts）：note-search 要会话令牌，默认组的构建没配 supabase 地址。
import type { Page } from '@playwright/test';
import { FADE_GUARD_MS } from '../../src/motion/index.ts';
import { expect, seedFakeSession, test } from './session-fixture.ts';

test.skip(!process.env['VITE_PUBLIC_SUPABASE_URL'], '要会话令牌和 /sb 地址，只在快读组跑（npm run e2e:fastread）');
test.setTimeout(120_000);
test.use({ trace: 'off', timezoneId: 'Asia/Seoul', locale: 'zh-CN' });

const SHOT_DIR = process.env['LEMO_SHOT_DIR'];
const USER = '0e2e0000-0000-4000-8000-000000000001';
const id = (n: number) => `0e2e0000-0000-4000-8000-0000000b4b${String(n).padStart(2, '0')}`;
const EV = id(21);
const TD = id(22);
const NT = id(23);
const VN = id(24);
const FL = id(25);
const V = '2026-10-29';

type Opts = { ai?: boolean; sem?: 'hits' | 'quota' | 'none' };
type Fake = { searches: unknown[] };

async function fakeServer(page: Page, baseURL: string | undefined, o: Opts = {}): Promise<Fake> {
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  const now = Date.now();
  const at = new Date(now).toISOString();
  const c = { user_id: USER, created_at: now, updated_at: now, deleted_at: null, undone: false, rev: 1, synced_at: at };
  const item = { project: '', source: 'page', raw_text: '', short: null, short_by: null, push_show_title: null, batch_id: null, notified_for: null, snooze_at: null };
  const day = new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
  const tables: Record<string, Record<string, unknown>[]> = {
    // 日程、待办要带齐必填列（shared/schema/rows-read.ts 的 requiredColsOf，缺了宽容读取当坏行丢掉）
    events: [{ id: EV, ...c, ...item, title: '看牙医', date: day, time: '15:00', tz: 'Asia/Seoul', duration_min: 60, location: '江南站 3 号口', note: '带医保卡', remind_min: null, remind_days: null }],
    todos: [{ id: TD, ...c, ...item, title: '预约洗牙', note: '', project: '健康', due: null, done: false, important: false, from_note_id: null, from_anniv_id: null, done_at: 0, remind_days: null, remind_time: '09:00', due_time: null, remind_before_min: null }],
    notes: [
      { id: NT, ...c, title: '拉面店', body: '弘大那家拉面店，汤头很浓。', is_private: false, category_id: null, category_source: 'none', category_seen: true, tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null },
      { id: VN, ...c, title: '牙医收据', body: '隐私记', is_private: true, category_id: null, category_source: 'none', category_seen: true, tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null },
    ],
    note_files: [{ id: FL, ...c, note_id: NT, kind: 'pdf', path: `${USER}/${NT}/${FL}.pdf`, has_thumb: false, is_vault: false, name: '收据.pdf', mime: 'application/pdf', bytes: 1000, sha256: 'a'.repeat(64), pages: 1, text_excerpt: '牙科 治疗费 3 万韩元', check_status: 'ok', etag: null }],
    settings: [{ id: id(30), ...c, key: 'ai.enabled', value: o.ai ?? true }],
  };
  await page.route(/\/sb\/rest\/v1\//, (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const name = u.pathname.split('/').pop() ?? '';
    if (req.method() !== 'GET') return route.fulfill({ status: 201, json: [{ rev: 1 }] });
    if (tables[name]) return route.fulfill({ json: tables[name] });
    if (name === 'profiles') return route.fulfill({ json: [{ user_id: USER, consent_policy_ver: V, consent_ai_at: at }] });
    if (name === 'app_config' && u.searchParams.get('select') === 'notice') return route.fulfill({ json: [{ notice: { policy_ver: V, min_consent_ver: V } }] });
    return route.fulfill({ json: [] });
  });
  const fake: Fake = { searches: [] };
  await page.route(/\/sb\/functions\/v1\/note-search/, (route) => {
    fake.searches.push(route.request().postDataJSON());
    const s = o.sem ?? 'hits';
    if (s === 'quota') return route.fulfill({ json: { fallback: 'quota' } });
    if (s === 'none') return route.fulfill({ json: { hits: [] } });
    // 意思相近：洗牙那条（关键词“牙医”找不到）、隐私记那条（本机不显示）、本机没有的一条（丢掉）
    return route.fulfill({ json: { hits: [{ kind: 'todo', id: TD, score: 0.81 }, { kind: 'note', id: VN, score: 0.9 }, { kind: 'event', id: id(99), score: 0.7 }] } });
  });
  return fake;
}

const runLog = (page: Page) => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');
const rows = (page: Page) => page.getByTestId('find-row');

async function shot(page: Page, browserName: string, name: string): Promise<void> {
  if (browserName !== 'chromium' || !SHOT_DIR) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, animations: 'disabled' });
}

async function openToday(page: Page): Promise<void> {
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(FADE_GUARD_MS);
}

/** Ctrl+K：查找那一块在首屏画完以后才下载，没好之前按了不响应，按到面板出来为止 */
async function ctrlK(page: Page): Promise<void> {
  await expect(async () => {
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('find-panel')).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

async function typeBarFind(page: Page, text: string): Promise<void> {
  await page.getByTestId('tabbar-add').click();
  await expect(page.getByTestId('type-input')).toBeFocused({ timeout: 10_000 });
  await page.getByTestId('type-input').fill(text);
}

test.describe('B4b-2 查找：电脑', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('Ctrl+K → 关键词先出、意思相近补上、隐私记不出、右栏预览、Enter 打开；日志不带查询文字', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL);
    await openToday(page);
    await ctrlK(page);
    await shot(page, browserName, '电脑-浅色-s12-空白');
    await page.getByTestId('find-input').fill('牙医');
    await expect(rows(page).first()).toHaveAttribute('data-kind', 'event');
    await expect(page.getByTestId('find-group-sem')).toBeVisible();
    await expect(page.getByTestId('find-group-sem').locator('[data-testid="find-row"]')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId('find-group-sem').getByTestId('find-row')).toHaveAttribute('data-kind', 'todo');
    expect(fake.searches).toEqual([{ q: '牙医', scope: 'main' }]);
    await expect(page.getByTestId('find-panel')).not.toContainText('牙医收据');
    await expect(page.getByTestId('find-preview-item')).toContainText('江南站 3 号口');
    await shot(page, browserName, '电脑-浅色-sFind-结果');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, browserName, '电脑-深色-sFind-结果');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByTestId('find-input').press('Enter');
    await expect(page.getByTestId('find-panel')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`#/event/${EV}`));
    // 运行日志攒一会儿才写进 localStorage（platform/run-log.ts），等 pick 那行落盘再整体核
    await expect.poll(() => runLog(page), { timeout: 10_000 }).toMatch(/find pick kind=event/);
    const log = await runLog(page);
    expect(log).toMatch(/find open from=ctrlk len=0/);
    expect(log).toMatch(/find kw len=2 n=\d+ ms=\d+/);
    expect(log).toMatch(/find sem n=3 ms=\d+/);
    expect(log).toMatch(/find sem add=1 top=0/);
    expect(log).toMatch(/find pick kind=event/);
    expect(log).not.toContain('牙医');
  });

  test('AI 关着：只按关键词、写原因带“去打开”，不调服务器', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL, { ai: false });
    await openToday(page);
    await ctrlK(page);
    await page.getByTestId('find-input').fill('牙医');
    await expect(page.getByTestId('find-fallback')).toHaveAttribute('data-reason', 'consent');
    await expect(page.getByTestId('find-fallback')).toContainText('现在只按关键词找');
    // “牙医”只中日程那条（文档文字是“牙科”）
    await expect(rows(page)).toHaveCount(1);
    await shot(page, browserName, '电脑-浅色-AI关');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, browserName, '电脑-深色-AI关');
    expect(fake.searches).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('find-panel')).toHaveCount(0);
  });

  test('离线、没有结果', async ({ page, baseURL, browserName }) => {
    await fakeServer(page, baseURL, { sem: 'none' });
    await openToday(page);
    await ctrlK(page);
    await page.getByTestId('find-input').fill('不存在的词');
    await expect(page.getByTestId('find-empty')).toContainText('不存在的词', { timeout: 10_000 });
    await shot(page, browserName, '电脑-浅色-无结果');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, browserName, '电脑-深色-无结果');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.context().setOffline(true);
    await page.getByTestId('find-input').fill('牙医');
    await expect(page.getByTestId('find-fallback')).toHaveAttribute('data-reason', 'offline');
    await shot(page, browserName, '电脑-浅色-离线');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, browserName, '电脑-深色-离线');
    await page.context().setOffline(false);
  });
});

test.describe('B4b-2 查找：手机', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('“＋”打“查一下 牙医”→ 看起来是要查找 → Enter 打开整屏面板；点“找：…”改成记下', async ({ page, baseURL, browserName }) => {
    await fakeServer(page, baseURL);
    await openToday(page);
    await typeBarFind(page, '查一下 牙医');
    await expect(page.getByTestId('type-find-head')).toHaveText('看起来是要查找 · Enter 查找');
    await expect(page.getByTestId('type-find')).toContainText('找：牙医');
    await shot(page, browserName, '手机-浅色-sPlus-打字条查找');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, browserName, '手机-深色-sPlus-打字条查找');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByTestId('type-find').click();
    await expect(page.getByTestId('type-find')).toHaveCount(0);
    await expect(page.getByTestId('type-bar').getByRole('button', { name: '记下' })).toBeVisible();
    // 改了字重新判断（asRecord 跟着重置）；同一句再 fill 不触发改动，所以先清空
    await page.getByTestId('type-input').fill('');
    await page.getByTestId('type-input').fill('查一下 牙医');
    await expect(page.getByTestId('type-find')).toBeVisible();
    await page.getByTestId('type-input').press('Enter');
    await expect(page.getByTestId('find-panel')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('find-input')).toHaveValue('牙医');
    await expect(page.getByTestId('type-bar')).toHaveCount(0);
    await expect(page.getByTestId('find-group-sem').getByTestId('find-row')).toHaveCount(1, { timeout: 10_000 });
    await shot(page, browserName, '手机-浅色-sFind-结果');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, browserName, '手机-深色-sFind-结果');
    await page.getByTestId('find-close').click();
    await expect(page.getByTestId('find-panel')).toHaveCount(0);
    await expect.poll(() => runLog(page), { timeout: 10_000 }).toMatch(/typebar find len=2/);
  });

  test('手机：AI 关、离线、服务器额度用完、无结果', async ({ page, baseURL, browserName }) => {
    await fakeServer(page, baseURL, { ai: false });
    await openToday(page);
    await typeBarFind(page, '查一下 牙医');
    await page.getByTestId('type-input').press('Enter');
    await expect(page.getByTestId('find-fallback')).toHaveAttribute('data-reason', 'consent');
    await shot(page, browserName, '手机-浅色-AI关');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, browserName, '手机-深色-AI关');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.context().setOffline(true);
    await page.getByTestId('find-input').fill('牙');
    await page.getByTestId('find-input').fill('牙医');
    await expect(page.getByTestId('find-fallback')).toHaveAttribute('data-reason', 'offline');
    await shot(page, browserName, '手机-浅色-离线');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, browserName, '手机-深色-离线');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByTestId('find-input').fill('不存在的词');
    await expect(page.getByTestId('find-empty')).toBeVisible();
    await shot(page, browserName, '手机-浅色-无结果');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, browserName, '手机-深色-无结果');
    await page.context().setOffline(false);
  });

  test('服务器说今天次数用完：quota 原因', async ({ page, baseURL }) => {
    await fakeServer(page, baseURL, { sem: 'quota' });
    await openToday(page);
    await typeBarFind(page, '查一下 牙医');
    await page.getByTestId('type-input').press('Enter');
    await expect(page.getByTestId('find-fallback')).toHaveAttribute('data-reason', 'quota', { timeout: 10_000 });
    await expect(rows(page).first()).toHaveAttribute('data-kind', 'event');
  });
});
