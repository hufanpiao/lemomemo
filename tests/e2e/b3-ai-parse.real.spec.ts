// 打字条真的调到 ai-parse（B3 FA-2、Q2；src/features/plus/data/ai-parse-api.ts）：npm run e2e:real 跑，lemo-e2e 真后端。
// 最短路径：建号 → 登录 → 告知页勾上同意（ai.enabled = true）→ 待办页点“＋”打“买牛奶”回车
// → 页面真的 POST 到 /functions/v1/ai-parse（带 JWT、X-App-Version）→ 回 200 → 记下“买牛奶”，服务器 todos 里有这一行。
// 不花真钱、不用真密钥：lemo-e2e 的函数环境没有 GEMINI_API_KEY，出站走假代理；这里只认 200 的本机规则分支
// （consent_required / fallback），不认 record——拿到 record 说明碰到了真的 AI 服务商，用例直接挂
import { expect, test } from '@playwright/test';
import { createAccount, loginViaOtp, restInPage } from './real-backend.ts';

const CONSENT = 'main[data-feature="onboarding"][data-step="consent"]';
const APP = 'main[data-feature]:not([data-feature="onboarding"])';

test.use({ viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Seoul' });

test('打字条 → ai-parse 真后端：回 200 走本机规则，记下“买牛奶”，服务器有这一行', async ({ page }) => {
  const acc = await createAccount();
  await loginViaOtp(page, acc.email);
  await page.goto('/app/');
  const consent = page.locator(CONSENT);
  await expect(consent).toBeVisible();
  await consent.getByRole('checkbox', { name: '我同意把上面这些交给谷歌 AI 处理' }).check();
  await consent.getByRole('button', { name: '同意并继续' }).click();
  await expect(consent).toHaveCount(0);
  await expect(page.locator(APP).first()).toBeVisible();

  await page.goto('/app/#/todos');
  await expect(page.getByTestId('todos')).toBeVisible();
  await page.getByTestId('tabbar-add').click();
  await expect(page.getByTestId('type-bar')).toBeVisible({ timeout: 10_000 });

  const resp = page.waitForResponse((r) => r.url().includes('/functions/v1/ai-parse') && r.request().method() === 'POST');
  await page.getByTestId('type-input').fill('买牛奶');
  await page.keyboard.press('Enter');
  const r = await resp;
  const headers = r.request().headers();
  expect(headers['authorization']).toMatch(/^Bearer .+/);
  expect(headers['x-app-version']).toBeTruthy();
  expect(JSON.parse(r.request().postData() ?? '{}')).toMatchObject({ text: '买牛奶', scope: 'main' });
  expect(r.status()).toBe(200);
  const body = (await r.json()) as Record<string, unknown>;
  expect(body.intent, '碰到了真的 AI 服务商').toBeUndefined();
  expect(body.consent_required === true || body.fallback === true).toBe(true);

  await expect(page.getByTestId('type-notice')).toContainText('买牛奶');
  await expect(page.getByTestId('type-input')).toHaveValue('');

  await expect
    .poll(async () => {
      const rows = await restInPage(page, 'GET', '/rest/v1/todos?select=title,deleted_at,undone');
      return rows.body;
    }, { timeout: 15_000 })
    .toEqual([{ title: '买牛奶', deleted_at: null, undone: false }]);
});
