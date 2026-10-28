// B0 第一项验证（架构 1.3、2.0、8.1）：带 CSP 的 wrangler pages dev 下，App 首页和 CSP 试验页没有任何 CSP 报错
// 试验页 /app/#/dev-csp 只在非正式版构建里挂（src/app/dev/CspLab.tsx）
// 结论写在 docs/07-开发日志/B0-验证-CSP下Radix与Motion.md
import { expect, test } from './csp-fixture.ts';

/** 一条形状正确的 /files 签名链接（0.32；本机没有 /files 的上游，只用来看 CSP 和 SW 怎么对待它） */
const FILES_LINK =
  '/files/v1/o/images/0b7c6a1e-2d3f-4a5b-8c9d-0e1f2a3b4c5d/1b7c6a1e-2d3f-4a5b-8c9d-0e1f2a3b4c5d/2b7c6a1e-2d3f-4a5b-8c9d-0e1f2a3b4c5d.webp?e=4102444800&d=&s=e2e';

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

  // TC-B0-59（15.6 第 4b 条、0.18 N6）：分路径断言。/app/ 和预览沙箱都有 base-uri、form-action，
  // 都不放行 challenges.cloudflare.com（只有 /app/auth/ 放行，入口 B1 才建，B1 起本条加上它），也不放行任何第三方脚本
  test('TC-B0-59：/app/ 和预览沙箱都有 base-uri、form-action；不放行 Turnstile 和任何第三方脚本', async ({ request }) => {
    const want: Record<string, { base: string; form: string }> = {
      '/app/': { base: "base-uri 'none'", form: "form-action 'self'" },
      '/app/preview': { base: "base-uri 'none'", form: "form-action 'none'" },
    };
    for (const [path, { base, form }] of Object.entries(want)) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      const csp = res.headers()['content-security-policy'] ?? '';
      const directives = csp.split(';').map((d) => d.trim());
      expect(directives, path).toContain(base);
      expect(directives, path).toContain(form);
      expect(csp, path).not.toContain('challenges.cloudflare.com');
      // script-src 只有 'self'：没有任何主机、https:、*、unsafe-*
      expect(directives.find((d) => d.startsWith('script-src ')), path).toBe("script-src 'self'");
      // 同一路径只有一条 CSP（“! 头名”去掉了 /app/* 那条，不叠加；叠加时 Cloudflare 用逗号拼）
      expect(csp, path).not.toContain(',');
    }
  });

  test('/files 和网页同源（0.32）：connect-src、img-src 只要 self，不为它另开任何主机', async ({ request }) => {
    const csp = (await request.get('/app/')).headers()['content-security-policy'] ?? '';
    const directive = (name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';
    expect(directive('img-src')).toBe("img-src 'self' blob: data:");
    expect(directive('connect-src').split(' ').slice(0, 2)).toEqual(['connect-src', "'self'"]);
    // connect-src 除了 self 只有 Realtime 的 ws(s) 地址，没有 http(s) 主机（R2 不开公开访问，浏览器只和同源的 /files 打交道）
    expect(directive('connect-src').split(' ').slice(2).every((s) => /^wss?:\/\//.test(s))).toBe(true);
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

  test('取 /files 的链接（fetch、<img>、POST sign）没有 CSP 报错（0.32）', async ({ page }) => {
    await page.goto('/app/');
    await expect(page.locator('main[data-feature="today"]')).toBeVisible();
    const done = await page.evaluate(async (link) => {
      await fetch('/files/v1/sign', { method: 'POST', body: '{}' }).catch(() => null);
      await fetch(link).catch(() => null);
      return new Promise<string>((resolve) => {
        const img = document.createElement('img');
        img.onload = () => resolve('load');
        img.onerror = () => resolve('error'); // 本机没有上游，404 也算“浏览器去取了”，没被 CSP 拦就行
        img.src = link;
        document.body.append(img);
      });
    }, FILES_LINK);
    expect(['load', 'error']).toContain(done);
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

  // TC-B0-40（15.3 第 1 条；0.32 加 /files/*）：本机没有 /sb、/files 的上游，请求本身成不成功不要紧，要看的是 SW 不缓存它们
  test('TC-B0-40：/sb/、/files/ 不进 Cache Storage；断网时 /files 链接取不到，不是读到缓存', async ({ page, context }) => {
    await page.goto('/app/');
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload(); // 装好以后重新打开，页面才归 SW 管
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    const fetchAll = (urls: string[]) =>
      page.evaluate(async (list) => {
        const out: string[] = [];
        for (const u of list) {
          try {
            out.push(`status ${(await fetch(u)).status}`);
          } catch {
            out.push('failed');
          }
        }
        return out;
      }, urls);
    await fetchAll(['/sb/rest/v1/events?select=id&limit=1', FILES_LINK, FILES_LINK]);
    const cached = await page.evaluate(async () => {
      const paths: string[] = [];
      for (const name of await caches.keys()) {
        for (const req of await (await caches.open(name)).keys()) paths.push(new URL(req.url).pathname);
      }
      return paths;
    });
    expect(cached.length, '预缓存里应当有 App 的文件（证明确实查到了 Cache Storage）').toBeGreaterThan(0);
    expect(cached.filter((p) => p.startsWith('/sb/') || p.startsWith('/files/'))).toEqual([]);
    await context.setOffline(true);
    try {
      expect(await fetchAll([FILES_LINK])).toEqual(['failed']);
    } finally {
      await context.setOffline(false);
    }
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
