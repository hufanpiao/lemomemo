// R-492 AI 助手第 1 段：“＋”打字后点“问 AI”进半屏抽屉（负责人 11-22 选的方案页方向 B、入口丙）。
// /sb 在浏览器这一层答：三条待办、一条日程、一条随手记；ai-chat 按用例回（回答带 [1]～[5]、refs 五条）。
//   ① 手机：打一句 → 工具行“问 AI” → 抽屉半屏：我的气泡、“查了你的…· 找到 5 条”、角标、依据只列 3 条 +“还有 2 条”；
//      请求只带这一句（user）、scope main；拖把手往上 → 拉满：五条全列、“这次用了 1 次 AI · 今天 19 / 50”；
//      点第 1 条 → 贴底弹层（类型、标题、“今天 18:00 截止”）→“打开原条目”→ 抽屉关掉、进那条待办；运行日志只记字数不记原话
//   ② 用完：ai-chat 回 quota_out → 用完卡（去下拉搜索、改成记下）、输入条变灰写“明天 … 以后再问”；“改成记下”按本机规则存成一条
//   ③ 点后面的模糊层 → 抽屉滑下去关掉，回到页面
//   ⑥ 第 2 段联网：网页来源两条 + 日程一条同一套编号、小字“联网查了 2 个网页 · 用了你的 1 条日程”、点网页行新窗口开原网址
//   ⑦ 负责人 11-23 弹窗：输入条“＋”选图 → 小图一排、点一下移除 → 随下一句发 webp，答上来才清空
//   ⑧ 带图发送失败：图留着；⑨ 对话那家不收图（ai-provider 的 mine 回 images: false）：不画“＋”、输入条左边距 20（独立评审第 4 条）
// 设了 LEMO_SHOT_DIR 时在 Chromium 上按真机尺寸（430×932、DPR 3）存评审截图（浅色、深色）。跑在快读组（要会话令牌、/sb 地址）
import type { Page } from '@playwright/test';
import { fakeRest } from './fake-rest.ts';
import { idbRead } from './idb.ts';
import { afterPageFade, readRunLogInPage, shot } from './page-helpers.ts';
import { logOnFail } from './fail-log.ts';
import { expect, seedFakeSession, test } from './session-fixture.ts';

test.setTimeout(120_000);
test.use({ trace: 'off', timezoneId: 'Asia/Seoul', locale: 'zh-CN', viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });

const USER = '0e2e0000-0000-4000-8000-000000000001';
const id = (n: number) => `0e2e0000-0000-4000-8000-0000000b4c${String(n).padStart(2, '0')}`;
const T1 = id(1);
const T2 = id(2);
const T3 = id(3);
const EV = id(4);
const NT = id(5);
const EV2 = id(6);
const ASK = '这周还有什么没做完？';
const WEB_ASK = '明天首尔会下雨吗？';
const WEB_ANSWER = '明天（11月23日）首尔白天多云，傍晚 6 点以后有小雨，降水概率 60%[1][2]，气温 2～9°C。\n你明天 19:00 约了和小王吃晚饭[3]，出门记得带伞。';
const ANSWER = '还剩 3 件待办：交周报给产品组[1]今天 18:00 截止，最急；买牛奶和鸡蛋[2]也是今天；回复房东暖气的邮件[3]已经逾期 2 天了。\n另外周三 14:00 有设计评审会[4]，你在随手记里写过想先试一版更淡的底栏[5]，可以评审前弄。';

const DRAFT_ASK = '明天下午三点和客户开会，周五前交报告';
const DRAFT_ANSWER = '整理好了，确认一下就记下。';
const DRAFTS = ['明天下午三点和客户开会', '周五前交报告'];
// ⑫ 过去的月日：首尔的昨天，只说月日（1 月 1 日跑时昨天在去年、不算过去，跳过）
const YESTERDAY = new Date(Date.now() - 86_400_000 + 9 * 3600_000);
const PAST_MD = { m: YESTERDAY.getUTCMonth() + 1, d: YESTERDAY.getUTCDate(), y: YESTERDAY.getUTCFullYear() };
const PAST_ASK = `${PAST_MD.m}月${PAST_MD.d}日下午三点开会`;

type Fake = { chats: unknown[]; writes: { table: string; body: unknown }[]; pulled: Set<string> };

const dayOf = (ms: number): string => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

