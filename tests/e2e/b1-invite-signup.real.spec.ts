// B1 邀请注册的真后端用例（接手清单 INVITE-mailpit，E2E-REAL ⑦；架构 5.6；测试用例 v4 TC-B1-02～04 的真后端一半）
// npm run e2e:real 跑（playwright.real.config.ts）：/sb 接 lemo-e2e，invite-signup 是真函数、真库。
// 出站两处换成 lemo-e2e 里的假出站服务（tools/e2e/fake-outbound-fn.mjs，real-backend.mjs 的 E2E_FUNCTIONS_ENV 指过去）：
//   siteverify 总回成功（hostname 127.0.0.1、action invite_start）；Resend 发信转进 lemo-e2e 的 Mailpit——验证码信真的进 Mailpit 再取回来。
// 走一遍：没注册的邮箱 → 发验证码（GoTrue 回“还没注册”）→ 填邀请码、下一步（start 带 Turnstile 令牌，过 siteverify）
//   → 从 Mailpit 取 6 位码填进去（填满自动提交，verify 建账号、回 token_hash）→ 回到 App（首次登录先过告知页关口）。
// 邀请码由本用例用 service role 直接写进 private.invites（只存哈希，同 invite-admin 的口径），每次随机，用过就作废，不影响别的用例。
// Turnstile 小窗换成假脚本（不连 Cloudflare）。验证码、令牌、密钥都不打印、不截图。
import { createHash, randomInt } from 'node:crypto';
import { expect, test } from './csp-fixture.ts';
import { otpFromMailpit, realBackend, sessionKeyFor } from './real-backend.ts';
import { emailBox, fakeTurnstile } from './ua-emulation.ts';

// 和 supabase/functions/_shared/invite-code.ts 同一个口径（那份是 Deno 源码，按本配置的 DOM 类型编译不过，不直接 import）：
// 12 位、32 个字符的字母表；code_hash = sha256("invite:" + 码) 的十六进制
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_LEN = 12;
const inviteCodeHash = (code: string): string => createHash('sha256').update(`invite:${code}`).digest('hex');

/** 用 service role 直连 lemo-e2e 的 PostgREST 读写 private 表（Content-Profile / Accept-Profile: private）；只发到 LEMO_E2E_SB_API */
async function privateRest(path: string, init: { method: string; body?: unknown }): Promise<Response> {
  const b = realBackend();
  const url = new URL(path, b.api);
  if (url.origin !== b.api.origin) throw new Error('只许发到 LEMO_E2E_SB_API');
  return fetch(url, {
    method: init.method,
    headers: {
      apikey: b.serviceKey,
      Authorization: `Bearer ${b.serviceKey}`,
      'Content-Type': 'application/json',
      'Content-Profile': 'private',
      'Accept-Profile': 'private',
      Prefer: 'return=minimal',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/** 发一个一次性邀请码（1 次、1 天有效）；返回码原文 */
async function createInvite(): Promise<{ code: string; hash: string }> {
  const code = Array.from({ length: INVITE_LEN }, () => INVITE_ALPHABET.charAt(randomInt(INVITE_ALPHABET.length))).join('');
  const hash = inviteCodeHash(code);
  const r = await privateRest('/rest/v1/invites', {
    method: 'POST',
    body: { code_hash: hash, max_uses: 1, used_count: 0, expires_at: new Date(Date.now() + 86_400_000).toISOString() },
  });
  expect(r.status, '写 private.invites').toBe(201);
  return { code, hash };
}

async function inviteUsedCount(hash: string): Promise<number | null> {
  const r = await privateRest(`/rest/v1/invites?select=used_count&code_hash=eq.${hash}`, { method: 'GET' });
  const rows = (await r.json()) as { used_count?: number }[];
  return rows[0]?.used_count ?? null;
}

test.describe('邀请注册（真 invite-signup；Turnstile、Resend 走 lemo-e2e 的假出站服务）', () => {
  test('没注册的邮箱：填邀请码过 Turnstile、验证码信真的进 Mailpit、取码完成注册并登录', async ({ page }) => {
    const { code, hash } = await createInvite();
    const email = `e2e-inv-${randomInt(1e9).toString(36)}@lemomemo.test`;
    await fakeTurnstile(page);
    await page.goto('/app/auth/');
    await emailBox(page).fill(email);
    await page.getByRole('button', { name: '发验证码' }).click();
    // GoTrue 回“还没注册”（enable_signup = false）→ 换成邀请码那一屏
    await expect(page.getByText('这个邮箱还没注册，需要邀请码')).toBeVisible();
    await page.getByRole('textbox', { name: '邀请码' }).fill(code);

    // start：带上 Turnstile 令牌，过 siteverify（假服务回成功）；不过的话是 403 captcha_failed
    const startResp = page.waitForResponse((r) => r.url().endsWith('/sb/functions/v1/invite-signup') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '下一步' }).click();
    const start = await startResp;
    const sent = start.request().postDataJSON() as { step?: unknown; captchaToken?: unknown };
    expect(sent.step).toBe('start');
    expect(typeof sent.captchaToken === 'string' && sent.captchaToken !== '').toBe(true);
    expect(start.status()).toBe(200);
    expect(await start.json()).toEqual({ ok: true });
    await expect(page.getByText('邀请码有效的话，6 位验证码会发到这个邮箱')).toBeVisible();

    // 验证码信真的发到 Mailpit（假 Resend 转过去的），取回来填上：填满 6 位自动提交
    const otp = await otpFromMailpit(email);
    const verifyResp = page.waitForResponse((r) => r.url().endsWith('/sb/functions/v1/invite-signup') && r.request().method() === 'POST');
    await page.getByRole('textbox', { name: '邮箱里的 6 位验证码' }).fill(otp);
    const verify = await verifyResp;
    expect((verify.request().postDataJSON() as { step?: unknown }).step).toBe('verify');
    expect(verify.status()).toBe(200);

    // 回到 App（首次登录先过告知页关口），会话归这个新账号
    await expect(page).toHaveURL(/\/app\/(#\/.*)?$/);
    await expect(page.locator('main[data-feature]').first()).toBeVisible();
    expect(new URL(page.url()).pathname).not.toMatch(/^\/app\/auth\//);
    const key = sessionKeyFor(new URL('/sb', page.url()).href);
    const sessionEmail = await page.evaluate((k) => {
      const raw = localStorage.getItem(k);
      return raw ? ((JSON.parse(raw) as { user?: { email?: string } }).user?.email ?? null) : null;
    }, key);
    expect(sessionEmail).toBe(email);
    // 邀请码被占用了一次（用过就作废）
    expect(await inviteUsedCount(hash)).toBe(1);
  });
});
