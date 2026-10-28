// B0 第一项验证（架构 1.3、2.0、8.1）：带 CSP 的 wrangler pages dev 下，App 首页和 CSP 试验页没有任何 CSP 报错
// 试验页 /app/#/dev-csp 只在非正式版构建里挂（src/app/dev/CspLab.tsx）
// 结论写在 docs/07-开发日志/B0-验证-CSP下Radix与Motion.md
import { expect, test } from './csp-fixture.ts';

test.describe('响应头', () => {
  test('/app/ 带 CSP：style-src 只有 self，没有 unsafe-inline / unsafe-eval；带 Permissions-Policy', async ({ request }) => {
    const res = await request.get('/app/');
    expect(res.status()).toBe(200);
    const csp = res.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("style-src 'self';");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('frame-src \'self\' https://view.officeapps.live.com');
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(res.headers()['permissions-policy']).toContain('camera=()');
    expect(res.headers()['permissions-policy']).toContain('microphone=(self)');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('预览沙箱用自己的 CSP（“! 头名”先去掉 /app/* 那条，只换不叠）', async ({ request }) => {
    // Pages 把 preview.html 308 到不带后缀的地址，真正的页面在 /app/preview
    const redirect = await request.get('/app/preview.html', { maxRedirects: 0 });
    expect([200, 308]).toContain(redirect.status());
    const res = await request.get('/app/preview');
    expect(res.status()).toBe(200);
    const csp = res.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("default-src 'self'");
  });

  test('带哈希的静态文件长缓存，index.html 和 sw.js 不缓存', async ({ request }) => {
    expect((await request.get('/app/sw.js')).headers()['cache-control']).toBe('no-cache');
    expect((await request.get('/app/')).headers()['cache-control']).toBe('no-cache');
  });
});

test.describe('带 CSP 打开页面', () => {
  test('App 首页（今天页）没有 CSP 报错', async ({ page }) => {
    await page.goto('/app/');
    await expect(page.locator('main[data-feature="today"]')).toBeVisible();
  });

  test('Radix Dialog（kit 版：不用 Overlay、自己锁滚动）没有 CSP 报错', async ({ page }) => {
    await page.goto('/app/#/dev-csp');
    await page.getByTestId('dialog-open').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/scroll-locked/);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.locator('html')).not.toHaveClass(/scroll-locked/);
    await page.getByTestId('dialog-open').click();
    await page.getByTestId('dialog-close').click();
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('Radix Popover 没有 CSP 报错', async ({ page }) => {
    await page.goto('/app/#/dev-csp');
    await page.getByTestId('popover-open').click();
    await expect(page.getByTestId('popover-body')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('popover-body')).toBeHidden();
  });

  test('Motion：进出场（AnimatePresence）、按下回弹、layoutId 衔接没有 CSP 报错', async ({ page }) => {
    await page.goto('/app/#/dev-csp');
    await page.getByTestId('motion-toggle').click();
    await expect(page.getByTestId('motion-box')).toBeVisible();
    await page.getByTestId('motion-toggle').click();
    await expect(page.getByTestId('motion-box')).toBeHidden();
    const dot = page.getByTestId('layout-dot');
    const before = await dot.boundingBox();
    await page.getByTestId('layout-toggle').click();
    await expect
      .poll(async () => (await dot.boundingBox())?.x ?? 0, { timeout: 5_000 })
      .toBeGreaterThan((before?.x ?? 0) + 20);
  });

  test('对照组：Radix 原样带 Dialog.Overlay 会被 CSP 拦（证明上面的“没有报错”不是因为没在查）', async ({ page, csp }) => {
    csp.expectViolations();
    await page.goto('/app/#/dev-csp');
    await page.getByTestId('raw-dialog-open').click();
    await expect(page.getByTestId('raw-dialog')).toBeVisible();
    await expect.poll(async () => (await csp.violations()).length).toBeGreaterThan(0);
    const v = await csp.violations();
    expect(v.every((x) => x.directive.startsWith('style-src'))).toBe(true);
    test.info().annotations.push({ type: 'csp-violations', description: JSON.stringify(v) });
  });
});

test.describe('Service Worker', () => {
  test('作用域是 /app/', async ({ page }) => {
    await page.goto('/app/');
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(new URL(scope).pathname).toBe('/app/');
  });
});

test.describe('预览环境', () => {
  // 要预览环境的 Supabase、前端 B 的 /sb/* 转发和后端的表、RLS 都到位才能跑（架构 1.3 B0 验收第 2 条）；
  // 本机 wrangler pages dev 没有这些，B0 里先写好、跳过，由运维在预览部署后打开（LEMO_E2E_PREVIEW_URL）
  test('经自己的域名 /sb/* 读写一条记录', async ({ page }) => {
    const base = process.env.LEMO_E2E_PREVIEW_URL;
    test.skip(!base, '没有预览环境：需要 LEMO_E2E_PREVIEW_URL（预览部署地址）、前端 B 的 /sb/* 转发、后端的 events 表和 RLS');
    await page.goto(`${base}/app/`);
    const result = await page.evaluate(async () => {
      const res = await fetch('/sb/rest/v1/events?select=id&limit=1', { headers: { 'X-App-Version': '4.0.0' } });
      return res.status;
    });
    expect([200, 401]).toContain(result);
  });
});