/** admin：管理员（服务器 my_ai_usage 回 ai_unlimited: true，已用 60 次，quota_left 按满额 50 回），其余同 ok */
async function fakeServer(page: Page, baseURL: string | undefined, reply: 'ok' | 'quota' | 'slow' | 'admin' | 'web' | 'draft' | 'past', images = true): Promise<Fake> {
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  const now = Date.now();
  const at = new Date(now).toISOString();
  const today = dayOf(now);
  const late = dayOf(now - 2 * 86_400_000);
  const c = { user_id: USER, created_at: now, updated_at: now, deleted_at: null, undone: false, rev: 1, synced_at: at };
  const item = { project: '', source: 'page', raw_text: '', short: null, short_by: null, push_show_title: null, batch_id: null, notified_for: null, snooze_at: null };
  const todo = (tid: string, title: string, due: string, dueTime: string | null) => ({
    id: tid, ...c, ...item, title, note: '', due, done: false, important: false, priority: 'mid', sort_key: null, from_note_id: null, from_anniv_id: null,
    done_at: 0, remind_days: null, remind_time: '09:00', due_time: dueTime, remind_before_min: null,
  });
  const tables: Record<string, Record<string, unknown>[]> = {
    events: [
      { id: EV, ...c, ...item, project: '学习', title: '设计评审会', date: dayOf(now + 3 * 86_400_000), time: '14:00', tz: 'Asia/Seoul', duration_min: 60, location: '', note: '', remind_min: null, remind_days: null },
      // ⑥ 联网回答引到的那条日程（参考 webFeed 的“和小王吃晚饭”，竖条 --p3s = 第 3 个固定类别“健康”）
      { id: EV2, ...c, ...item, project: '健康', title: '和小王吃晚饭', date: dayOf(now + 86_400_000), time: '19:00', tz: 'Asia/Seoul', duration_min: 60, location: '', note: '', remind_min: null, remind_days: null },
    ],
    todos: [todo(T1, '交周报给产品组', today, '18:00'), todo(T2, '买牛奶和鸡蛋', today, null), todo(T3, '回复房东关于暖气的邮件', late, null)],
    notes: [{ id: NT, ...c, title: '底栏可以试试更淡一点的颜色', body: '', is_private: false, category_id: null, category_source: 'none', category_seen: true, sort_key: null, tags: [], converted_to: null, source: 'page', raw_text: '', batch_id: null }],
    settings: [{ id: id(50), ...c, key: 'ai.enabled', value: true }],
  };
  const rest = await fakeRest(page, {
    user: USER,
    tables,
    profile: { consent_ai_at: at },
    writeRev: 2,
    fixed: {
      my_ai_usage: reply === 'admin'
        ? { ai_used: 60, ai_limit: 50, pacific_date: '2026-11-22', ai_unlimited: true }
        : { ai_used: reply === 'ok' ? 19 : reply === 'web' || reply === 'draft' || reply === 'past' ? 20 : 50, ai_limit: 50, pacific_date: '2026-11-22', ai_unlimited: false },
    },
  });
  const fake: Fake = { chats: [], writes: rest.writes, pulled: rest.pulled };
  const refs = [
    { kind: 'todo', id: T1, title: '交周报给产品组', date: today, time: '18:00', done: false },
    { kind: 'todo', id: T2, title: '买牛奶和鸡蛋', date: today, time: null, done: false },
    { kind: 'todo', id: T3, title: '回复房东关于暖气的邮件', date: late, time: null, done: false },
    { kind: 'event', id: EV, title: '设计评审会', date: dayOf(now + 3 * 86_400_000), time: '14:00' },
    { kind: 'note', id: NT, title: '底栏可以试试更淡一点的颜色', date: dayOf(now - 5 * 86_400_000), time: null },
  ];
  // ⑥ 联网：两条网页来源 + 一条日程，同一套编号（参考 webFeed）
  const webRefs = [
    { kind: 'web', title: '서울 날씨 · 시간별 예보', url: 'https://weather.naver.com/today/09140104', site: 'weather.naver.com' },
    { kind: 'web', title: '기상청 단기예보 · 서울', url: 'https://www.kma.go.kr/w/weather/forecast/short-term.do', site: 'www.kma.go.kr' },
    { kind: 'event', id: EV2, title: '和小王吃晚饭', date: dayOf(now + 86_400_000), time: '19:00' },
  ];
  await page.route(/\/sb\/functions\/v1\/ai-chat/, async (route) => {
    fake.chats.push(route.request().postDataJSON());
    // slow：一直不回（看关抽屉时请求真的被取消）
    if (reply === 'slow') return new Promise<void>(() => undefined);
    if (reply === 'web') return route.fulfill({ json: { answer: WEB_ANSWER, refs: webRefs, searched: ['event'], found: 1, webs: 2, quota_left: 30 } });
    // ⑩ 记日程待办：服务器只回原话两段（draft_records），卡片由前端按本机规则拆
    if (reply === 'draft') return route.fulfill({ json: { answer: DRAFT_ANSWER, refs: [], searched: [], found: 0, drafts: DRAFTS, quota_left: 30 } });
    if (reply === 'past') return route.fulfill({ json: { answer: DRAFT_ANSWER, refs: [], searched: [], found: 0, drafts: [PAST_ASK], quota_left: 30 } });
    return route.fulfill({
      json: reply !== 'quota' ? { answer: ANSWER, refs, searched: ['event', 'todo', 'note'], found: 5, quota_left: reply === 'admin' ? 50 : 31 } : { quota_out: true, quota_left: 0 },
    });
  });
  await page.route(/\/sb\/functions\/v1\/ai-parse/, (route) => route.fulfill({ json: { fallback: true, reason: 'error' } }));
  // 输入条画不画“＋”问 ai-provider 的 mine：images 是对话那家收不收图（独立评审第 4 条）
  await page.route(/\/sb\/functions\/v1\/ai-provider/, (route) => route.fulfill({ json: { admin: false, project: images ? 'gemini' : 'openai', own: null, images } }));
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

const FIRST_PULL = ['events', 'todos', 'notes', 'settings', 'profiles'];

async function openToday(page: Page, fake: Fake): Promise<void> {
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => FIRST_PULL.filter((t) => !fake.pulled.has(t)), { timeout: 20_000 }).toEqual([]);
  await expect.poll(async () => Boolean(await idbRead(page, 'todos', 'get', T1)), { timeout: 10_000 }).toBe(true);
  await afterPageFade(page);
}

