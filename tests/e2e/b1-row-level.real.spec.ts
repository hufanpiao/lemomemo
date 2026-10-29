// B1 接手清单 T1 的真登录端到端（TC-B0-89 里两条行级断言；E2E-REAL 第 5 步，从 b1-row-level.spec.ts 的 test.fixme 搬来）
// npm run e2e:real 跑：每个会话新开一个浏览器上下文，createAccount + loginViaOtp（不发信）换成真的会话 JWT，经同源 /sb 打 REST。
//   ① devices“只能动本会话那一行”：B 改删不到 A 的设备；A 的第二个会话改删不到第一个会话的设备；本会话那一行能改（对照）。
//   ② report_tz“只改自己的行”（N2；TC-B1-114 ③ 的“B 带 A 的 Da 调”经 public 包装那一半）：B 带 A 的 device_id 调 report_tz，
//      被拒（device_mismatch），A 的时区三列不变。直接调 private.report_tz_impl 的四步（anon、A、B、密码会话）归 TC-B1-114 的 pgTAP。
// 覆盖守门条（只读仓库文件）留在无后端组的 b1-row-level.spec.ts。用例之间不互相依赖，每条自己建账号。
import { type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { expect, test } from './csp-fixture.ts';
import { createAccount, loginViaOtp, restInPage } from './real-backend.ts';

/** 新开一个浏览器上下文（引擎默认的桌面环境），免发信登录后打开 /app/；同一邮箱再调一次就是第二个会话 */
async function newSession(browser: Browser, email: string): Promise<Page> {
  // 时区固定成 profiles 的默认值 Asia/Seoul：App 启动后自己的时区上报（K8 report-tz）只会得到 unchanged，不搅乱 ② 的“前后不变”
  const ctx = await browser.newContext({ timezoneId: 'Asia/Seoul' });
  const page = await ctx.newPage();
  await loginViaOtp(page, email);
  await page.goto('/app/');
  await expect(page.locator('main[data-feature]').first()).toBeVisible();
  return page;
}

test.describe('T1 真登录端到端（经 /sb，真会话 JWT）', () => {
  test('① devices：B 改删不到 A 的设备；A 的第二个会话改删不到第一个会话的设备；本会话那一行能改', async ({ browser }) => {
    const a = await createAccount();
    const b = await createAccount();
    const a1 = await newSession(browser, a.email);
    const a2 = await newSession(browser, a.email);
    const pb = await newSession(browser, b.email);

    const dev = randomUUID();
    const made = await restInPage(a1, 'POST', '/rest/v1/devices', { id: dev, platform: 'web', label: 'A 会话1' });
    expect(made.status).toBe(201);

    for (const [who, page] of [['B', pb], ['A 会话2', a2]] as const) {
      const p = await restInPage(page, 'PATCH', `/rest/v1/devices?id=eq.${dev}`, { label: `${who}改的` });
      expect([p.status, p.body], `${who} 改`).toEqual([200, []]);
      const d = await restInPage(page, 'DELETE', `/rest/v1/devices?id=eq.${dev}`);
      expect([d.status, d.body], `${who} 删`).toEqual([200, []]);
    }
    // B 连读都读不到 A 的设备（RLS 按 user_id）；A 的第二个会话读得到（同一账号），但改删不了
    expect((await restInPage(pb, 'GET', `/rest/v1/devices?id=eq.${dev}&select=label`)).body).toEqual([]);
    expect((await restInPage(a2, 'GET', `/rest/v1/devices?id=eq.${dev}&select=label`)).body).toEqual([{ label: 'A 会话1' }]);
    expect((await restInPage(a1, 'GET', `/rest/v1/devices?id=eq.${dev}&select=label`)).body).toEqual([{ label: 'A 会话1' }]);

    // 对照：本会话那一行能改
    const own = await restInPage(a1, 'PATCH', `/rest/v1/devices?id=eq.${dev}`, { label: '本机改的' });
    expect(own.status).toBe(200);
    expect(own.body).toEqual([expect.objectContaining({ id: dev, label: '本机改的' })]);
  });

  test('② report_tz：B 带 A 的 device_id 调被拒（device_mismatch），A 的时区三列不变', async ({ browser }) => {
    const a = await createAccount();
    const b = await createAccount();
    const pa = await newSession(browser, a.email);
    const pb = await newSession(browser, b.email);
    const dev = randomUUID();
    expect((await restInPage(pa, 'POST', '/rest/v1/devices', { id: dev, platform: 'web', label: 'A' })).status).toBe(201);
    const cols = '/rest/v1/profiles?select=current_tz,current_tz_device,current_tz_at';
    const before = await restInPage(pa, 'GET', cols);
    expect(before.status).toBe(200);

    // 连报两次（10 分钟内第二次同一个新时区才会采纳），两次都要被拒
    for (let i = 0; i < 2; i++) {
      const r = await restInPage(pb, 'POST', '/rest/v1/rpc/report_tz', { tz: 'Pacific/Kiritimati', device_id: dev, platform: 'web' });
      expect(r.status, `第 ${i + 1} 次`).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(r.body), `第 ${i + 1} 次`).toContain('device_mismatch');
    }
    expect((await restInPage(pa, 'GET', cols)).body).toEqual(before.body);

    // 对照：A 自己连报两次同一个新时区就采纳（证明上面的“不变”不是因为这个时区本来就收不进）
    for (const want of ['pending', 'accepted']) {
      const r = await restInPage(pa, 'POST', '/rest/v1/rpc/report_tz', { tz: 'Pacific/Kiritimati', device_id: dev, platform: 'web' });
      expect([r.status, r.body]).toEqual([200, want]);
    }
    expect((await restInPage(pa, 'GET', cols)).body).toEqual([expect.objectContaining({ current_tz: 'Pacific/Kiritimati', current_tz_device: dev })]);
  });
});
