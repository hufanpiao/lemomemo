// R-494 AI 助手第 4 段：设置里的“我的 AI”“AI 服务商”（负责人 11-22 选的方案：管理员页方向二、密钥页照方向一、右边按钮改“保存”）。
// /sb 在浏览器这一层答：ai-provider 按 action 回（服务器这一份状态放在 fake 里，写的动作改它，读的动作照它回）；my_ai_usage 回 12 / 50。
//   ① 管理员：设置首页“更多”卡里有“AI 服务商”、值是对话和整理那家 → 四项用途、四家密钥 → 点“录音转文字”弹层：
//      做不了的变灰点不了 → 对话和整理选 Claude 调 admin_route → OpenAI 密钥页：没试不能保存、试一下没通（写原因）、
//      改了输入结果作废、再试通了 → 保存调 admin_key、写“存好了。”；运行日志、本机存储、地址里都没有密钥和模型名
//   ② 普通人：首页没有“AI 服务商”；“我的 AI”值“柠檬记提供 · 12 / 50” → 默认用柠檬记的 → 选自己的 OpenAI、试通了 →
//      改用前弹切换前提示（只接管对话，剩下三项仍占 50 次）→ 确定调 own_use → 我的密钥一行 → 删除要点两次 → 回到柠檬记的
//   ③ 管理员（负责人 11-23 弹窗；11-25 各自打勾）：联网搜索 Brave / Tavily：Tavily 密钥页只填密钥、试调保存走 admin_web_*；“联网搜索方式”四家各自打勾
// 设了 LEMO_SHOT_DIR 时在 Chromium 上按真机尺寸（430×932、DPR 3）存评审截图（浅色、深色）。跑在快读组（要会话令牌、/sb 地址）
import type { Page } from '@playwright/test';
import { fakeRest } from './fake-rest.ts';
import { readRunLogInPage, shot } from './page-helpers.ts';
import { logOnFail } from './fail-log.ts';
import { expect, seedFakeSession, test } from './session-fixture.ts';

test.setTimeout(120_000);
test.use({ trace: 'off', timezoneId: 'Asia/Seoul', locale: 'zh-CN', viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });

const USER = '0e2e0000-0000-4000-8000-000000000001';
const KEY = 'fake-aaaaaaaa-W9zP';   // 假值（低熵，免得 gitleaks 当真密钥）
const MODEL = 'gpt-5-mini';
type Slot = { model: string | null; last4: string | null; saved_at: number | null; has_key: boolean };
type Own = { provider: string; model: string; last4: string; active: boolean; fell_back: { at: number; why: 'auth' | 'quota' } | null } | null;
type Fake = {
  calls: Record<string, unknown>[];
  admin: boolean;
  project: string;
  own: Own;
  routes: Record<'chat' | 'stt' | 'embed', string | null>;
  web: string[];
  keys: Record<string, Slot>;
  /** 下一次试调的结果（按顺序取，取完都回通了） */
  tests: Record<string, unknown>[];
};

