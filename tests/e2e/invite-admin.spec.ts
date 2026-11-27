// 设置 › 邀请朋友（R-83：只有管理员能发码；架构 5.6 发码 → invite-admin）
// /sb 在浏览器这一层答：ai-provider 的 mine 回 admin（是不是管理员只看这一个，同“AI 服务商”一行）；invite-admin 按 action 回，发过的码放在 fake 里
//   ① 管理员：设置首页“更多”卡里有“邀请朋友 | 发邀请码”→ 二级页写清“只写编号或日期，不要写名字”→ 带备注生成 → 码 4 位一组、写明 7 天有效只能用一次只显示这一次
//      → 复制（Chromium 授了剪贴板权限写“已复制”；WebKit 不一定能写，写不了就选中码）→ 列表多一条；运行日志、本机存储、地址里都没有码和备注
//   ② 普通人：首页没有“邀请朋友”，也没调 invite-admin
//   ③ 每天 20 次用完（rate_limited）：写“明天再试”、不出码
//   ④ 网页版宽屏（1440×900）：左目录“数据”一组里有“邀请朋友”，点进去右边详情是二级页
//   ⑤ 作废（负责人 11-27“生产的邀请码可以查看跟废除”，只加作废）：还没用的行才有“作废” → 页面里的确认框（不是 confirm()）→ 取消不发
//      → 确认发 {action: revoke, id} → 那一行从列表消失、写“已作废”；运行日志只有动作名和结果码，没有 id、备注
// 设了 LEMO_SHOT_DIR 时在 Chromium 上截评审图（手机 430×932 DPR 3、宽屏 1440×900）。跑在快读组（要会话令牌、/sb 地址）
import type { Page } from '@playwright/test';
import { fakeRest } from './fake-rest.ts';
import { readRunLogInPage, shot, touchSwipe } from './page-helpers.ts';
import { logOnFail } from './fail-log.ts';
import { expect, seedFakeSession, test } from './session-fixture.ts';

test.setTimeout(120_000);
test.use({ trace: 'off', timezoneId: 'Asia/Seoul', locale: 'zh-CN', viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });

const USER = '0e2e0000-0000-4000-8000-000000000002';
const CODE = 'K7Q2M9XD4TPA';
const NOTE = '11-27 第 3 个';
type Row = { id: string; note: string | null; max_uses: number; used_count: number; expires_at: string };
type Fake = { calls: Record<string, unknown>[]; rows: Row[]; createReply: { status: number; json: unknown } | null };

async function fakeServer(page: Page, baseURL: string | undefined, admin: boolean): Promise<Fake> {
  await seedFakeSession(page.context(), baseURL, { jwt: true });
  const day = 86_400_000;
  const fake: Fake = {
    calls: [],
    rows: [
      { id: 'aaaa0001', note: '11-25', max_uses: 1, used_count: 1, expires_at: new Date(Date.now() + 5 * day).toISOString() },
      { id: 'bbbb0002', note: null, max_uses: 1, used_count: 0, expires_at: new Date(Date.now() + 2 * day).toISOString() },
    ],
    createReply: null,
  };
  await fakeRest(page, { user: USER, tables: {}, fixed: { my_ai_usage: { ai_used: 0, ai_limit: 50, pacific_date: '2026-11-27', ai_unlimited: admin } } });
  await page.route(/\/sb\/functions\/v1\/ai-provider/, (route) => {
    const b = route.request().postDataJSON() as Record<string, unknown>;
    if (b['action'] === 'mine') return route.fulfill({ json: { admin, project: 'gemini', own: null, images: true } });
    return route.fulfill({ status: 400, json: { error: 'bad_request' } });
  });
  await page.route(/\/sb\/functions\/v1\/invite-admin/, (route) => {
    const b = route.request().postDataJSON() as Record<string, unknown>;
    fake.calls.push(b);
    if (!admin) return route.fulfill({ status: 403, json: { error: 'not_admin' } });
    if (b['action'] === 'list') return route.fulfill({ json: { invites: [...fake.rows].sort((x, y) => y.expires_at.localeCompare(x.expires_at)) } });
    if (b['action'] === 'create') {
      if (fake.createReply) return route.fulfill(fake.createReply);
      const expires_at = new Date(Date.now() + 7 * day).toISOString();
      fake.rows.push({ id: 'cccc0003', note: typeof b['note'] === 'string' ? b['note'] : null, max_uses: 1, used_count: 0, expires_at });
      return route.fulfill({ json: { code: CODE, expires_at } });
    }
    if (b['action'] === 'revoke') {
      // 同服务器：只有还没用的能作废，作废了就等于过期、list 不再列出
      const i = fake.rows.findIndex((r) => r.id === b['id'] && r.used_count < r.max_uses);
      if (i < 0) return route.fulfill({ status: 404, json: { error: 'not_found' } });
      fake.rows.splice(i, 1);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 400, json: { error: 'bad_request' } });
  });
  return fake;
}