async function askAi(page: Page, browserName: string, shotName: string | null, text = ASK): Promise<void> {
  await page.getByTestId('tabbar-add').click();
  await expect(page.getByTestId('type-input')).toBeFocused({ timeout: 10_000 });
  await expect(page.getByTestId('type-ask-ai')).toBeDisabled();
  await page.getByTestId('type-input').fill(text);
  await expect(page.getByTestId('type-ask-ai')).toBeEnabled();
  if (shotName) await shots(page, browserName, shotName);
  await page.getByTestId('type-ask-ai').click();
  await expect(page.getByTestId('chat-sheet')).toBeVisible({ timeout: 10_000 });
  // 打字条收起、这一句交出去了
  await expect(page.getByTestId('type-bar')).toHaveCount(0);
}

test.describe('R-492 AI 助手：手机', () => {
  test('① 问 AI → 半屏抽屉：回答、角标、依据；拉满全列；点条目打开原条目', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL, 'ok');
    await openToday(page, fake);
    await askAi(page, browserName, '入口-打字条问AI');
    const sheet = page.getByTestId('chat-sheet');
    await expect(sheet).toHaveAttribute('data-stop', 'half');
    await expect(page.getByTestId('chat-me')).toHaveText(ASK);
    await expect(page.getByTestId('chat-lbl')).toHaveText('查了你的日程、待办、随手记 · 找到 5 条', { timeout: 10_000 });
    await expect(page.getByTestId('chat-cite')).toHaveText(['1', '2', '3', '4', '5']);
    await expect(page.getByTestId('chat-ref')).toHaveCount(3);
    await expect(page.getByTestId('chat-more')).toHaveText('还有 2 条 · 往上拉看全部');
    // 半屏离顶约 27%（方案页 top 250 / 932）
    // 出现动画放完再量（带着 transform 时 boundingBox 是滑行途中的位置）
    await expect
      .poll(() => sheet.evaluate((el) => `${Math.round((el as HTMLElement).offsetTop)} ${getComputedStyle(el).transform} ${Math.round(el.getBoundingClientRect().y)}`), { timeout: 5_000 })
      .toBe(`${Math.round(932 * 0.27)} none ${Math.round(932 * 0.27)}`);
    // 请求只带这一句、主页面范围
    expect(fake.chats).toHaveLength(1);
    expect(fake.chats[0]).toMatchObject({ messages: [{ role: 'user', text: ASK }], scope: 'main', tz: 'Asia/Seoul' });
    expect(fake.chats[0]).not.toHaveProperty('now');   // 服务器只用自己的时钟
    await expect(page.getByTestId('chat-ref').first()).toContainText('今天 18:00 截止');
    await expect(page.getByTestId('chat-ref').nth(2)).toContainText('逾 2 天');
    await shots(page, browserName, '对话-半屏-查数据');

    // 拖把手往上 → 拉满
    const grab = await page.getByTestId('chat-grab').boundingBox();
    const gx = (grab?.x ?? 0) + (grab?.width ?? 0) / 2;
    const gy = (grab?.y ?? 0) + (grab?.height ?? 0) / 2;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    await page.mouse.move(gx, gy - 60, { steps: 4 });
    await page.mouse.move(gx, gy - 160, { steps: 4 });
    await page.mouse.up();
    await expect(sheet).toHaveAttribute('data-stop', 'full');
    await expect(page.getByTestId('chat-ref')).toHaveCount(5);
    // 日程竖条的项目色挪到 ①b 验（这条在 CI webkit 关模糊的名单里，名单里的用例不许读颜色）
    await expect(page.getByTestId('chat-usage')).toHaveText('这次用了 1 次 AI · 今天 19 / 50', { timeout: 10_000 });
    await shots(page, browserName, '对话-拉满-查数据');

    // 点第 1 条 → 贴底弹层 → 打开原条目
    await page.getByTestId('chat-ref').first().click();
    await expect(page.getByTestId('chat-ref-sheet')).toBeVisible();
    await expect(page.getByTestId('chat-ref-sheet')).toContainText('交周报给产品组');
    await expect(page.getByTestId('chat-ref-sheet')).toContainText('今天 18:00 截止');
    await shots(page, browserName, '对话-点开条目');
    await page.getByTestId('chat-ref-open').click();
    await expect(page.getByTestId('chat-sheet')).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toContain(T1);

    const log = await runLog(page);
    expect(log).toMatch(/typebar ask len=10/);
    expect(log).toMatch(/chat send len=10 hist=0/);
    expect(log).toMatch(/chat answer ms=\d+ refs=5 found=5/);
    expect(log).toMatch(/chat sheet drag from=half to=full/);
    expect(log).not.toContain('没做完');
  });

  // 从 ① 拆出来（11-25）：日程竖条是项目色（参考 .calbar 用项目色）：服务器不回项目，前端按日程 id 从本机库查。
  // 联网回答三条依据半屏就全列出来，不用拉满、不等滑完；“健康”= 第 3 个固定类别，浅色下 --p3s #B8473C
  test('①b 依据里的日程竖条是项目色（服务器不回项目，按日程 id 从本机库查）', async ({ page, baseURL }) => {
    const fake = await fakeServer(page, baseURL, 'web');
    await openToday(page, fake);
    await askAi(page, 'chromium', null, WEB_ASK);
    const rows = page.getByTestId('chat-ref');
    await expect(rows).toHaveCount(3, { timeout: 10_000 });
    await expect(rows.nth(2)).toHaveAttribute('data-kind', 'event');
    await expect(rows.nth(2).locator('span[aria-hidden="true"] > span').first()).toHaveCSS('background-color', 'rgb(184, 71, 60)');
  });

  test('② 用完：用完卡、输入条变灰；“改成记下”存成一条', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL, 'quota');
    await openToday(page, fake);
    await askAi(page, browserName, null);
    await expect(page.getByTestId('chat-quota')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('chat-quota')).toContainText(/今天 50 \/ 50，明天 \d{2}:\d{2} 恢复。/, { timeout: 10_000 });
    await expect(page.getByTestId('chat-input')).toBeDisabled();
    await expect(page.getByTestId('chat-input')).toHaveAttribute('placeholder', /^明天 \d{2}:\d{2} 以后再问$/);
    await expect(page.getByTestId('chat-send')).toBeDisabled();
    await shots(page, browserName, '对话-额度用完');
    await page.getByTestId('chat-quota-record').click();
    await expect(page.getByTestId('chat-quota-record')).toHaveText('已记下', { timeout: 15_000 });
    await expect.poll(() => fake.writes.length, { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test('③ 点后面的模糊层：抽屉滑下去关掉', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL, 'ok');
    await openToday(page, fake);
    await askAi(page, browserName, null);
    await expect(page.getByTestId('chat-answer')).toBeVisible({ timeout: 10_000 });
    await page.mouse.click(215, 100);
    await expect(page.getByTestId('chat-sheet')).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByTestId('today')).toBeVisible();
    await expect.poll(() => runLog(page), { timeout: 5_000 }).toMatch(/chat close ms=\d+ turns=2/);
  });

  test('④ 还在问时：接着发的一句排队、气泡下写“上一句还在问”；点“✕ 关闭”滑下去关，正在问的请求真的取消', async ({ page, baseURL }) => {
    const fake = await fakeServer(page, baseURL, 'slow');
    await openToday(page, fake);
    await askAi(page, 'chromium', null);
    await expect(page.getByTestId('chat-think')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('chat-input').fill('最急的是哪个？');
    await expect(page.getByTestId('chat-send')).toBeEnabled();
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-me')).toHaveText([ASK, '最急的是哪个？']);
    await expect(page.getByTestId('chat-wait')).toHaveText('上一句还在问');
    expect(fake.chats).toHaveLength(1);
    await page.getByTestId('chat-close').click();
    await expect(page.getByTestId('chat-sheet')).toHaveCount(0, { timeout: 5_000 });
    // 取消写在 ChatDrawer 卸下时的 effect 清理里：React 先拿掉 DOM、清理稍后才跑，抽屉没了不等于这一行已经记上（同③等 chat close）
    await expect.poll(() => runLog(page), { timeout: 5_000 }).toMatch(/chat abort inflight=1 queued=1/);
    const log = await runLog(page);
    expect(log).toMatch(/chat send queued=1/);
    expect(log).toMatch(/chat sheet close/);
    expect(fake.chats).toHaveLength(1);
  });

  // 负责人 11-22“上面的额度管理员是没有限制的”：是不是管理员由服务器 my_ai_usage 的 ai_unlimited 告诉前端
  test('⑤ 管理员：今天已用 60 次照样回答，用量行写“今天 60 次 · 不限”，不写“/ 50”、不出用完卡', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL, 'admin');
    await openToday(page, fake);
    await askAi(page, browserName, null);
    await expect(page.getByTestId('chat-answer')).toBeVisible({ timeout: 10_000 });
    // 滑入动画放完再量把手（带着 transform 时 boundingBox 是滑行途中的位置，同 ①）
    const sheet = page.getByTestId('chat-sheet');
    await expect.poll(() => sheet.evaluate((el) => getComputedStyle(el).transform), { timeout: 5_000 }).toBe('none');
    const grab = await page.getByTestId('chat-grab').boundingBox();
    const gx = (grab?.x ?? 0) + (grab?.width ?? 0) / 2;
    const gy = (grab?.y ?? 0) + (grab?.height ?? 0) / 2;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    await page.mouse.move(gx, gy - 60, { steps: 4 });
    await page.mouse.move(gx, gy - 160, { steps: 4 });
    await page.mouse.up();
    await expect(sheet).toHaveAttribute('data-stop', 'full');
    await expect(page.getByTestId('chat-usage')).toHaveText('这次用了 1 次 AI · 今天 60 次 · 不限', { timeout: 10_000 });
    await expect(page.getByTestId('chat-quota')).toHaveCount(0);
    await shots(page, browserName, '对话-拉满-管理员不限');
    expect(await runLog(page)).toMatch(/chat usage used=60 limit=50/);
  });

  // 第 2 段联网（参考方案页 webFeed、截图_对话_联网）：小字“联网查了 2 个网页 · 用了你的 1 条日程”；网页行字母方块、标题、网站名、“网页”、↗，
  // 点了用浏览器原样打开服务器给的网址（新窗口）；记录行照旧；运行日志只记第几个，不记网址
  test('⑥ 联网回答：两条网页来源 + 一条日程同一套编号；点网页行新窗口打开原网址', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL, 'web');
    await openToday(page, fake);
    await page.getByTestId('tabbar-add').click();
    await expect(page.getByTestId('type-input')).toBeFocused({ timeout: 10_000 });
    await page.getByTestId('type-input').fill(WEB_ASK);
    await page.getByTestId('type-ask-ai').click();
    const sheet = page.getByTestId('chat-sheet');
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('chat-lbl')).toHaveText('联网查了 2 个网页 · 用了你的 1 条日程', { timeout: 10_000 });
    await expect(page.getByTestId('chat-cite')).toHaveText(['1', '2', '3']);
    expect(fake.chats[0]).toMatchObject({ messages: [{ role: 'user', text: WEB_ASK }], web: true });
    expect(fake.chats[0]).not.toHaveProperty('images');
    await expect.poll(() => sheet.evaluate((el) => getComputedStyle(el).transform), { timeout: 5_000 }).toBe('none');
    const grab = await page.getByTestId('chat-grab').boundingBox();
    const gx = (grab?.x ?? 0) + (grab?.width ?? 0) / 2;
    const gy = (grab?.y ?? 0) + (grab?.height ?? 0) / 2;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    await page.mouse.move(gx, gy - 60, { steps: 4 });
    await page.mouse.move(gx, gy - 160, { steps: 4 });
    await page.mouse.up();
    await expect(sheet).toHaveAttribute('data-stop', 'full');
    const rows = page.getByTestId('chat-ref');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('data-kind', 'web');
    await expect(rows.nth(0)).toContainText('N서울 날씨 · 시간별 예보weather.naver.com网页↗');
    await expect(rows.nth(1)).toContainText('K기상청 단기예보 · 서울www.kma.go.kr网页↗');
    await expect(rows.nth(2)).toHaveAttribute('data-kind', 'event');
    await expect(rows.nth(2)).toContainText('和小王吃晚饭');
    await expect(page.getByTestId('chat-usage')).toHaveText('这次用了 1 次 AI · 今天 20 / 50', { timeout: 10_000 });
    await shots(page, browserName, '对话-联网');

    // 新窗口不出本机：外站地址在浏览器这一层答
    await page.context().route(/weather\.naver\.com/, (r) => r.fulfill({ contentType: 'text/html', body: '<p>ok</p>' }));
    const popup = page.waitForEvent('popup');
    await rows.nth(0).click();
    const win = await popup;
    expect(win.url()).toContain('weather.naver.com/today/09140104');
    await win.close();
    await expect.poll(() => runLog(page), { timeout: 5_000 }).toMatch(/chat web open i=1/);
    const log = await runLog(page);
    expect(log).toMatch(/chat answer ms=\d+ refs=3 found=1 webs=2/);
    expect(log).not.toContain('naver');
  });

  // 负责人 11-23 弹窗第 3 项：输入条左边“＋”选图 → 上面一排小图（点一下移除）→ 随下一句发一次（webp、base64），发完清掉
  test('⑦ 输入条“＋”选图：小图一排、点一下移除；带图发送后清空', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL, 'ok');
    await openToday(page, fake);
    await askAi(page, browserName, null);
    await expect(page.getByTestId('chat-answer')).toBeVisible({ timeout: 10_000 });
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 120;
      const x = c.getContext('2d');
      if (x) {
        x.fillStyle = '#e8b400';
        x.fillRect(0, 0, 160, 120);
        x.fillStyle = '#1f77a6';
        x.fillRect(40, 30, 80, 60);
      }
      return c.toDataURL('image/png').split(',')[1] ?? '';
    });
    const buffer = Buffer.from(png, 'base64');
    await expect(page.getByTestId('chat-pic-add')).toBeEnabled();
    // 只有鼠标（chromium 桌面）：“＋”、麦克风 36 圆、输入条 50 高；有触屏（webkit iPhone）照旧 44、58（负责人 11-27 选“36 的圆”）
    const [btn, bar] = browserName === 'chromium' ? [36, 50] : [44, 58];
    const size = (id: string) => page.getByTestId(id).evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    expect(await size('chat-pic-add')).toEqual([btn, btn]);
    // 麦克风只在手机、而且浏览器能录音时画（这里的 WebKit 没有录音），有才量；网页版（chromium 桌面）不画麦克风，没打字也是发送钮、占位只写“问点什么”（负责人 11-27“换成这个”）
    if ((await page.getByTestId('chat-mic').count()) > 0) expect(await size('chat-mic')).toEqual([btn, btn]);
    if (browserName === 'chromium') {
      await expect(page.getByTestId('chat-mic')).toHaveCount(0);
      await expect(page.getByTestId('chat-send')).toBeDisabled();
      expect(await size('chat-send')).toEqual([btn, btn]);
      await expect(page.getByTestId('chat-input')).toHaveAttribute('placeholder', '问点什么');
    }
    expect((await size('chat-composer'))[1]).toBe(bar);
    await page.getByTestId('chat-pic-input').setInputFiles([
      { name: 'a.png', mimeType: 'image/png', buffer },
      { name: 'b.png', mimeType: 'image/png', buffer },
    ]);
    await expect(page.getByTestId('chat-pic')).toHaveCount(2, { timeout: 15_000 });
    await page.getByTestId('chat-pic').nth(1).click();
    await expect(page.getByTestId('chat-pic')).toHaveCount(1);
    await expect.poll(() => page.getByTestId('chat-pic').locator('img').evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 5_000 }).toBe(160);
    await page.getByTestId('chat-input').fill('这张图里是什么？');
    expect(await size('chat-send')).toEqual([btn, btn]);
    await shots(page, browserName, '对话-输入条带图');
    await page.getByTestId('chat-send').click();
    await expect.poll(() => fake.chats.length, { timeout: 10_000 }).toBe(2);
    const sent = fake.chats[1] as { images?: { mime: string; data: string }[] };
    expect(sent.images).toHaveLength(1);
    expect(sent.images?.[0]?.mime).toBe('image/webp');
    expect(Buffer.from(sent.images?.[0]?.data ?? '', 'base64').subarray(8, 12).toString('latin1')).toBe('WEBP');
    await expect(page.getByTestId('chat-pics')).toHaveCount(0);
    // 运行日志是攒一会儿才写进去的：两行都等着读
    await expect.poll(() => runLog(page), { timeout: 5_000 }).toMatch(/chat pics add n=2 ok total=2/);
    await expect.poll(() => runLog(page), { timeout: 5_000 }).toMatch(/chat pics sent n=1/);
  });

  // 独立评审第 4 条：发送失败时图留着（可以再发）；对话那家不收图时不画“＋”，输入条左边距回到参考的 20
  test('⑧ 带图发送失败：图留着、小图还能点（可以再发）', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL, 'ok');
    await openToday(page, fake);
    await askAi(page, browserName, null);
    await expect(page.getByTestId('chat-answer')).toBeVisible({ timeout: 10_000 });
    await page.route(/\/sb\/functions\/v1\/ai-chat/, (route) => {
      fake.chats.push(route.request().postDataJSON());
      return route.fulfill({ status: 500, json: { error: 'internal' } });
    });
    const buffer = Buffer.from(await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 48;
      c.getContext('2d')?.fillRect(0, 0, 64, 48);
      return c.toDataURL('image/png').split(',')[1] ?? '';
    }), 'base64');
    await page.getByTestId('chat-pic-input').setInputFiles([{ name: 'a.png', mimeType: 'image/png', buffer }]);
    await expect(page.getByTestId('chat-pic')).toHaveCount(1, { timeout: 15_000 });
    await page.getByTestId('chat-input').fill('这张图里是什么？');
    await page.getByTestId('chat-send').click();
    await expect.poll(() => fake.chats.length, { timeout: 10_000 }).toBe(2);
    await expect.poll(() => runLog(page), { timeout: 10_000 }).toMatch(/chat pics kept n=1/);
    await expect(page.getByTestId('chat-pic')).toHaveCount(1);
    await expect(page.getByTestId('chat-pic')).toBeEnabled();
    expect(await page.getByTestId('chat-composer').evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('7px');
  });

  test('⑨ 对话那家不收图（mine 回 images: false）：不画“＋”，输入条左边距 20', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL, 'ok', false);
    await openToday(page, fake);
    await askAi(page, browserName, null);
    await expect(page.getByTestId('chat-answer')).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => runLog(page), { timeout: 10_000 }).toMatch(/chat pics allowed=0/);
    await expect(page.getByTestId('chat-pic-add')).toHaveCount(0);
    await expect(page.getByTestId('chat-pic-input')).toHaveCount(0);
    expect(await page.getByTestId('chat-composer').evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('20px');
    await page.getByTestId('chat-input').fill('这张图里是什么？');
    await shots(page, browserName, '对话-不收图没有加号');
  });

  test('⑩ 记日程待办：一句两件事 → 两张“要记成这样吗”卡片；“记下来”经保存口写进日程、点“查看”打开那条；“改一下”带到新建待办页', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL, 'draft');
    await openToday(page, fake);
    await askAi(page, browserName, null, DRAFT_ASK);
    // 请求带 draft: true（本机挂了保存口才带）
    await expect.poll(() => fake.chats.length, { timeout: 10_000 }).toBe(1);
    expect(fake.chats[0]).toMatchObject({ messages: [{ role: 'user', text: DRAFT_ASK }], draft: true });
    const cards = page.getByTestId('chat-draft');
    await expect(cards).toHaveCount(2, { timeout: 10_000 });
    await expect(cards.nth(0)).toHaveAttribute('data-kind', 'event');
    await expect(cards.nth(1)).toHaveAttribute('data-kind', 'todo');
    await expect(page.getByTestId('chat-draft-title')).toHaveText(['和客户开会', '交报告']);
    await expect(page.getByTestId('chat-draft-meta').nth(0)).toContainText('15:00');
    await expect(page.getByTestId('chat-draft-meta').nth(1)).toContainText('截止');
    await expect(cards.nth(0)).toContainText('要记成这样吗');
    await shots(page, browserName, '对话-记日程待办-确认卡片');

    // 记下来 → 写进 events（source page、原话），卡片换成“已记到日程 · 查看”
    const before = fake.writes.length;
    await cards.nth(0).getByTestId('chat-draft-save').click();
    await expect(cards.nth(0)).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    await expect(cards.nth(0).getByTestId('chat-draft-open')).toContainText('已记到日程');
    await expect.poll(() => fake.writes.slice(before).filter((w) => w.table === 'events').length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(JSON.stringify(fake.writes.slice(before).find((w) => w.table === 'events')?.body)).toContain('和客户开会');
    // 第二张还没记
    await expect(cards.nth(1)).toHaveAttribute('data-state', 'idle');
    await shots(page, browserName, '对话-记日程待办-已记一张');

    // 关抽屉再打开，状态还在（卡片存在回答里）——这里直接点“查看”：关抽屉、打开那条日程
    await cards.nth(0).getByTestId('chat-draft-open').click();
    await expect(page.getByTestId('chat-sheet')).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toMatch(/event|calendar/);

    // 运行日志分段写进 localStorage 不是同步的：等存卡那一行落盘
    await expect.poll(() => runLog(page), { timeout: 10_000 }).toMatch(/chat draft save kind=event ok=1/);
    const log = await runLog(page);
    expect(log).toMatch(/chat send .*draft=1/);
    expect(log).toMatch(/chat answer .*drafts=2 cards=2/);
    expect(log).not.toContain('客户');
    // raw_text 存用户问的那一句
    expect(JSON.stringify(fake.writes.slice(before).find((w) => w.table === 'events')?.body)).toContain(DRAFT_ASK);
  });

  test('⑫ 记日程待办：过去的月日先问，选“明年”才出“记下来”，记成明年那天', async ({ page, baseURL, browserName }) => {
    test.skip(PAST_MD.m === 12 && PAST_MD.d === 31, '1 月 1 日跑时昨天在去年，不算过去的月日');
    const fake = await fakeServer(page, baseURL, 'past');
    await openToday(page, fake);
    await askAi(page, browserName, null, PAST_ASK);
    const card = page.getByTestId('chat-draft');
    await expect(card).toHaveCount(1, { timeout: 10_000 });
    await expect(card).toHaveAttribute('data-state', 'ask');
    await expect(card).toContainText(`${PAST_MD.m} 月 ${PAST_MD.d} 日已经过了`);
    await expect(card.getByTestId('chat-draft-save')).toHaveCount(0);
    await expect(card.getByTestId('chat-draft-past')).toContainText(`补记今年（${PAST_MD.m}/${PAST_MD.d}）`);
    await expect(card.getByTestId('chat-draft-next')).toContainText(`明年（${PAST_MD.y + 1}/${PAST_MD.m}/${PAST_MD.d}）`);
    await shots(page, browserName, '对话-记日程待办-过去的日子先问');
    await card.getByTestId('chat-draft-next').click();
    await expect(card).toHaveAttribute('data-state', 'idle');
    const before = fake.writes.length;
    await card.getByTestId('chat-draft-save').click();
    await expect(card).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
    const pad = (n: number): string => String(n).padStart(2, '0');
    await expect.poll(() => JSON.stringify(fake.writes.slice(before).find((w) => w.table === 'events')?.body ?? ''), { timeout: 15_000 })
      .toContain(`"date":"${PAST_MD.y + 1}-${pad(PAST_MD.m)}-${pad(PAST_MD.d)}"`);
    await expect.poll(() => runLog(page), { timeout: 10_000 }).toMatch(/chat draft pick kind=event choice=next/);
  });

  // 卡片本身不存；新建页接住带过去的字以后和打字条“展开编辑”一样照常自动保存（R-353），所以这里不断言“没有写入”
  test('⑪ 记日程待办：“改一下”关抽屉、标题带到新建待办页', async ({ page, baseURL }) => {
    const fake = await fakeServer(page, baseURL, 'draft');
    await openToday(page, fake);
    await askAi(page, 'skip', null, DRAFT_ASK);
    const cards = page.getByTestId('chat-draft');
    await expect(cards).toHaveCount(2, { timeout: 10_000 });
    await cards.nth(1).getByTestId('chat-draft-edit').click();
    await expect(page.getByTestId('chat-sheet')).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toMatch(/^#\/todo\//);
    await expect(page.getByTestId('todo-edit-title')).toHaveValue('交报告', { timeout: 10_000 });
    await expect.poll(() => runLog(page), { timeout: 10_000 }).toMatch(/chat draft edit kind=todo/);
  });

  // 负责人 11-24：“ai搜索完……之前搜索的不会自动顶到最下面，还要手动往上拉”（弹窗选“回答出来时没滚到底”）
  test('⑬ 对话区跟到底：回答出来、再问一句都停在最底；自己往上翻了不拽回去', async ({ page, baseURL }) => {
    const fake = await fakeServer(page, baseURL, 'web');
    await openToday(page, fake);
    await askAi(page, 'skip', null, WEB_ASK);
    const feed = page.getByTestId('chat-feed');
    const gap = (): Promise<number> => feed.evaluate((f) => f.scrollHeight - f.scrollTop - f.clientHeight);
    await expect(page.getByTestId('chat-cite')).not.toHaveCount(0, { timeout: 10_000 });
    await page.getByTestId('chat-input').fill('那后天呢？');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-me')).toHaveCount(2);
    await expect.poll(() => page.getByTestId('chat-cite').count(), { timeout: 10_000 }).toBeGreaterThan(3);
    // 两问两答，半屏装不下（不然这条测不出东西）
    expect(await feed.evaluate((f) => f.scrollHeight > f.clientHeight + 100)).toBe(true);
    await expect.poll(gap, { timeout: 5_000 }).toBeLessThanOrEqual(2);
    // 自己翻到顶：打字（整块重画）不拽回去
    await feed.evaluate((f) => {
      f.scrollTop = 0;
      f.dispatchEvent(new Event('scroll'));
    });
    await page.getByTestId('chat-input').fill('再');
    await page.waitForTimeout(300);
    expect(await feed.evaluate((f) => f.scrollTop)).toBe(0);
    // 再问一句：重新跟到底
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-me')).toHaveCount(3);
    await expect.poll(gap, { timeout: 10_000 }).toBeLessThanOrEqual(2);
  });
});
