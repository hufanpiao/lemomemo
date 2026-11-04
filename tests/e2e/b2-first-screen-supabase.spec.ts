// B2 FA-6 ①：冷启动打开今天页，supabase-js 那一块（约 53 KB gzip）要在今天页画出来以后才下载
// • 启动关口的 noticeState 走快读（src/features/onboarding/data/consent-api.ts 的 createRestNoticeRead）：令牌还新鲜时直接 GET
//   /sb/rest/v1/profiles、/sb/rest/v1/app_config，不加载 supabase-js；session.ts 的 onAuthUser 等首屏画完、浏览器空闲才加载它。
// • 这里用 page.route 答这两张表（不连库），写一份 JWT 形状的假会话（exp 在很远的将来；令牌是一看就是假的字符串，不是密钥）。
// • 两种构建都要过：
//   – 带 supabase 地址的构建（VITE_PUBLIC_SUPABASE_URL = 同源 /sb）：走快读，两张表各被请求一次、带 Bearer；
//   – 假后端 e2e 的默认构建（没配 supabase 地址）：关口直接按读失败放行（envReady 为假），同样不在画出前下载 supabase-js。
// • 同步引擎（realtime 订阅、ensureSession、fetchConfig 都会 getSupabase()）在 main.tsx 里等首屏画完（src/platform/first-paint.ts）才起，
//   所以 supabase-js 那一块在今天页出现以后才下载（FA-6 ① 第二步，11-04）。
// • 只数关口那一对请求（profiles?select=consent_policy_ver、app_config?select=notice）：首屏画完后同步引擎会再读 profiles?select=*，不算。
//   每个请求都查：带 apikey（等于构建里的 anon key）、Bearer 令牌，只发往同源 /sb（安全审查 L5）；没有 supabase-js 的 x-client-info 头（安全复审 L8）。
// • 快读组（环境里有 VITE_PUBLIC_SUPABASE_URL）必须走快读：hits.profiles > 0，不许悄悄落到“没配地址”的分支（安全复审 L8）。
// • 默认的假后端 e2e 构建没配 supabase 地址，快读分支跑不到（只验证“直接放行、不下载”）；带地址的构建要另外构建（见交付说明）。
// • 怎么认出 supabase-js 那一块：响应里有 auth-js 的 "GoTrueClient@" 字样（文件名是 hash，不靠它）。
//   时间先后在页面里比（performance 的资源 startTime 对 MutationObserver 记下的今天页出现时刻），不用测试进程的时钟。
import type { Page, Request } from '@playwright/test';
import { expect, test } from './csp-fixture.ts';
import { FAKE_USER_ID, sessionKeyFor } from './session-fixture.ts';

const V = '2026-10-29';

/** JWT 形状的假令牌（只有 payload 有意义） */
function fakeJwt(): string {
  const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;
  return `${b64u({ alg: 'none' })}.${b64u({ exp, session_id: 'e2e-fa6-sid', sub: FAKE_USER_ID })}.e2e-fake-signature`;
}

type Hits = { profiles: number; notice: number; bearer: boolean; apikey: boolean; sameOrigin: boolean; noClientInfo: boolean };

/** 这一次的构建带了 supabase 地址（快读组 playwright.fastread.config.ts 强制设好，worker 继承）：必须走快读，不许退回“没配地址、直接放行”（安全复审 L8 ①） */
const EXPECT_FAST = Boolean(process.env['VITE_PUBLIC_SUPABASE_URL']);

