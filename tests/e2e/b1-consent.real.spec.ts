// TC-B1-11（R-103；15.5）：登录后的告知与同意页关口——AI 同意项默认不勾；不勾也能进 App（E2E-REAL 第 5 步新写，10-30 补 ③ ④）
// npm run e2e:real 跑：createAccount + loginViaOtp → 打开 /app/ → 启动时的告知页关口（src/app/root.tsx 的 GatedApp → features/onboarding 的 ConsentGate）。
// 关口按 noticeState()（features/onboarding/data/consent-api.ts）分四路：
//   first（profiles.consent_policy_ver 为空）→ 显示告知页；
//   updated（有值且低于 notice.min_consent_ver）→ 显示“隐私说明更新了”那一屏（ConsentPage variant="updated"，data-step="policy-update"，CONSENT-updated）；
//   none（其余）→ 放行；读失败 → 放行。
// lemo-e2e 的 app_config.notice 由迁移写好；用例只读它（readNotice），不改全局 app_config（fullyParallel 下会影响别的用例）。
// “不勾点同意并继续”的实际行为（源码 hooks/useConsent.ts 的 submit：agree && !checked 直接 return）：什么也不做——不发 record_consent、
//   停在告知页。“不勾也能进 App”走的是“先不同意，直接用”。
// 用例之间不互相依赖，每条自己建账号。
import { type Page } from '@playwright/test';
import { expect, test } from './csp-fixture.ts';
import { createAccount, loginViaOtp, readNotice, restInPage } from './real-backend.ts';

const CONSENT = 'main[data-feature="onboarding"][data-step="consent"]';
const UPDATE = 'main[data-feature="onboarding"][data-step="policy-update"]';
const APP = 'main[data-feature]:not([data-feature="onboarding"])';

/** 从现在起数本页发出的 POST rpc/record_consent */
function countRecordConsent(page: Page): () => number {
  let n = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/sb/rest/v1/rpc/record_consent')) n += 1;
  });
  return () => n;
}