const runLog = (page: Page) => page.evaluate(readRunLogInPage);
logOnFail(test);

async function openSettings(page: Page): Promise<void> {
  await page.goto('/app/#/settings');
  await expect(page.locator('main[data-feature="settings"]')).toBeVisible({ timeout: 30_000 });
}

/** 邀请码、备注不进运行日志、本机存储、地址（A23：日志只记动作名和结果码） */
async function noSecrets(page: Page): Promise<void> {
  // 运行日志隔一会儿才存进 localStorage（run-log.ts 的 SAVE_MS），读一次可能还没落盘：等到“create ok”那行出现再整段读
  await expect.poll(() => runLog(page), { timeout: 10_000 }).toMatch(/invite create ok/);
  const log = await runLog(page);
  for (const s of [CODE, 'K7Q2-M9XD', NOTE]) expect(log).not.toContain(s);
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
  expect(stored).not.toContain(CODE);
  expect(stored).not.toContain(NOTE);
  expect(page.url()).not.toContain(CODE);
}

test.describe('设置 › 邀请朋友（R-83）', () => {
  test('① 管理员：首页一行 → 备注说明 → 生成 → 4 位一组、复制 → 列表多一条', async ({ page, baseURL, browserName }) => {
    if (browserName === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const fake = await fakeServer(page, baseURL, true);
    await openSettings(page);
    const entry = page.getByTestId('settings-invite-entry');
    await expect(entry).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('settings-invite-summary')).toHaveText('发邀请码');
    // 在“更多”卡里、“AI 服务商”下面
    await expect(page.getByTestId('settings-card-more').getByTestId('settings-invite-entry')).toHaveCount(1);
    const order = await page.getByTestId('settings-card-more').locator('[data-row-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-row-id')));
    expect(order.indexOf('invite')).toBe(order.indexOf('aiProvider') + 1);
    await entry.scrollIntoViewIfNeeded();
    await shot(page, browserName, '01-设置首页-管理员-邀请朋友一行');

    await entry.click();
    await expect(page.getByTestId('invite-page')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('invite-note-tip')).toHaveText('只写编号或日期，例如“3 号”“10-29”，不要写名字。最多 40 个字。');
    await expect(page.getByTestId('invite-row')).toHaveCount(2);
    await expect(page.getByTestId('invite-row').first()).toContainText('11-25');
    await expect(page.getByTestId('invite-row').first().getByTestId('invite-row-used')).toHaveText('已用');
    await expect(page.getByTestId('invite-row').nth(1)).toContainText('没写备注');
    await shot(page, browserName, '02-邀请朋友-生成前');

    await page.getByTestId('invite-note').fill(NOTE);
    await page.getByTestId('invite-create').click();
    await expect(page.getByTestId('invite-code')).toHaveText('K7Q2-M9XD-4TPA', { timeout: 10_000 });
    await expect(page.getByTestId('invite-fresh-tip')).toContainText('7 天内有效');
    await expect(page.getByTestId('invite-fresh-tip')).toContainText('只能用一次');
    await expect(page.getByTestId('invite-fresh-tip')).toContainText('只显示这一次');
    await expect(page.getByTestId('invite-note')).toHaveValue('');
    expect(fake.calls.filter((c) => c['action'] === 'create')).toEqual([{ action: 'create', note: NOTE }]);
    // 列表重读，多了刚发的这一条（7 天后过期，排在最前）
    await expect(page.getByTestId('invite-row')).toHaveCount(3);
    await expect(page.getByTestId('invite-row').first()).toContainText(NOTE);
    await expect(page.getByTestId('invite-row').first().getByTestId('invite-row-used')).toHaveText('还没用');

    await page.getByTestId('invite-copy').click();
    if (browserName === 'chromium') {
      await expect(page.getByTestId('invite-copy-status')).toHaveText('已复制');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('K7Q2-M9XD-4TPA');
    } else {
      // WebKit：写剪贴板可能被拒，拒了就把码选中
      await expect(page.getByTestId('invite-copy-status')).toHaveText(/^(已复制|没能自动复制，已经选中，请手动复制)$/);
      if ((await page.getByTestId('invite-copy-status').textContent())?.startsWith('没能')) {
        expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('K7Q2-M9XD-4TPA');
      }
    }
    await page.getByTestId('invite-code').scrollIntoViewIfNeeded();
    await shot(page, browserName, '03-邀请朋友-生成后');
    await noSecrets(page);
  });

  test('② 普通人：首页没有“邀请朋友”，也不调 invite-admin', async ({ page, baseURL }) => {
    const fake = await fakeServer(page, baseURL, false);
    await openSettings(page);
    // “我的 AI”有值了 = mine 已经读回来（同一个判断）
    await expect(page.getByTestId('settings-my-ai-summary')).toHaveText('柠檬记提供 · 0 / 50', { timeout: 15_000 });
    await expect(page.getByTestId('settings-invite-entry')).toHaveCount(0);
    await expect(page.getByTestId('settings-ai-provider-entry')).toHaveCount(0);
    expect(fake.calls).toHaveLength(0);
  });

  test('③ 每天 20 次用完：写“明天再试”，不出码', async ({ page, baseURL }) => {
    const fake = await fakeServer(page, baseURL, true);
    fake.createReply = { status: 429, json: { error: 'rate_limited' } };
    await page.goto('/app/#/settings/invite');
    await expect(page.getByTestId('invite-page')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('invite-create').click();
    await expect(page.getByTestId('invite-err')).toHaveText('今天已经发了 20 个，明天再试');
    await expect(page.getByTestId('invite-code')).toHaveCount(0);
  });
});