async function prepare(page: Page, baseURL: string | undefined): Promise<{ hits: Hits }> {
  if (!baseURL) throw new Error('playwright.config 没给 baseURL');
  const now = Math.floor(Date.now() / 1000);
  const session = JSON.stringify({
    access_token: fakeJwt(), token_type: 'bearer', expires_in: 600, expires_at: now + 10 * 365 * 24 * 3600,
    refresh_token: 'fake-refresh-token-e2e-only',
    user: { id: FAKE_USER_ID, aud: 'authenticated', role: 'authenticated', email: 'e2e-fake@lemomemo.test' },
  });
  const key = sessionKeyFor(new URL('/sb', baseURL).href);
  await page.context().addInitScript(({ key, value }) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // 不透明来源没有 localStorage
    }
    // 今天页第一次出现的时刻（页面时钟）
    const w = window as unknown as { __todayAt?: number };
    new MutationObserver((_, obs) => {
      if (document.querySelector('[data-testid="today"]')) {
        w.__todayAt = performance.now();
        obs.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  }, { key, value: session });
  const hits: Hits = { profiles: 0, notice: 0, bearer: true, apikey: true, sameOrigin: true, noClientInfo: true };
  const origin = new URL(baseURL).origin;
  const check = (req: Request): void => {
    const h = req.headers();
    hits.bearer &&= (h['authorization'] ?? '').startsWith('Bearer ');
    // 带地址的构建里 anon key 是假值 fake-anon-key-e2e-only（见交付说明的构建命令）；只要求非空且和构建一致
    hits.apikey &&= Boolean(h['apikey']) && h['apikey'] === (process.env['VITE_PUBLIC_ANON_KEY'] ?? h['apikey']);
    const u = new URL(req.url());
    hits.sameOrigin &&= u.origin === origin && u.pathname.startsWith('/sb/rest/v1/');
    // supabase-js 发的请求都带 x-client-info（supabase-js/x.y.z）；快读是自己的 fetch，不该有（安全复审 L8 ①：证明这对请求不是 supabase-js 发的）
    hits.noClientInfo &&= h['x-client-info'] === undefined;
  };
  // 关口只读这一列；同步引擎首屏画完后读 profiles?select=* 不归这里管
  await page.route('**/rest/v1/profiles?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('select') !== 'consent_policy_ver') return route.fallback();
    hits.profiles += 1;
    check(route.request());
    await route.fulfill({ json: [{ consent_policy_ver: V }] });
  });
  await page.route('**/rest/v1/app_config?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('select') !== 'notice') return route.fallback();
    hits.notice += 1;
    check(route.request());
    return route.fulfill({ json: [{ notice: { policy_ver: V, min_consent_ver: V } }] });
  });
  return { hits };
}

test('启动关口不靠 supabase-js 读告知状态：带 supabase 地址的构建走快读（两张表各一次、带 Bearer），没带的直接放行（FA-6 ①）', async ({ page, baseURL }) => {
  const { hits } = await prepare(page, baseURL);
  const notices: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/rest/v1/app_config') && req.url().includes('select=notice')) notices.push(req.url());
  });
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today')).toBeVisible({ timeout: 30_000 });
  if (EXPECT_FAST) expect(hits.profiles, '带地址的构建必须走快读').toBeGreaterThan(0);
  if (hits.profiles > 0) {
    // 快读：supabase-js 不会再发同一对请求（它发的也会被这里的 route 接住、计数）
    await page.waitForTimeout(500);
    expect(hits).toEqual({ profiles: 1, notice: 1, bearer: true, apikey: true, sameOrigin: true, noClientInfo: true });
  } else {
    expect(notices).toEqual([]);
  }
  test.info().annotations.push({ type: 'FA-6 ①', description: hits.profiles > 0 ? 'fast-read' : 'env-missing' });
});

test('冷启动今天页：supabase-js 那一块在今天页画出来以后才下载（FA-6 ①）', async ({ page, baseURL }) => {
  const { hits } = await prepare(page, baseURL);
  const sbUrls: string[] = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.endsWith('.js') || !url.includes('/app/assets/')) return;
    try {
      if ((await res.text()).includes('GoTrueClient@')) sbUrls.push(url);
    } catch {
      // 页面已关闭
    }
  });
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today')).toBeVisible({ timeout: 30_000 });
  // 等首屏画完后的空闲加载（whenIdle）有机会发生，再比先后
  await page.waitForTimeout(2500);
  const r = await page.evaluate((urls) => {
    const at = (window as unknown as { __todayAt?: number }).__todayAt ?? null;
    const starts = performance.getEntriesByType('resource')
      .filter((e) => urls.includes(e.name))
      .map((e) => e.startTime);
    return { todayAt: at, sbStarts: starts };
  }, sbUrls);
  const viaFast = hits.profiles > 0;
  if (EXPECT_FAST) expect(viaFast, '带地址的构建必须走快读').toBe(true);
  test.info().annotations.push({
    type: 'FA-6 ①',
    description: `关口${viaFast ? '走快读' : '没走快读（构建没配 supabase 地址）'}；今天页出现 ${r.todayAt?.toFixed(0)} ms；supabase-js 块开始下载 ${r.sbStarts.map((s) => s.toFixed(0)).join('、') || '（等待期间没下载）'} ms`,
  });
  expect(r.todayAt, '记下了今天页出现的时刻').not.toBeNull();
  for (const s of r.sbStarts) expect(s, 'supabase-js 那一块不能在今天页出现之前开始下载').toBeGreaterThan(r.todayAt ?? Infinity);
  if (viaFast) {
    expect(hits).toEqual({ profiles: 1, notice: 1, bearer: true, apikey: true, sameOrigin: true, noClientInfo: true });
  } else {
    expect(hits.notice).toBe(0);
  }
});