test.describe('TC-B1-11 告知与同意页（登录后的关口）', () => {
  test('① first：AI 同意默认不勾；不勾点“同意并继续”什么也不做；点“先不同意，直接用”进 App，服务器记下看过这一版、没有同意时间', async ({ page }) => {
    const { policyVer } = await readNotice();
    const acc = await createAccount();
    await loginViaOtp(page, acc.email);
    const recorded = countRecordConsent(page);
    await page.goto('/app/');

    const consent = page.locator(CONSENT);
    await expect(consent).toBeVisible();
    const check = consent.getByRole('checkbox', { name: '我同意把上面这些交给谷歌 AI 处理' });
    await expect(check).not.toBeChecked();
    const agree = consent.getByRole('button', { name: '同意并继续' });
    await expect(agree).toHaveAttribute('aria-disabled', 'true');
    // 没勾时按钮仍可聚焦（只标 aria-disabled，读屏读得到为什么不能点）：以后改成原生 disabled 这条会拦住
    await expect(agree).not.toHaveAttribute('disabled');
    await expect(consent.getByText('先勾选上面的同意，才能点“同意并继续”')).toBeVisible();

    // 真点一下：按钮只标 aria-disabled（不是 disabled，仍可聚焦、能点到），Playwright 把 aria-disabled 当成不可操作会一直等，所以 force
    await agree.click({ force: true });
    await page.waitForTimeout(1_000);   // 真要发请求的话早就发出去了
    expect(recorded(), '不勾点“同意并继续”不该发 record_consent').toBe(0);
    await expect(consent).toBeVisible();
    await expect(check).not.toBeChecked();
    await expect(page.locator(APP)).toHaveCount(0);

    const resp = page.waitForResponse((r) => r.url().includes('/sb/rest/v1/rpc/record_consent') && r.request().method() === 'POST');
    await consent.getByRole('button', { name: '先不同意，直接用' }).click();
    expect((await resp).status()).toBeLessThan(300);
    expect(recorded()).toBe(1);

    // 进了 App：告知页没了，主界面出来了，不在登录页
    await expect(consent).toHaveCount(0);
    await expect(page.locator(APP).first()).toBeVisible();
    expect(new URL(page.url()).pathname).not.toMatch(/^\/app\/auth\//);

    // 服务器：记下看过的版本（就是 lemo-e2e 里 notice 的那一版），consent_ai_at 为空（没同意）
    const prof = await restInPage(page, 'GET', '/rest/v1/profiles?select=consent_ai_at,consent_policy_ver');
    expect(prof.status).toBe(200);
    expect(prof.body).toEqual([{ consent_ai_at: null, consent_policy_ver: policyVer }]);

    // 再打开不再弹告知页（看过的同一版不再问）
    await page.reload();
    await expect(page.locator(APP).first()).toBeVisible();
    await expect(consent).toHaveCount(0);
  });

  test('② 对照：勾上以后“同意并继续”能点，进 App，服务器记下同意时间', async ({ page }) => {
    const { policyVer } = await readNotice();
    const acc = await createAccount();
    await loginViaOtp(page, acc.email);
    await page.goto('/app/');
    const consent = page.locator(CONSENT);
    await expect(consent).toBeVisible();
    await consent.getByRole('checkbox', { name: '我同意把上面这些交给谷歌 AI 处理' }).check();
    const agree = consent.getByRole('button', { name: '同意并继续' });
    await expect(agree).toHaveAttribute('aria-disabled', 'false');
    await agree.click();
    await expect(consent).toHaveCount(0);
    await expect(page.locator(APP).first()).toBeVisible();
    const prof = await restInPage(page, 'GET', '/rest/v1/profiles?select=consent_ai_at,consent_policy_ver');
    expect(prof.body).toEqual([{ consent_ai_at: expect.any(String), consent_policy_ver: policyVer }]);
  });

  test('③ updated：看过的版本（2026-01-01）低于 min_consent_ver，先显示“隐私说明更新了”、不画主界面；点“先不同意，直接用”进 App，服务器把看过的版本记成当前这一版', async ({ page }) => {
    // CONSENT-updated 改过（10-30）：以前这条断言“直接放行”；真后端组待明早清单第 34 条后补跑
    const OLD_VER = '2026-01-01';
    const { policyVer, minConsentVer } = await readNotice();
    // 前提：lemo-e2e 里 min_consent_ver 有值且比 OLD_VER 新，否则这条测到的就是 none 而不是 updated
    expect(minConsentVer, 'lemo-e2e 的 notice.min_consent_ver').not.toBeNull();
    expect((minConsentVer ?? '') > OLD_VER, `min_consent_ver（${minConsentVer}）应晚于 ${OLD_VER}`).toBe(true);

    const acc = await createAccount({ consentPolicyVer: OLD_VER });
    await loginViaOtp(page, acc.email);
    const recorded = countRecordConsent(page);
    await page.goto('/app/');

    const update = page.locator(UPDATE);
    await expect(update).toBeVisible();
    await expect(update.getByRole('heading', { level: 1 })).toHaveText('隐私说明更新了');
    await expect(page.locator(CONSENT)).toHaveCount(0);
    await expect(page.locator(APP)).toHaveCount(0);
    const check = update.getByRole('checkbox', { name: '我同意更新后的内容' });
    await expect(check).not.toBeChecked();
    await expect(update.getByRole('button', { name: '同意并继续' })).toHaveAttribute('aria-disabled', 'true');
    expect(recorded()).toBe(0);

    const resp = page.waitForResponse((r) => r.url().includes('/sb/rest/v1/rpc/record_consent') && r.request().method() === 'POST');
    await update.getByRole('button', { name: '先不同意，直接用' }).click();
    expect((await resp).status()).toBeLessThan(300);
    expect(recorded()).toBe(1);

    await expect(update).toHaveCount(0);
    await expect(page.locator(APP).first()).toBeVisible();
    const prof = await restInPage(page, 'GET', '/rest/v1/profiles?select=consent_ai_at,consent_policy_ver');
    expect(prof.body).toEqual([{ consent_ai_at: null, consent_policy_ver: policyVer }]);
    // record_consent 的撤回分支（revoke=true）把 ai.enabled 写成 'false'（value 是 jsonb，REST 读回来是布尔 false）
    const ai = await restInPage(page, 'GET', '/rest/v1/settings?select=value&key=eq.ai.enabled');
    expect(ai.status).toBe(200);
    expect(ai.body).toEqual([{ value: false }]);

    // 再打开一次：版本已记成当前这一版，更新页不再出（不会每次打开都弹）
    await page.reload();
    await expect(page.locator(APP).first()).toBeVisible();
    await expect(page.locator('main[data-feature="onboarding"]')).toHaveCount(0);
    expect(recorded()).toBe(1);
  });

  test('④ none：看过的就是 lemo-e2e 里当前这一版，不出告知页、不发 record_consent，profiles 的 consent_policy_ver 不变', async ({ page }) => {
    const { policyVer } = await readNotice();   // 从库里读，不写死日期
    const acc = await createAccount({ consentPolicyVer: policyVer });
    await loginViaOtp(page, acc.email);
    const recorded = countRecordConsent(page);
    await page.goto('/app/');

    await expect(page.locator(APP).first()).toBeVisible();
    await expect(page.locator('main[data-feature="onboarding"]')).toHaveCount(0);   // 告知页、更新页都不出
    expect(recorded()).toBe(0);
    const prof = await restInPage(page, 'GET', '/rest/v1/profiles?select=consent_ai_at,consent_policy_ver');
    expect(prof.status).toBe(200);
    expect(prof.body).toEqual([{ consent_ai_at: null, consent_policy_ver: policyVer }]);
  });
});