test.describe('设置 › 邀请朋友 › 作废（负责人 11-27）', () => {
  test('⑤ 还没用的才有“作废” → 页面里的确认框 → 取消不发 → 确认后那一行消失、写“已作废”', async ({ page, baseURL, browserName }) => {
    const fake = await fakeServer(page, baseURL, true);
    let nativeDialog = false;
    page.on('dialog', (d) => {
      nativeDialog = true;
      void d.dismiss();
    });
    await page.goto('/app/#/settings/invite');
    await expect(page.getByTestId('invite-page')).toBeVisible({ timeout: 30_000 });
    const rows = page.getByTestId('invite-row');
    await expect(rows).toHaveCount(2, { timeout: 10_000 });
    // 已用的（11-25）不能滑；还没用的（没写备注）左滑露出红色“作废”（同待办左滑删除，负责人 11-27“做成像删除一样，左滑作废”）
    await expect(rows.first().getByTestId('invite-revoke')).toHaveCount(0);
    await expect(rows.first().locator('[data-swipe-face]')).toHaveCount(0);
    // 行里不再有文字按钮：两行一样高（不含分隔线：第一行底下有 0.5 的线，最后一行没有）
    const h = (i: number) => rows.nth(i).evaluate((el) => el.getBoundingClientRect().height - parseFloat(getComputedStyle(el).borderBottomWidth));
    expect(Math.abs((await h(1)) - (await h(0)))).toBeLessThanOrEqual(0.5);
    await page.getByTestId('invite-list').scrollIntoViewIfNeeded();
    await shot(page, browserName, '05-邀请朋友-列表');
    const swipeOpen = async (): Promise<void> => {
      await rows.nth(1).locator('[data-swipe-face]').waitFor({ state: 'attached' });
      const b = await rows.nth(1).boundingBox();
      if (b === null) throw new Error('作废那一行没有框');
      await touchSwipe(page, { x: b.x + b.width - 30, y: b.y + Math.min(b.height / 2, 22) }, b.width * 0.3);
      await expect(rows.nth(1)).toHaveAttribute('data-swipe', 'open');
    };
    await swipeOpen();
    const btn = rows.nth(1).getByTestId('invite-revoke');
    await expect(btn).toHaveText('作废');
    await expect(btn).toBeVisible();
    // 设置卡里只裁到行自己的框：滑开的行面不画出卡片左边、不盖住最后一行的左下圆角（SwipeRow 默认往左多留 16，卡片内边距只有 14）
    await expect(rows.nth(1)).toHaveCSS('clip-path', 'inset(0px)');
    await shot(page, browserName, '05b-邀请朋友-左滑露出作废');

    await btn.click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('作废“没写备注”这个邀请码？');
    await expect(dlg).toContainText('马上不能再用来注册');
    await shot(page, browserName, '06-邀请朋友-作废确认');
    await page.getByTestId('invite-revoke-confirm-cancel').click();
    await expect(dlg).toHaveCount(0);
    expect(fake.calls.filter((c) => c['action'] === 'revoke')).toEqual([]);
    await expect(rows).toHaveCount(2);

    // 点过按钮后行会收起：再滑一次
    if ((await rows.nth(1).getAttribute('data-swipe')) !== 'open') await swipeOpen();
    await btn.click();
    await page.getByTestId('invite-revoke-confirm-ok').click();
    await expect(page.getByTestId('invite-revoke-status')).toHaveText('已作废，这个码不能再用来注册了');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('11-25');
    expect(fake.calls.filter((c) => c['action'] === 'revoke')).toEqual([{ action: 'revoke', id: 'bbbb0002' }]);
    expect(nativeDialog).toBe(false);
    await shot(page, browserName, '07-邀请朋友-作废之后');

    // 运行日志隔一会儿才落盘：等到“revoke ok”那行出现再整段读；只有动作名和结果码
    await expect.poll(() => runLog(page), { timeout: 10_000 }).toMatch(/invite revoke ok ms=/);
    expect(await runLog(page)).not.toContain('bbbb0002');
  });
});

test.describe('网页版宽屏 › 邀请朋友', () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false });

  test('④ 左目录“数据”一组里有“邀请朋友”，点进去右边详情是二级页', async ({ page, baseURL, browserName }) => {
    await fakeServer(page, baseURL, true);
    await openSettings(page);
    await page.getByTestId('settings-dk-nav-data').click();
    const entry = page.getByTestId('settings-dk-group-data').getByTestId('settings-invite-entry');
    await expect(entry).toBeVisible({ timeout: 15_000 });
    await entry.click();
    await expect(page.getByTestId('settings-dk-detail').getByTestId('invite-page')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('settings-dk-nav-data')).toHaveAttribute('aria-current', 'true');
    await page.getByTestId('invite-note').fill('3 号');
    await page.getByTestId('invite-create').click();
    await expect(page.getByTestId('invite-code')).toHaveText('K7Q2-M9XD-4TPA', { timeout: 10_000 });
    await shot(page, browserName, '04-宽屏-邀请朋友-生成后');
  });
});
