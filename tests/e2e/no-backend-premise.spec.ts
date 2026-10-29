// “无后端组”的前提写成断言（e2e 接真后端方案第 2 步）：
// 现有 e2e（auth.spec.ts、b1-settings.spec.ts、b1-signout-two-tabs.spec.ts 等）都默认 e2e 构建没配 VITE_PUBLIC_SUPABASE_URL，
// 前端 getSupabase() 抛 supabase_env_missing、拿不到 supabase-js，于是走“兜底清本机会话”“读不出来、重试”那些路。
// 谁要是给 e2e 构建配上了 /sb 的 supabaseUrl（比如 npm run e2e:real:up 的专用后端构建混进了这一组），这几条先红，别让那些用例悄悄测错了路。
//   ① 8788 上实际发出去的 JS 里，buildInfo 的 supabaseUrl 是空字符串，也没有任何以 /sb 结尾的绝对地址；
//      逐个从服务器取 dist/web/app/assets/ 里的文件：取不到就是 8788 上跑的是旧构建（reuseExistingServer 复用了别的服务）
//   ② 带假会话打开设置页（要读设备列表、会去调 getSupabase）：设备列表显示读不出来，一个 /sb/ 请求都没有发出去（context 级监听，含 Service Worker）
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './session-fixture.ts';

const ASSETS_DIR = join(import.meta.dirname, '../../dist/web/app/assets');
/** buildInfo 编译后的样子：supabaseUrl:`…`（也认 "…"、'…'，换压缩器也找得到） */
const SUPABASE_URL_RE = /supabaseUrl:(`[^`]*`|"[^"]*"|'[^']*')/g;
/** 任何以 /sb 结尾的绝对地址字面量 */
const ABS_SB_RE = /https?:\/\/[^\s"'`]+\/sb\/?["'`]/;

test.describe('无后端组的前提', () => {
  test('e2e 构建没编进 /sb 的 supabaseUrl：buildInfo.supabaseUrl 是空字符串，JS 里没有以 /sb 结尾的绝对地址', async ({ request, browserName }) => {
    test.skip(browserName !== 'chromium', '查的是构建产物，不分浏览器');
    const files = readdirSync(ASSETS_DIR).filter((f) => f.endsWith('.js'));
    expect(files.length, 'dist/web/app/assets 里要有 JS（playwright.config 的 webServer 先构建）').toBeGreaterThan(0);
    const literals: string[] = [];
    for (const f of files) {
      const r = await request.get(`/app/assets/${f}`);
      expect(r.status(), `8788 上取不到 ${f}：跑的是旧构建，先关掉复用中的 8788 服务再跑`).toBe(200);
      const js = await r.text();
      for (const m of js.matchAll(SUPABASE_URL_RE)) literals.push(`${f}: ${m[0]}`);
      expect(ABS_SB_RE.exec(js)?.[0] ?? null, `${f} 里编进了 /sb 的绝对地址`).toBeNull();
    }
    // 至少找到 buildInfo 那一处，不然这条断言是空的（压缩后的写法变了要改 SUPABASE_URL_RE）
    expect(literals.length, '没找到 buildInfo 的 supabaseUrl 字面量').toBeGreaterThan(0);
    for (const l of literals) expect(l, '编进了非空的 supabaseUrl').toMatch(/supabaseUrl:(``|""|'')$/);
  });

  test.describe('带假会话', () => {
    test.use({ loggedIn: true });

    test('打开设置页（会调 getSupabase 读设备列表）：读设备失败的提示出来了，一个 /sb/ 请求都没发（含 Service Worker 发的）', async ({ page, context }) => {
      const sb: string[] = [];
      // 挂在 context 上：Service Worker 发出的请求也收得到（page.on 收不到）
      context.on('request', (req) => {
        const u = new URL(req.url());
        if (u.pathname.startsWith('/sb/') || u.pathname === '/sb') sb.push(`${req.method()} ${u.pathname}`);
      });
      await page.goto('/app/#/settings');
      await expect(page.locator('main[data-feature="settings"]')).toBeVisible();
      // 设备列表那一节的“读不出来、重试”（DevicesSection 的 settings.devices.loadFailed），不是别处的 alert
      const devicesFailed = page
        .locator('section[aria-labelledby="settings-devices-title"]')
        .getByRole('alert')
        .filter({ hasText: '设备列表读不出来' });
      await expect(devicesFailed).toBeVisible();
      await expect(devicesFailed.getByRole('button', { name: '重试' })).toBeVisible();
      expect(sb).toEqual([]);
    });
  });
});