async function fakeServer(page: Page, baseURL: string | undefined, admin: boolean): Promise<Fake> {
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  const now = Date.now();
  const empty: Slot = { model: null, last4: null, saved_at: null, has_key: false };
  const fake: Fake = {
    calls: [], admin, project: 'gemini', own: null,
    // 联网搜索不归四家：admin_get 单独回 web（勾的几家，负责人 11-25 各自打勾；不在 routes 里，独立评审第 9 条），keys 里也带搜索那几家
    routes: { chat: null, stt: null, embed: null },
    web: ['brave'],
    keys: {
      gemini: { model: 'gemini-3-flash', last4: 'x7Qc', saved_at: now, has_key: true },
      claude: { model: 'claude-haiku-5-5', last4: 'K2vQ', saved_at: now, has_key: true },
      openai: empty, deepseek: empty,
      brave: { model: null, last4: 'Br4v', saved_at: now, has_key: true }, tavily: empty, naver: empty,
    },
    tests: [],
  };
  await fakeRest(page, { user: USER, tables: {}, fixed: { my_ai_usage: { ai_used: 12, ai_limit: 50, pacific_date: '2026-11-22', ai_unlimited: admin } } });
  await page.route(/\/sb\/functions\/v1\/ai-provider/, (route) => {
    const b = route.request().postDataJSON() as Record<string, unknown>;
    fake.calls.push(b);
    const key = typeof b['key'] === 'string' ? b['key'] : '';
    switch (b['action']) {
      case 'mine':
        return route.fulfill({ json: { admin: fake.admin, project: fake.project, own: fake.own, images: (fake.own?.provider ?? fake.project) === 'gemini' } });
      case 'admin_get':
        return route.fulfill({ json: { routes: fake.routes, web: fake.web, keys: fake.keys } });
      case 'admin_web_route':
        fake.web = (b['providers'] as unknown[]).map(String);
        return route.fulfill({ json: { ok: true } });
      case 'admin_web_key':
        fake.keys[String(b['provider'])] = { model: null, last4: key.slice(-4), saved_at: Date.now(), has_key: true };
        return route.fulfill({ json: { ok: true } });
      case 'own_test':
      case 'admin_test':
      case 'admin_web_test':
        return route.fulfill({ json: fake.tests.shift() ?? { ok: true, ms: 812 } });
      case 'own_use':
        fake.own = { provider: String(b['provider']), model: String(b['model']), last4: key.slice(-4), active: true, fell_back: null };
        return route.fulfill({ json: { ok: true, own: fake.own } });
      case 'own_delete':
        fake.own = null;
        return route.fulfill({ json: { ok: true } });
      case 'admin_route': {
        const task = b['task'] as keyof Fake['routes'];
        fake.routes[task] = String(b['provider']);
        if (task === 'chat') fake.project = String(b['provider']);
        return route.fulfill({ json: { ok: true } });
      }
      case 'admin_key':
        fake.keys[String(b['provider'])] = { model: String(b['model']), last4: key.slice(-4), saved_at: Date.now(), has_key: true };
        return route.fulfill({ json: { ok: true } });
      default:
        return route.fulfill({ status: 400, json: { error: 'bad_request' } });
    }
  });
  return fake;
}

const runLog = (page: Page) => page.evaluate(readRunLogInPage);
logOnFail(test);

async function shots(page: Page, browserName: string, name: string): Promise<void> {
  await shot(page, browserName, `${name}-浅色`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, browserName, `${name}-深色`);
  await page.emulateMedia({ colorScheme: 'light' });
}

/** 单选的圆点藏起来了（srOnly），像人一样点整行 */
const pick = (page: Page, testId: string) => page.locator('label', { has: page.getByTestId(testId) }).click();

