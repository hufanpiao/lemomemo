// 官网骨架的端到端测试（16.3 B0 ②③④、16.4 第 7、8 条；TC-B0-14、15、16、17 的浏览器部分）。
// Playwright，跑在 `wrangler pages dev dist/web`（带 _headers 和 Pages Functions），baseURL 由前端 A 的 playwright.config 给。
// 2026-10-28 前端 B 在本机 wrangler pages dev 下手工按这几步走过一遍（见回报），Playwright 接好后自动跑。
import { expect, test } from '@playwright/test';

test.describe('官网骨架', () => {
  test('16.4 第 8 条：在 /zh/ 页脚点“한국어” → 到 /ko/，之后访问 / 都到 /ko/', async ({ page, context }) => {
    await context.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN' });
    await page.goto('/zh/');
    await page.getByRole('link', { name: '한국어' }).click();
    await expect(page).toHaveURL(/\/ko\/$/);
    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === 'lemo_lang')?.value).toBe('ko');
    expect(await page.evaluate(() => localStorage.getItem('pv-locale'))).toBe('ko');
    await page.goto('/');
    await expect(page).toHaveURL(/\/ko\/$/);
  });

  test('16.4 第 7 条：直接访问 /ko/、/zh/ 不跳转（带 cookie 和语言）', async ({ page, context, baseURL }) => {
    await context.setExtraHTTPHeaders({ 'Accept-Language': 'ko-KR' });
    await context.addCookies([{ name: 'lemo_lang', value: 'ko', url: baseURL ?? 'http://127.0.0.1:8788' }]);
    for (const p of ['/zh/', '/ko/']) {
      const r = await page.goto(p);
      expect(r?.status()).toBe(200);
      await expect(page).toHaveURL(new RegExp(`${p}$`));
    }
  });

  test('16.3 ②：未登录停在首页；本机有登录信息时访问 / 跳进 /app/', async ({ page }) => {
    await page.goto('/zh/');
    await expect(page).toHaveURL(/\/zh\/$/);
    await page.evaluate(() => localStorage.setItem(`sb-${location.hostname.split('.')[0]}-auth-token`, '{}'));
    await page.goto('/');
    await expect(page).toHaveURL(/\/app\/$/);
  });

  test('16.3 ③：首页的网络请求里没有 supabase，也没有 /sb/；控制台没有 CSP 报错', async ({ page }) => {
    const urls: string[] = [];
    const errors: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    for (const p of ['/zh/', '/ko/', '/zh/privacy', '/ko/terms']) await page.goto(p);
    expect(urls.filter((u) => /supabase|\/sb\//i.test(u))).toEqual([]);
    expect(errors.filter((e) => /Content Security Policy/i.test(e))).toEqual([]);
  });

  test('0.31 第 31 条：找不到的路径回 404 和根目录的 404.html（中韩两段），不是当单页应用回首页', async ({ page }) => {
    for (const p of ['/no-such-page', '/zh/no-such-page', '/errors/5xx.html']) {
      const r = await page.goto(p);
      expect(r?.status(), p).toBe(404);
      await expect(page.getByRole('heading', { name: '找不到这个页面' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '페이지를 찾을 수 없어요' })).toBeVisible();
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    }
  });

  test('16.3 ④：首页不注册 Service Worker，/app/ 以外的路径没被接管', async ({ page }) => {
    await page.goto('/zh/');
    const regs = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope));
    expect(regs.every((s) => new URL(s).pathname.startsWith('/app/'))).toBe(true);
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
  });
});
