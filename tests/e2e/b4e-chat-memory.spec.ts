// R-495 AI 助手第 3 段：长期记忆“记住的事”和按住说话提问。/sb 在浏览器这一层答，不碰真的 AI 服务商。
//   ① 回答下出“AI 记住了”→ 查看 → 列表里有这条 → 删除、撤销 → 返回；提示条删掉后变“已删掉”
//   ② 全部清空要点两次，真删、没有撤销
//   ③ 按住麦克风说话 → ai-voice 只转写（X-Want: transcript）→ 转出来的字作为一句提问发给 ai-chat；运行日志不带原话
// 设了 LEMO_SHOT_DIR 时在 Chromium 上按真机尺寸（430×932、DPR 3）存对照截图（浅色、深色）。跑在快读组
import type { Page } from '@playwright/test';
import { fakeMedia, runLog } from './fake-media.ts';
import { fakeRest } from './fake-rest.ts';
import { afterPageFade, shot } from './page-helpers.ts';
import { logOnFail } from './fail-log.ts';
import { expect, seedFakeSession, test } from './session-fixture.ts';

test.setTimeout(120_000);
test.use({ trace: 'off', timezoneId: 'Asia/Seoul', locale: 'zh-CN', viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, permissions: [] });
logOnFail(test);

const USER = '0e2e0000-0000-4000-8000-000000000001';
const M1 = '0e2e0000-0000-4000-8000-0000000b4e01';
const M2 = '0e2e0000-0000-4000-8000-0000000b4e02';
const NEW_TEXT = '对花生过敏，推荐吃的要避开';
const OLD_TEXT = '周报每周五交给产品组';
const ASK = '我对花生过敏，以后推荐吃的帮我避开';
const SPOKEN = '明天几点开会';
const REWRITE = '周报改成每周四交给产品组';

type Fake = { chats: { messages: { text: string }[]; memory?: boolean }[]; voices: (string | null)[]; ops: string[]; pulled: Set<string> };

