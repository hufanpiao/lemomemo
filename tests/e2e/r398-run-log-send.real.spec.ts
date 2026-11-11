// R-398 真后端实测：设置 › 关于 › 诊断里的“Send run log”一键发送（npm run e2e:real 跑；构建是 e2e-real，非正式版）
// • 发送：点一下 → 按钮变 Sent；服务器 public.diag_logs 里有本人这一行，正文是全局运行日志（有 start 行、不含刚才输入的待办标题）
// • 再发：还是一行（覆盖），sent_at 变新
// • 别人：另一个账号用自己的令牌读不到这一行（RLS）
import { type Page } from '@playwright/test';
import { expect, test } from './csp-fixture.ts';
import { createAccount, loginViaOtp, realBackend } from './real-backend.ts';

test.setTimeout(180_000);

const SECRET_TITLE = 'R398 这段文字不许进日志';
// 按钮字照 src/features/settings/ui/VhProbe.tsx 的 RL_SEND、RL_SEND_LABEL.ok（组件带样式模块，Playwright 里不直接 import）
const RL_SEND = 'Send run log';
const RL_SENT = 'Sent';

async function openApp(page: Page): Promise<void> {
  await page.goto('/app/#/today');
  const consent = page.locator('main[data-feature="onboarding"][data-step="consent"]');
  const app = page.locator('main[data-feature]:not([data-feature="onboarding"])').first();
  await expect(consent.or(app)).toBeVisible({ timeout: 30_000 });
  if (await consent.isVisible()) await consent.getByRole('button', { name: '先不同意，直接用' }).click();
  await expect(app).toBeVisible({ timeout: 30_000 });
}

interface DiagRow { user_id: string; sent_at: string; app_version: string | null; body: string }

/** 服务器上的行：key 给 service key 就是后台读（不受 RLS），给用户令牌就是那个用户自己读 */
async function diagRows(bearer: string, filter = ''): Promise<DiagRow[]> {
  const b = realBackend();
  const r = await fetch(new URL(`/rest/v1/diag_logs?select=user_id,sent_at,app_version,body${filter}`, b.api), {
    headers: { apikey: bearer === b.serviceKey ? b.serviceKey : b.anonKey, Authorization: `Bearer ${bearer}` },
  });
  expect(r.status).toBe(200);
  return (await r.json()) as DiagRow[];
}

test('R398 一键发送运行日志：服务器收到本人一行、再发覆盖、别人读不到、不含输入的文字', async ({ page, browser }) => {
  const a = await createAccount();
  await loginViaOtp(page, a.email);
  await openApp(page);

  // 先在界面上输入一段文字（待办标题），后面核对日志里没有它
  await page.goto('/app/#/todo/new');
  const title = page.getByTestId('todo-edit-title');
  await expect(title).toBeVisible();
  await title.fill(SECRET_TITLE);
  await title.press('Tab');

  // 打开诊断：3 秒内连点“版本”5 下
  await page.goto('/app/#/settings/about');
  const ver = page.getByTestId('settings-about-version');
  await expect(ver).toBeVisible();
  for (let i = 0; i < 5; i++) await ver.click();
  const send = page.getByTestId('vh-rl-send');
  await expect(send).toHaveText(RL_SEND);

  const statuses: number[] = [];
  page.on('response', (r) => {
    if (/\/sb\/rest\/v1\/diag_logs/.test(r.url())) statuses.push(r.status());
  });

  // ① 发送
  await send.click();
  await expect(send).toHaveText(RL_SENT, { timeout: 30_000 });
  const b = realBackend();
  const first = await diagRows(b.serviceKey, `&user_id=eq.${a.userId}`);
  expect(first).toHaveLength(1);
  expect(first[0]?.body).toMatch(/=== start /);
  expect(first[0]?.body).toMatch(/click /);
  expect(first[0]?.body).not.toContain(SECRET_TITLE);
  expect(first[0]?.app_version).toMatch(/@/);

  // ② 再发：覆盖，还是一行，时间变新
  await page.waitForTimeout(1100);
  await page.getByTestId('vh-rl-clear').click();
  await expect(send).toHaveText(RL_SEND);
  await send.click();
  await expect(send).toHaveText(RL_SENT, { timeout: 30_000 });
  const second = await diagRows(b.serviceKey, `&user_id=eq.${a.userId}`);
  expect(second).toHaveLength(1);
  expect(Date.parse(second[0]?.sent_at ?? '')).toBeGreaterThan(Date.parse(first[0]?.sent_at ?? ''));

  // ③ 别人读不到
  const other = await createAccount();
  const ctx = await browser.newContext();
  const otherSession = await loginViaOtp(await ctx.newPage(), other.email);
  expect(await diagRows(otherSession.access_token)).toEqual([]);
  await ctx.close();

  console.log(`R398 证据：diag_logs 请求状态 ${JSON.stringify(statuses)}；第一份 ${first[0]?.body.length} 字、版本 ${first[0]?.app_version}；再发后仍 1 行；别的账号读到 0 行`);
});
