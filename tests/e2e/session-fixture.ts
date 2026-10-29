// E2E 共用的假会话夹具（K6 新入口：/app/ 读不到本机会话的 user_id 就直接跳 /app/auth/，不渲染今天页）
// 要测 App 页面本身的用例，在打开页面之前往 localStorage 写一份假的 supabase-js 会话：
//   • 键名：照 src/platform/session.ts 的 sessionStorageKey()，取 supabaseUrl 主机名的第一段 → `sb-<第一段>-auth-token`。
//     supabaseUrl 在正式、预览都是同源的 /sb，主机名和页面一样（官网 site/lp.js 也按页面主机名找）；
//     e2e 构建没设 VITE_PUBLIC_SUPABASE_URL 时 App 退回按 `sb-*-auth-token` 格式找，这个键名同样认。本机是 `sb-127-auth-token`。
//   • 内容：形状照 supabase-js 存的会话，user.id 是 uuid（readSessionUserId 只认 uuid）；expires_at 放到很远的将来，
//     免得 supabase-js 加载后去 /sb 刷新令牌（e2e 的 /sb 接的是假后端）。令牌都是一看就是假的字符串，不是密钥。
// 用法：
//   • 整组用：import { test } from './session-fixture.ts'，再在 describe 里 test.use({ loggedIn: true })；默认 false（不写会话），
//     所以“没登录就跳 /app/auth/”仍是默认行为（tests/e2e/session.spec.ts 测这一条）。
//   • 单条用：await seedFakeSession(page.context(), baseURL)，必须在 page.goto 之前。
import type { BrowserContext } from '@playwright/test';
import { expect, test as cspTest } from './csp-fixture.ts';

/** 假用户（uuid 格式，第 4 段 8 开头，和 session.ts 的 UUID_RE 一致） */
export const FAKE_USER_ID = '0e2e0000-0000-4000-8000-000000000001';

/** 和 src/platform/session.ts 的 sessionStorageKey() 同一个取法：主机名第一段 */
export function sessionKeyFor(supabaseUrl: string): string {
  const first = new URL(supabaseUrl).hostname.split('.')[0];
  if (!first) throw new Error(`读不出主机名：${supabaseUrl}`);
  return `sb-${first}-auth-token`;
}

/** 一份形状正确的假会话 JSON */
export function fakeSessionJson(userId: string = FAKE_USER_ID): string {
  const now = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    access_token: 'fake-access-token-e2e-only',
    token_type: 'bearer',
    expires_in: 600,
    expires_at: now + 10 * 365 * 24 * 3600,
    refresh_token: 'fake-refresh-token-e2e-only',
    user: { id: userId, aud: 'authenticated', role: 'authenticated', email: 'e2e-fake@lemomemo.test' },
  });
}

/** 这个上下文里之后打开的每个页面，在页面脚本之前写入假会话 */
export async function seedFakeSession(context: BrowserContext, baseURL: string | undefined, userId: string = FAKE_USER_ID): Promise<void> {
  if (!baseURL) throw new Error('playwright.config 没给 baseURL');
  const key = sessionKeyFor(new URL('/sb', baseURL).href);
  await context.addInitScript(
    ({ key, value }) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        // about:blank 等不透明来源没有 localStorage，跳过
      }
    },
    { key, value: fakeSessionJson(userId) },
  );
}

export const test = cspTest.extend<{ loggedIn: boolean; fakeSession: void }>({
  loggedIn: [false, { option: true }],
  fakeSession: [
    async ({ loggedIn, context, baseURL }, use) => {
      if (loggedIn) await seedFakeSession(context, baseURL);
      await use();
    },
    { auto: true },
  ],
});

export { expect };