async function fakeServer(page: Page, baseURL: string | undefined, extra = 0): Promise<Fake> {
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  const now = Date.now();
  const at = new Date(now).toISOString();
  const c = { user_id: USER, created_at: now, updated_at: now, deleted_at: null, undone: false, rev: 1, synced_at: at };
  const rest = await fakeRest(page, {
    user: USER,
    tables: { settings: [{ id: '0e2e0000-0000-4000-8000-0000000b4e50', ...c, key: 'ai.enabled', value: true }] },
    profile: { consent_ai_at: at },
    writeRev: 2,
    fixed: { my_ai_usage: { ai_used: 19, ai_limit: 50, pacific_date: '2026-11-22', ai_unlimited: false } },
  });
  const fake: Fake = { chats: [], voices: [], ops: [], pulled: rest.pulled };
  let items = [{ id: M1, text: NEW_TEXT, at: now }, { id: M2, text: OLD_TEXT, at: now - 86_400_000 },
    ...Array.from({ length: extra }, (_, i) => ({ id: `0e2e0000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, text: `旧记忆 ${i + 1}`, at: now - 86_400_000 * 2 - i }))];
  const removed = new Map<string, (typeof items)[number]>();
  await page.route(/\/sb\/functions\/v1\/ai-chat/, (route) => {
    const body = route.request().postDataJSON() as Fake['chats'][number];
    fake.chats.push(body);
    const said = body.messages.at(-1)?.text;
    return route.fulfill({
      json: { answer: '好的，之后推荐吃的会避开花生。', refs: [], searched: [], found: 0, quota_left: 31, ...(said === ASK ? { memories: [{ id: M1, text: NEW_TEXT }] } : {}), ...(said === REWRITE ? { memories: [{ id: M1, text: '周报每周四交给产品组', replaced: { id: M2, text: OLD_TEXT } }] } : {}) },
    });
  });
  await page.route(/\/sb\/functions\/v1\/ai-memory/, (route) => {
    const b = route.request().postDataJSON() as { action: string; id?: string; cursor?: string };
    fake.ops.push(b.action);
    if (b.action === 'list') {
      const from = b.cursor ? items.findIndex((m) => m.id === b.cursor?.split('.')[1]) + 1 : 0;
      const part = items.slice(from, from + 50);
      const last = part.at(-1);
      return route.fulfill({ json: { items: part, next: from + 50 < items.length && last ? `${last.at}.${last.id}` : null, total: items.length } });
    }
    if (b.action === 'delete') {
      const hit = items.find((m) => m.id === b.id);
      if (hit) removed.set(hit.id, hit);
      items = items.filter((m) => m.id !== b.id);
    }
    if (b.action === 'undo') {
      const back = removed.get(b.id ?? '');
      if (back) items = [...items, back].sort((x, y) => y.at - x.at);
    }
    if (b.action === 'clear') items = [];
    return route.fulfill({ json: { ok: true } });
  });
  await page.route(/\/sb\/functions\/v1\/ai-voice/, (route) => {
    fake.voices.push(route.request().headers()['x-want'] ?? null);
    return route.fulfill({ json: { transcript: SPOKEN, quota_left: 31 } });
  });
  await page.route(/\/sb\/functions\/v1\/ai-parse/, (route) => route.fulfill({ json: { fallback: true, reason: 'error' } }));
  await page.route(/\/sb\/functions\/v1\/ai-provider/, (route) => route.fulfill({ json: { admin: false, project: 'gemini', own: null, images: true } }));
  return fake;
}

async function openChat(page: Page, fake: Fake, ask: string): Promise<void> {
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => ['settings', 'profiles'].filter((t) => !fake.pulled.has(t)), { timeout: 20_000 }).toEqual([]);
  await afterPageFade(page);
  await page.getByTestId('tabbar-add').click();
  await expect(page.getByTestId('type-input')).toBeFocused({ timeout: 10_000 });
  await page.getByTestId('type-input').fill(ask);
  await page.getByTestId('type-ask-ai').click();
  await expect(page.getByTestId('chat-sheet')).toBeVisible({ timeout: 10_000 });
}

async function shots(page: Page, browserName: string, name: string): Promise<void> {
  await shot(page, browserName, `${name}-浅色`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, browserName, `${name}-深色`);
  await page.emulateMedia({ colorScheme: 'light' });
}

test.describe('R-495 记住的事', () => {
  test('① 提示条 → 查看 → 删除、撤销 → 返回；提示条删掉变“已删掉”', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL);
    await openChat(page, fake, ASK);
    const pill = page.getByTestId('chat-memo');
    await expect(pill).toContainText(NEW_TEXT, { timeout: 10_000 });
    expect(fake.chats[0]?.memory).toBe(true);
    await shots(page, browserName, '对话-记住了');

    await page.getByTestId('chat-memo-view').click();
    const rows = page.getByTestId('chat-mem-row');
    await expect(rows).toHaveCount(2, { timeout: 10_000 });
    await expect(rows.first()).toContainText(NEW_TEXT);
    await expect(rows.first()).toContainText('来自对话');
    // 方案是整屏渐变底，不是抽屉里的纯色底
    const memPage = page.getByTestId('chat-mem-page');
    expect(await memPage.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, grad: getComputedStyle(el).backgroundImage.includes('radial-gradient') };
    })).toEqual({ x: 0, y: 0, w: 430, h: 932, grad: true });
    await expect(page.getByTestId('chat-mem-back')).toBeFocused();
    // 截对照图时补上方案里 54pt 的状态栏高度（浏览器没有安全区）
    if (process.env['LEMO_SHOT_DIR']) await page.evaluate(() => document.documentElement.style.setProperty('--inset-top', '54px'));
    await shots(page, browserName, '记住的事');
    await page.keyboard.press('Escape');
    await expect(memPage).toHaveCount(0);
    await expect(page.getByTestId('chat-sheet')).toBeVisible();
    await page.getByTestId('chat-memo-view').click();
    await expect(rows).toHaveCount(2, { timeout: 10_000 });

    await rows.first().getByRole('button').click();
    await expect(rows).toHaveCount(1);
    const toast = page.getByTestId('chat-mem-toast');
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: '撤销' }).click();
    await expect(rows).toHaveCount(2);
    expect(fake.ops.filter((o) => o !== 'list')).toEqual(['delete', 'undo']);

    await page.getByTestId('chat-mem-back').click();
    await expect(page.getByTestId('chat-mem-page')).toHaveCount(0);
    await page.getByTestId('chat-memo-del').click();
    await expect(pill).toContainText('已删掉');
  });

  test('④ 120 条：先出一页，滚到底接着读完；全部清空写总数', async ({ page, baseURL }) => {
    const fake = await fakeServer(page, baseURL, 118);
    await openChat(page, fake, ASK);
    await expect(page.getByTestId('chat-memo')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('chat-mem-open').click();
    const rows = page.getByTestId('chat-mem-row');
    await expect(rows).toHaveCount(50, { timeout: 10_000 });
    await expect.poll(async () => {
      await rows.last().scrollIntoViewIfNeeded();
      return rows.count();
    }, { timeout: 15_000 }).toBe(120);
    expect(fake.ops.filter((o) => o === 'list')).toHaveLength(3);
    const clear = page.getByTestId('chat-mem-clear');
    await clear.click();
    await expect(clear).toContainText('120');
  });

  test('⑤ 改写：提示条写“已改写：旧 → 新”，撤销后写“已改回：旧”', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL);
    await openChat(page, fake, REWRITE);
    const pill = page.getByTestId('chat-memo');
    await expect(pill).toContainText(`已改写：${OLD_TEXT} → 周报每周四交给产品组`, { timeout: 10_000 });
    await expect(page.getByTestId('chat-memo-del')).toHaveCount(0);
    await shots(page, browserName, '对话-已改写');
    await page.getByTestId('chat-memo-undo').click();
    await expect(pill).toContainText(`已改回：${OLD_TEXT}`);
    expect(fake.ops).toContain('undo');
    await shots(page, browserName, '对话-已改回');
  });

  test('⑥ 全部清空点一次后几秒没再点就复位', async ({ page, baseURL }) => {
    const fake = await fakeServer(page, baseURL);
    await openChat(page, fake, ASK);
    await expect(page.getByTestId('chat-memo')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('chat-mem-open').click();
    await expect(page.getByTestId('chat-mem-row')).toHaveCount(2, { timeout: 10_000 });
    const clear = page.getByTestId('chat-mem-clear');
    await clear.click();
    await expect(clear).toContainText('再点一次');
    await expect(clear).toHaveText('全部清空', { timeout: 6_000 });
    expect(fake.ops).not.toContain('clear');
  });

  test('② 全部清空要点两次，清完没有撤销', async ({ page, baseURL }) => {
    const fake = await fakeServer(page, baseURL);
    await openChat(page, fake, ASK);
    await expect(page.getByTestId('chat-memo')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('chat-mem-open').click();
    await expect(page.getByTestId('chat-mem-row')).toHaveCount(2, { timeout: 10_000 });
    const clear = page.getByTestId('chat-mem-clear');
    await clear.click();
    await expect(clear).toContainText('再点一次');
    expect(fake.ops).not.toContain('clear');
    await clear.click();
    await expect(page.getByTestId('chat-mem-row')).toHaveCount(0);
    expect(fake.ops).toContain('clear');
    await expect(page.getByTestId('chat-mem-toast')).toHaveCount(0);
  });
});

test.describe('R-495 语音提问', () => {
  // 语音只在手机上给（网页版、电脑版不画麦克风）：按触屏手机跑
  test.use({ hasTouch: true, isMobile: true });
  test('③ 按住说话 → 只转写 → 转出来的字发给 AI；日志不带原话', async ({ page, baseURL }) => {
    await fakeMedia(page, { mime: 'audio/mp4' });
    const fake = await fakeServer(page, baseURL);
    await openChat(page, fake, '第一句');
    await expect.poll(() => fake.chats.length, { timeout: 10_000 }).toBe(1);
    const mic = page.getByTestId('chat-mic');
    await expect(mic).toBeVisible({ timeout: 10_000 });
    await mic.hover();   // hover 会等抽屉滑完、位置稳定；先量坐标会量到滑行途中
    await page.mouse.down();
    await expect(mic).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(600);
    await page.mouse.up();
    await expect.poll(() => fake.voices, { timeout: 10_000 }).toEqual(['transcript']);
    await expect.poll(() => fake.chats.length, { timeout: 10_000 }).toBe(2);
    expect(fake.chats[1]?.messages.at(-1)?.text).toBe(SPOKEN);
    await expect(page.getByTestId('chat-me').last()).toHaveText(SPOKEN);
    expect(JSON.stringify(await runLog(page))).not.toContain(SPOKEN);
  });
});
