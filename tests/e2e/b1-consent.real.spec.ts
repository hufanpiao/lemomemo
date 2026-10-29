// TC-B1-11（R-103；15.5）：新账号首次登录看告知与同意页——AI 同意项默认不勾；不勾也能进 App（E2E-REAL 第 5 步新写）
// npm run e2e:real 跑：createAccount（profiles 行的 consent_policy_ver 为空）+ loginViaOtp → 打开 /app/ →
// 启动时的告知页关口（src/app/root.tsx 的 GatedApp → features/onboarding 的 ConsentGate，接手清单 CONSENT-wire ②）显示告知页。
// lemo-e2e 的 app_config.notice 由迁移 20261029210000_core_settings_ai_guard.sql 写好（policy_ver = 2026-10-29），所以走正常的两个按钮，不是 no_policy。
// 用例之间不互相依赖，每条自己建账号。
import { expect, test } from './csp-fixture.ts';
import { createAccount, loginViaOtp, restInPage } from './real-backend.ts';

test.describe('TC-B1-11 告知与同意页（新账号首次登录）', () => {
  test('AI 同意默认不勾；“同意并继续”不勾点不了；点“先不同意，直接用”进 App，服务器记下看过这一版、没有同意时间', async ({ page }) => {
    const acc = await createAccount();
    await loginViaOtp(page, acc.email);
    await page.goto('/app/');

    const consent = page.locator('main[data-feature="onboarding"][data-step="consent"]');
    await expect(consent).toBeVisible();
    const check = consent.getByRole('checkbox', { name: '我同意把上面这些交给谷歌 AI 处理' });
    await expect(check).not.toBeChecked();
    // 不勾时“同意并继续”标着 aria-disabled，点了也不写（不发 record_consent），页面还在
    const agree = consent.getByRole('button', { name: '同意并继续' });
    await expect(agree).toHaveAttribute('aria-disabled', 'true');
    await expect(consent.getByText('先勾选上面的同意，才能点“同意并继续”')).toBeVisible();

    const recorded = page.waitForResponse((r) => r.url().includes('/sb/rest/v1/rpc/record_consent') && r.request().method() === 'POST');
    await consent.getByRole('button', { name: '先不同意，直接用' }).click();
    expect((await recorded).status()).toBeLessThan(300);

    // 进了 App：告知页没了，主界面出来了，不在登录页
    await expect(consent).toHaveCount(0);
    await expect(page.locator('main[data-feature]:not([data-feature="onboarding"])').first()).toBeVisible();
    expect(new URL(page.url()).pathname).not.toMatch(/^\/app\/auth\//);

    // 服务器：记下看过的版本，consent_ai_at 为空（没同意）
    const prof = await restInPage(page, 'GET', '/rest/v1/profiles?select=consent_ai_at,consent_policy_ver');
    expect(prof.status).toBe(200);
    expect(prof.body).toEqual([{ consent_ai_at: null, consent_policy_ver: '2026-10-29' }]);

    // 再打开不再弹告知页（看过的同一版不再问）
    await page.reload();
    await expect(page.locator('main[data-feature]').first()).toBeVisible();
    await expect(consent).toHaveCount(0);
  });

  test('对照：勾上以后“同意并继续”能点，进 App，服务器记下同意时间', async ({ page }) => {
    const acc = await createAccount();
    await loginViaOtp(page, acc.email);
    await page.goto('/app/');
    const consent = page.locator('main[data-feature="onboarding"][data-step="consent"]');
    await expect(consent).toBeVisible();
    await consent.getByRole('checkbox', { name: '我同意把上面这些交给谷歌 AI 处理' }).check();
    const agree = consent.getByRole('button', { name: '同意并继续' });
    await expect(agree).toHaveAttribute('aria-disabled', 'false');
    await agree.click();
    await expect(consent).toHaveCount(0);
    await expect(page.locator('main[data-feature]:not([data-feature="onboarding"])').first()).toBeVisible();
    const prof = await restInPage(page, 'GET', '/rest/v1/profiles?select=consent_ai_at,consent_policy_ver');
    expect(prof.body).toEqual([{ consent_ai_at: expect.any(String), consent_policy_ver: '2026-10-29' }]);
  });
});