async function openSettings(page: Page): Promise<void> {
  await page.goto('/app/#/settings');
  await expect(page.locator('main[data-feature="settings"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('settings-my-ai-summary')).toHaveText(/^(柠檬记提供 · (12 \/ 50|不限)|自己的密钥 · .+)$/, { timeout: 15_000 });
}

/** 密钥和模型名不进运行日志、本机存储、地址（R-494 负责人：只记动作名、服务商名、结果码、耗时） */
async function noSecrets(page: Page): Promise<void> {
  const log = await runLog(page);
  expect(log).toMatch(/aiprov /);
  expect(log).not.toContain(KEY);
  expect(log).not.toContain(MODEL);
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
  expect(stored).not.toContain(KEY);
  expect(page.url()).not.toContain(KEY);
}

test.describe('R-494 我的 AI、AI 服务商', () => {
  test('① 管理员：AI 服务商四项、选一家、变灰点不了；密钥页没通 → 通了 → 保存', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL, true);
    await openSettings(page);
    // 管理员每天不限次数（my_ai_usage 的 ai_unlimited）
    await expect(page.getByTestId('settings-my-ai-summary')).toHaveText('柠檬记提供 · 不限');
    await expect(page.getByTestId('settings-ai-provider-summary')).toHaveText('Gemini');
    await shots(page, browserName, '设置首页-管理员');
    // “AI 服务商”在“更多”卡里，滚到它再截一张
    await page.getByTestId('settings-ai-provider-entry').scrollIntoViewIfNeeded();
    await shots(page, browserName, '设置首页-管理员-更多卡');

    await page.getByTestId('settings-ai-provider-entry').click();
    await expect(page.getByTestId('aip-admin')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('aip-route-chat-value')).toHaveText('Gemini');
    await expect(page.getByTestId('aip-key-claude-value')).toContainText('K2vQ');
    await expect(page.getByTestId('aip-key-openai-value')).toHaveText('没填');
    await shots(page, browserName, 'AI服务商-四项');

    // 录音转文字：Claude、DeepSeek 没有这项，OpenAI 还没接上 → 变灰点不了
    await page.getByTestId('aip-route-stt').click();
    const stt = page.getByRole('dialog', { name: '录音转文字用哪家' });
    await expect(stt).toBeVisible();
    await expect(page.getByTestId('aip-pick-gemini')).toBeChecked();
    await expect(page.getByTestId('aip-pick-claude')).toBeDisabled();
    await expect(page.getByTestId('aip-pick-openai')).toBeDisabled();
    await expect(page.getByTestId('aip-pick-deepseek')).toBeDisabled();
    await expect(stt).toContainText('没有这项');
    await expect(stt).toContainText('还没接上');
    await shots(page, browserName, '选一家弹层-录音转文字');
    // 变灰的那行点了也不发（弹层还在滑入时整行在视口外，force 点 WebKit 会报“在视口外”，直接往圆点上派一下点击）
    await page.getByTestId('aip-pick-claude').dispatchEvent('click');
    expect(fake.calls.filter((c) => c['action'] === 'admin_route')).toHaveLength(0);
    await page.keyboard.press('Escape');
    await expect(stt).toHaveCount(0);

    // 对话和整理选 Claude（已填密钥 · 试通过）
    await page.getByTestId('aip-route-chat').click();
    const chat = page.getByRole('dialog', { name: '对话和整理用哪家' });
    await expect(chat).toContainText('已填密钥 · 试通过');
    await expect(chat).toContainText('还没填密钥');
    await shots(page, browserName, '选一家弹层-对话和整理');
    await pick(page, 'aip-pick-claude');
    await expect(chat).toHaveCount(0, { timeout: 10_000 });
    expect(fake.calls.filter((c) => c['action'] === 'admin_route')).toEqual([{ action: 'admin_route', task: 'chat', provider: 'claude' }]);
    await expect(page.getByTestId('aip-route-chat-value')).toHaveText('Claude', { timeout: 10_000 });

    // OpenAI 密钥页：没试不能保存 → 试一下没通 → 改输入作废 → 再试通了 → 保存
    await page.getByTestId('aip-key-openai').click();
    await expect(page.getByTestId('aip-keypage')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('aip-save')).toBeDisabled();
    await expect(page.getByTestId('aip-test')).toBeDisabled();
    await page.getByTestId('aip-model').fill(MODEL);
    await page.getByTestId('aip-key').fill(`${KEY}x`);
    await expect(page.getByTestId('aip-key')).toHaveAttribute('type', 'password');
    fake.tests.push({ ok: false, code: 'auth', status: 401 });
    await page.getByTestId('aip-test').click();
    await expect(page.getByTestId('aip-test-fail')).toContainText('没通：密钥不对', { timeout: 10_000 });
    await expect(page.getByTestId('aip-save')).toBeDisabled();
    await shots(page, browserName, '密钥详情-没通');
    await page.getByTestId('aip-key').fill(KEY);
    await expect(page.getByTestId('aip-test-fail')).toHaveCount(0);
    await page.getByTestId('aip-test').click();
    await expect(page.getByTestId('aip-test-ok')).toContainText('OpenAI 回话用了 0.8 秒', { timeout: 10_000 });
    await expect(page.getByTestId('aip-save')).toBeEnabled();
    await shots(page, browserName, '密钥详情-通了');
    await page.getByTestId('aip-save').click();
    await expect(page.getByTestId('aip-saved')).toHaveText('存好了。', { timeout: 10_000 });
    expect(fake.calls.filter((c) => c['action'] === 'admin_key')).toEqual([{ action: 'admin_key', provider: 'openai', model: MODEL, key: KEY }]);
    await noSecrets(page);
    // 返回 AI 服务商：OpenAI 那一行写后四位
    await page.getByTestId('settings-aikey-back').click();
    await expect(page.getByTestId('aip-key-openai-value')).toContainText('W9zP', { timeout: 10_000 });
  });

  // 负责人 11-23 弹窗第 1 项：联网改用 Brave / Tavily。密钥页只有密钥一栏（没有模型名），试调走 admin_web_test、保存走 admin_web_key；
  // 11-25 负责人：“每个服务商后面可以单独打勾来框选，选几个就用几个”：联网那一行四家各自打勾，勾了发 admin_web_route {providers}
  test('③ 管理员：联网搜索 Brave / Tavily：Tavily 密钥页没有模型名、试通了保存；联网再勾上 Tavily', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL, true);
    await openSettings(page);
    await page.getByTestId('settings-ai-provider-entry').click();
    await expect(page.getByTestId('aip-admin')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('aip-route-web-value')).toContainText('Brave');
    await expect(page.getByTestId('aip-key-brave-value')).toContainText('Br4v');
    await expect(page.getByTestId('aip-key-tavily-value')).toHaveText('没填');

    await page.getByTestId('aip-key-tavily').click();
    await expect(page.getByTestId('aip-keypage')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('aip-model')).toHaveCount(0);
    await expect(page.getByTestId('aip-test')).toBeDisabled();
    await page.getByTestId('aip-key').fill(KEY);
    await page.getByTestId('aip-test').click();
    await expect(page.getByTestId('aip-test-ok')).toBeVisible({ timeout: 10_000 });
    await shots(page, browserName, '密钥详情-Tavily-通了');
    await page.getByTestId('aip-save').click();
    await expect(page.getByTestId('aip-saved')).toHaveText('存好了。', { timeout: 10_000 });
    expect(fake.calls.filter((c) => c['action'] === 'admin_web_test')).toEqual([{ action: 'admin_web_test', provider: 'tavily', key: KEY }]);
    expect(fake.calls.filter((c) => c['action'] === 'admin_web_key')).toEqual([{ action: 'admin_web_key', provider: 'tavily', key: KEY }]);
    expect(fake.calls.filter((c) => c['action'] === 'admin_key' || c['action'] === 'admin_test')).toHaveLength(0);
    await page.getByTestId('settings-aikey-back').click();
    await expect(page.getByTestId('aip-key-tavily-value')).toContainText('W9zP', { timeout: 10_000 });

    await page.getByTestId('aip-route-web').click();
    // 11-25 弹窗：四家各自打勾（没有三家联合那一行），勾几家用几家；至少勾一家
    const web = page.getByRole('dialog', { name: '联网搜索方式' });
    await expect(web).toBeVisible();
    await expect(web.getByRole('checkbox')).toHaveCount(4);
    await expect(page.getByTestId('aip-pick-brave')).toBeChecked();
    await expect(page.getByTestId('aip-pick-multi')).toHaveCount(0);
    await expect(page.getByTestId('aip-pick-naver')).toBeDisabled();
    await expect(page.getByTestId('aip-pick-gemini')).toHaveCount(0);
    await shots(page, browserName, '选一家弹层-联网搜索');
    // 只剩一个勾（Brave）时点它没反应
    await pick(page, 'aip-pick-brave');
    await expect(page.getByTestId('aip-pick-brave')).toBeChecked();
    // 勾上 Tavily：发勾的两家，弹层不关，两个都勾着
    await pick(page, 'aip-pick-tavily');
    await expect(page.getByTestId('aip-pick-tavily')).toBeChecked({ timeout: 10_000 });
    await expect(page.getByTestId('aip-pick-brave')).toBeChecked();
    await expect(web).toBeVisible();
    expect(fake.calls.filter((c) => c['action'] === 'admin_web_route')).toEqual([{ action: 'admin_web_route', providers: ['brave', 'tavily'] }]);
    expect(fake.calls.filter((c) => c['action'] === 'admin_route')).toHaveLength(0);
    await shots(page, browserName, '联网搜索-勾了两家');
    await page.keyboard.press('Escape');
    await expect(web).toHaveCount(0);
    await expect(page.getByTestId('aip-route-web-value')).toHaveText('Brave + Tavily', { timeout: 10_000 });
    await shots(page, browserName, 'AI服务商-联网勾了两家');
    await noSecrets(page);
  });

  test('② 普通人：没有 AI 服务商；我的 AI 默认 → 自己的密钥（切换前提示）→ 删除要点两次', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL, false);
    await openSettings(page);
    await expect(page.getByTestId('settings-my-ai-summary')).toHaveText('柠檬记提供 · 12 / 50');
    await expect(page.getByTestId('settings-ai-provider-entry')).toHaveCount(0);
    expect(fake.calls.filter((c) => c['action'] === 'admin_get')).toHaveLength(0);

    await page.getByTestId('settings-my-ai-entry').click();
    await expect(page.getByTestId('aip-my')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('aip-my-lemo')).toBeChecked();
    await expect(page.getByTestId('aip-my-project')).toHaveText('柠檬记现在用的是 Gemini（谷歌）。');
    // 清零写“下午 5 点”（负责人 11-23；首尔 = 太平洋午夜，夏令时 16 点、冬令时 17 点）
    await expect(page.getByTestId('aip-my-pick')).toContainText(/今天用了 12 \/ 50 次，下午 [45] 点清零/);
    await shots(page, browserName, '我的AI-默认');

    await pick(page, 'aip-my-own');
    await pick(page, 'aip-own-openai');
    await expect(page.getByTestId('aip-use')).toBeDisabled();
    await page.getByTestId('aip-model').fill(MODEL);
    await page.getByTestId('aip-key').fill(KEY);
    await page.getByTestId('aip-test').click();
    await expect(page.getByTestId('aip-test-ok')).toBeVisible({ timeout: 10_000 });
    await shots(page, browserName, '我的AI-填好试通了');
    await page.getByTestId('aip-use').click();
    const ask = page.getByTestId('aip-ask');
    await expect(ask).toBeVisible();
    await expect(page.getByTestId('aip-ask-covers')).toHaveText('对话、整理随手记时，你的文字会发到 OpenAI，按它的规定处理；');
    await expect(page.getByTestId('aip-ask-rest')).toHaveText('联网、录音转文字、搜索仍由柠檬记的 AI 做，照旧占每天 50 次；');
    await shots(page, browserName, '切换前提示');
    await page.getByTestId('aip-ask-ok').click();
    await expect(page.getByTestId('aip-mine-meta')).toContainText('W9zP', { timeout: 10_000 });
    expect(fake.calls.filter((c) => c['action'] === 'own_use')).toEqual([{ action: 'own_use', provider: 'openai', model: MODEL, key: KEY }]);
    await expect(page.getByTestId('aip-key')).toHaveCount(0);
    await shots(page, browserName, '我的AI-自己的密钥');

    // 再问一次是 kit 的通用确认框（负责人 11-25“14、15 都改成一样”），按钮 aip-del-ask-cancel / aip-del-ask-ok
    await page.getByTestId('aip-del').click();
    await expect(page.getByRole('dialog')).toContainText('删掉这把密钥？');
    await expect(page.getByTestId('aip-del-ask-cancel')).toHaveText('不删');
    expect(fake.calls.filter((c) => c['action'] === 'own_delete')).toHaveLength(0);
    await shots(page, browserName, '删除确认');
    await page.getByTestId('aip-del-ask-ok').click();
    await expect(page.getByTestId('aip-my-lemo')).toBeChecked({ timeout: 10_000 });
    expect(fake.calls.filter((c) => c['action'] === 'own_delete')).toHaveLength(1);
    await noSecrets(page);
  });
});
