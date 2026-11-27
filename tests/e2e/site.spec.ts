// 官网骨架的端到端测试（16.3 B0 ②③④、16.4 第 7、8 条；TC-B0-14、15、16、17 的浏览器部分）。
// Playwright，跑在 `wrangler pages dev dist/web`（带 _headers 和 Pages Functions），baseURL 由前端 A 的 playwright.config 给。
// 2026-10-28 前端 B 在本机 wrangler pages dev 下手工按这几步走过一遍（见回报），Playwright 接好后自动跑。
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { SITE_MASCOT_IDS } from '../../src/features/mascot/data/catalog.ts';
import { CREDITS } from '../../src/features/mascot/data/credits-data.ts';
import { fakeSessionJson, sessionKeyFor } from './session-fixture.ts';

// 打开演示页，等四个演示脚本都跑完（demo.js 最后才给勾选框补 tabindex，说明点按、键盘监听都挂好了）再操作
async function openDemo(page: Page, path: string | null): Promise<Locator> {
  if (path) await page.goto(path);
  const app = page.locator('[data-app="phone"]');
  await expect(app.locator('.ck').first()).toHaveAttribute('tabindex', '0');
  return app;
}

test.describe('官网骨架', () => {
  test('16.4 第 8 条：在 /zh/ 页脚点“한국어” → 到 /ko/，之后访问 / 都到 /ko/', async ({ page, context }) => {
    await context.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN' });
    await page.goto('/zh/');
    // 导航和页脚都有语言切换，这一条点的是页脚那个
    await page.locator('footer').getByRole('link', { name: '한국어' }).click();
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

  test('16.3 ②：未登录停在首页；本机有登录信息时访问 / 跳进 /app/', async ({ page, baseURL }) => {
    await page.goto('/zh/');
    await expect(page).toHaveURL(/\/zh\/$/);
    // K6 起 App 只认带 uuid user.id 的会话（原来写 '{}' 会被 App 当成没登录、再跳 /app/auth/）：写一份形状正确的假会话
    const key = sessionKeyFor(new URL('/sb', baseURL ?? 'http://127.0.0.1:8788').href);
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, fakeSessionJson()] as const);
    await page.goto('/');
    await expect(page).toHaveURL(/\/app\/$/);
    await expect(page.locator('main[data-feature="today"]')).toBeVisible();
  });

  test('16.3 ③：首页的网络请求里没有 supabase，也没有 /sb/；控制台没有 CSP 报错', async ({ page }) => {
    const urls: string[] = [];
    const errors: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    for (const p of ['/zh/', '/ko/', '/zh/demo', '/ko/demo', '/zh/privacy', '/ko/terms']) await page.goto(p);
    expect(urls.filter((u) => /supabase|\/sb\//i.test(u))).toEqual([]);
    expect(errors.filter((e) => /Content Security Policy/i.test(e))).toEqual([]);
  });

  test('演示页：首页开场有入口；今天的一句进“今天的安排”，以后的进日历不进今天；只请求同源页面和 /s/ 资源；不写 localStorage 和 cookie', async ({ page, context, baseURL }) => {
    const bad: string[] = [];
    const origin = new URL(baseURL ?? 'http://127.0.0.1:8788').origin;
    page.on('request', (r) => {
      const u = new URL(r.url());
      // blob: 是页面自己在内存里生成的（首页吉祥物 .riv 里的图由 Rive 解成 blob: 显示），不是网络请求
      if (u.protocol === 'blob:') return;
      if (u.origin !== origin || (r.resourceType() !== 'document' && !u.pathname.startsWith('/s/'))) bad.push(`${r.resourceType()} ${r.url()}`);
    });
    await page.goto('/zh/');
    // 开场的按钮区（11-25 起导航条也在 .hero 里，电脑宽时导航也有“演示”链接）
    await page.locator('.hero .cta').getByRole('link', { name: /演示/ }).click();
    await expect(page).toHaveURL(/\/zh\/demo$/);
    const app = await openDemo(page, null);
    const store = async () => [await page.evaluate(() => JSON.stringify(localStorage)), JSON.stringify(await context.cookies())];
    const saved = await store();

    await app.locator('.tb [data-go="cal"]').click();
    await expect(app.locator('[data-page="cal"]')).toBeVisible();
    await expect(app.locator('.tb [data-go="cal"]')).toHaveAttribute('aria-current', 'page');
    const sub = app.locator('[data-cal-sub]');
    const n0 = Number(/本月 (\d+)/.exec((await sub.textContent()) ?? '')?.[1]);
    await app.locator('.tb [data-go="today"]').click();
    const rows = app.locator('[data-page="today"] [data-list="today"] .rw');
    const count = app.locator('[data-page="today"] .sl:not(.red) b');
    const before = await rows.count();
    await expect(count).toHaveText(String(before));

    // 今天下午五点：进今天的安排，计数加一，按时间排在 14:00 和 19:30 之间
    await app.locator('[data-plus]').click();
    await app.getByRole('dialog').locator('input').fill('今天下午五点取快递');
    await app.getByRole('dialog').locator('input').press('Enter');
    await expect(rows).toHaveCount(before + 1, { timeout: 8000 });
    await expect(count).toHaveText(String(before + 1));
    await expect(rows.nth(3)).toContainText('取快递');
    await expect(app.getByRole('status')).toContainText('已记下');

    // 示例句“周六上午十点去游泳”：不进今天，跳到日历的 11 月 28 日，本月项数加一
    await expect(app.getByRole('dialog')).toHaveCount(0, { timeout: 4000 });
    await app.locator('[data-plus]').click();
    await app.locator('.ex button').nth(1).click();
    await expect(app.locator('.tb [data-go="cal"]')).toHaveAttribute('aria-current', 'page', { timeout: 8000 });
    await expect(app.locator('[data-ds-day]')).toContainText('11月28日');
    await expect(app.locator('[data-ds]')).toContainText('去游泳');
    await expect(sub).toContainText(`本月 ${n0 + 2} 项`); // 今天那条也算本月
    await expect(rows).toHaveCount(before + 1);
    await expect(count).toHaveText(String(before + 1));

    expect(bad).toEqual([]);
    expect(await store()).toEqual(saved);
  });

  test('演示页回归：0.9 秒内来回切页签、来回翻月，最后停的那页还在（旧的淡出兜底不会把它藏掉）', async ({ page }) => {
    const app = await openDemo(page, '/zh/demo');
    for (const k of ['cal', 'today', 'cal', 'today']) await app.locator(`.tb [data-go="${k}"]`).click();
    await page.waitForTimeout(1500);
    await expect(app.locator('[data-page="today"]')).toBeVisible();
    await expect(app.locator('.pages > .pg:not([hidden])')).toHaveCount(1);
    await app.locator('.tb [data-go="cal"]').click();
    const next = app.getByRole('button', { name: '下个月' });
    const prev = app.getByRole('button', { name: '上个月' });
    await next.click();
    await prev.click();
    await page.waitForTimeout(1500);
    await expect(app.locator('.cal-m[data-m="11"]')).toBeVisible();
    await expect(app.locator('.cal-m:not([hidden])')).toHaveCount(1);
  });

  test('演示页回归：“正在整理…”时按 Esc 关掉，之后什么都不插', async ({ page }) => {
    const app = await openDemo(page, '/zh/demo');
    const rows = app.locator('[data-page="today"] [data-list="today"] .rw');
    const before = await rows.count();
    await app.locator('[data-plus]').click();
    const input = app.getByRole('dialog').locator('input');
    await input.fill('今天下午五点取快递');
    await input.press('Enter');
    await page.keyboard.press('Escape');
    await expect(app.getByRole('dialog')).toHaveCount(0);
    await page.waitForTimeout(2500);
    await expect(rows).toHaveCount(before);
    await expect(app.getByRole('status')).toHaveCount(0);
  });

  test('演示页回归（键盘和读屏）：勾选框有名字、筛选标签有按下状态、日历一个停靠点用方向键走、详情和弹层关掉焦点回原处', async ({ page, isMobile }) => {
    test.skip(isMobile, '键盘操作只在电脑上测');
    const app = await openDemo(page, '/zh/demo');
    // 勾选框：名字就是那一行的标题，空格勾上
    const ck = app.locator('[data-page="today"]').getByRole('checkbox', { name: '给妈妈打电话' });
    await ck.focus();
    await page.keyboard.press(' ');
    await expect(ck).toHaveAttribute('aria-checked', 'true');
    // 进详情再返回：焦点回到原来那一行
    const row = app.locator('[data-list="today"] .rw[data-kind="ev"]').first();
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(app.locator('[data-page="detail"] [data-back]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(row).toBeFocused();
    // “＋”弹层：是对话框，Esc 关掉，焦点回“＋”
    const plus = app.locator('[data-plus]');
    await plus.focus();
    await page.keyboard.press('Enter');
    await expect(app.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await expect(app.getByRole('dialog')).toHaveCount(0);
    await expect(plus).toBeFocused();
    // 日历：当前月只有一个 Tab 停靠点，方向键走，Enter 选中
    await app.locator('.tb [data-go="cal"]').click();
    const month = app.locator('.cal-m[data-m="11"]');
    await expect(month.locator('[role="button"][tabindex="0"]')).toHaveCount(1);
    await month.locator('[data-iso="2026-11-24"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(month.locator('[data-iso="2026-11-25"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(app.locator('[data-ds-day]')).toContainText('11月25日');
    await page.keyboard.press('ArrowDown');
    await expect(month.locator('[data-iso="2026-12-02"]')).toBeFocused();
    // 筛选标签：按钮 + aria-pressed
    await app.locator('.tb [data-go="todo"]').click();
    const work = app.locator('[data-page="todo"] [data-filter]').getByRole('button', { name: /工作/ });
    await work.focus();
    await page.keyboard.press('Enter');
    await expect(work).toHaveAttribute('aria-pressed', 'true');
  });

  test('演示页回归（网页版）：网页版里切页、记一句，手机那台跟着切；缩到手机宽度回手机版', async ({ page, isMobile }) => {
    test.skip(isMobile, '网页版只在电脑宽度有');
    const app = await openDemo(page, '/zh/demo');
    await expect(page.locator('.demo-stage')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.locator('[data-dev="web"]').click();
    await expect(page.locator('[data-shot="web-today"]')).toBeVisible();
    // 样机直接放在黄底上，没有白卡片（负责人 11-25：“演示页面不要这个白色背景，只留下手机”“网页版也一样”）
    await expect(page.locator('.demo-stage')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    // 网页版样机整行占满（负责人 11-25：“网页版的操作界面太小了”）：缩放不小于 0.8，App 里 15px 的正文显示出来不小于 12px
    await expect(async () => {
      const s = await page.locator('.demo-stage').boundingBox();
      const b = await page.locator('[data-shot="web-today"] .br').boundingBox();
      if (!s || !b) throw new Error('没量到舞台或样机');
      expect(Math.abs(b.width - s.width)).toBeLessThan(2);
      expect(b.width / 1442).toBeGreaterThanOrEqual(0.8);
    }).toPass();
    // 网页版画面能点，所以不在 aria-hidden 里
    await expect(page.locator('[data-shot="web-today"] [aria-hidden="true"] [data-app="web"]')).toHaveCount(0);
    await page.locator('[data-shot="web-today"] .rail [data-go="cal"]').click();
    await expect(page.locator('[data-shot="web-cal"]')).toBeVisible();
    await expect(app.locator('.tb [data-go="cal"]')).toHaveAttribute('aria-current', 'page');
    // 网页版记一句今天的：落回网页版今天，手机那台也切回今天、也多一行
    await page.locator('[data-shot="web-cal"] .rail [data-plus]').click();
    const input = page.locator('[data-shot="web-cal"]').getByRole('dialog').locator('input');
    await input.fill('今天下午五点取快递');
    await input.press('Enter');
    await expect(page.locator('[data-shot="web-today"]')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('[data-shot="web-today"] [data-list="today"]')).toContainText('取快递');
    await expect(app.locator('.tb [data-go="today"]')).toHaveAttribute('aria-current', 'page');
    await expect(app.locator('[data-list="today"]')).toContainText('取快递');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-shot="phone"]')).toBeVisible();
    await expect(page.locator('[data-dev="phone"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('演示页：手机宽度整屏就是 App，标题和“示例数据、不连网”说明留给读屏', async ({ page, isMobile }) => {
    if (!isMobile) await page.setViewportSize({ width: 390, height: 844 });
    const app = await openDemo(page, '/zh/demo');
    const vw = page.viewportSize()?.width ?? 390;
    const box = await app.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(vw - 1);
    await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
    await expect(page.locator('.demo-intro')).toContainText('不连网');
    await app.locator('.tb [data-go="todo"]').click();
    await expect(app.locator('[data-page="todo"]')).toBeVisible();
  });

  test('演示页：减少动态效果时照样能切页、勾待办，不放小点', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const app = await openDemo(page, '/zh/demo');
    await app.locator('.tb [data-go="todo"]').click();
    await expect(app.locator('[data-page="todo"]')).toBeVisible();
    await expect(app.locator('[data-page="today"]')).toBeHidden();
    const ck = app.locator('[data-page="todo"]').getByRole('checkbox', { name: '订周末的火车票' }).first();
    await ck.click();
    await expect(ck).toHaveAttribute('aria-checked', 'true');
    await expect(app.locator('.spark')).toHaveCount(0);
  });

  // 首页（11-25 样稿“版二 乙开场甲讲四组”）：正式站不往 window 上挂东西；测试在页面脚本跑之前放一个空对象 window.__lemoTest，
  // index-*.js 看到它才把运行状态写上去（mode：fx 动起来 / static 静态排开）
  const withHook = (page: Page) => page.addInitScript(() => { (window as unknown as { __lemoTest: object }).__lemoTest = {}; });
  const homeMode = (page: Page) => page.evaluate(() => (window as unknown as { __lemoTest?: { mode?: string } }).__lemoTest?.mode);

  test('首页：一打开大字就是实字（不等粒子）；多端、隐私、常见问题三节的锚点都在；整页只有本页语言的切换状态', async ({ page }) => {
    await withHook(page);
    for (const l of ['zh', 'ko']) {
      await page.goto(`/${l}/`);
      const h1 = page.locator('.hero h1');
      await expect(h1).toBeVisible();
      await expect(h1).toHaveCSS('opacity', '1');
      await expect.poll(() => homeMode(page)).toBe('fx');
      for (const id of ['dev', 'safe', 'faq']) await expect(page.locator(`#${id}`)).toHaveCount(1);
      await expect(page.locator(`.lsw [data-lang="${l}"]`)).toHaveAttribute('aria-current', 'true');
      await expect(page.locator('footer [aria-current="true"]')).toHaveAttribute('data-lang', l);
    }
  });

  test('首页：减少动态效果时四组一屏一屏静态排开，每一项一前一后两台手机，不钉住滚动', async ({ page }) => {
    await withHook(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/zh/');
    await expect.poll(() => homeMode(page)).toBe('static');
    await expect(page.locator('.static .st-g')).toHaveCount(4);
    const items = await page.locator('.static .st-i').count();
    expect(items).toBeGreaterThan(4);
    await expect(page.locator('.static .st-i > .st-ph')).toHaveCount(items);
    // 每项一前一后两台手机（结果那台带 .rm-b），外加点按标记 .rmk，和样稿一样
    await expect(page.locator('.static .st-i > .st-ph > :not(.rmk)')).toHaveCount(items * 2);
    await expect(page.locator('.static .st-i > .st-ph > .rm-b')).toHaveCount(items);
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)fx(\s|$)/);
  });

  test('首页：正式站不往 window 上挂测试钩子（没放 __lemoTest 时页面不建它，也没有旧的 __lemo）', async ({ page }) => {
    await page.goto('/zh/');
    await expect(page.locator('.hero h1')).toBeVisible();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => ['__lemo', '__lemoTest', 'LemoHome'].filter((k) => k in window))).toEqual([]);
  });

  // 11-26 负责人：“素材署名是不是可以折叠起来”→“折叠成一行，点开展开”。默认收起只露一行，点开在原地露出全部署名链接，再点收起
  test('首页：页尾素材署名默认收起，点开能看到全部署名链接，再点收起；收起那一行点击区不矮于 44px', async ({ page }) => {
    for (const l of ['zh', 'ko']) {
      await page.goto(`/${l}/`);
      const box = page.locator('footer details.fcred'), sum = box.locator('summary'), links = box.locator('a');
      await expect(box).not.toHaveAttribute('open', /.*/);
      await expect(sum).toHaveText(l === 'zh' ? '素材署名 ›' : '소재 출처 ›');
      await expect(links.first()).toBeHidden();
      expect((await sum.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      await sum.scrollIntoViewIfNeeded();
      await sum.click();
      await expect(box).toHaveAttribute('open', '');
      // 官网放了的每份吉祥物素材两条（原作、CC BY 4.0）+ Rive 运行库一条，和 credits-data.ts 一致（只在 App 的 #22、#23 不列）
      const onSite = CREDITS.filter((c) => c.id === 'peek' || SITE_MASCOT_IDS.includes(c.id));
      await expect(links).toHaveCount(onSite.length * 2 + 1);
      for (const a of await links.all()) await expect(a).toBeVisible();
      await sum.click();
      await expect(links.first()).toBeHidden();
    }
  });

  // 没有脚本时（或脚本没跑起来）四组的标题和说明照常排在页面里，进屏淡入那几块也看得见，不留大片空白
  test('首页：关掉脚本时四组标题、说明和下半段都看得见', async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto('/zh/');
    await expect(page.locator('#film .gt')).toHaveCount(4);
    for (const g of await page.locator('#film .gt').all()) await expect(g).toBeVisible();
    for (const c of [page.locator('#film .cap').first(), page.locator('#film .cap').last()]) await expect(c).toBeVisible();
    for (const r of await page.locator('.rv').all()) await expect(r).toHaveCSS('opacity', '1');
    await ctx.close();
  });

  // Safari 没有滚动锚定：从演示页点 #safe 这类锚点进首页，多端那一节的高度是脚本后定的，定下以后 index.js 再滚一次到锚点
  test('首页：带 #dev、#safe、#faq 进来，等高度定下以后锚点那一节还在视口顶上', async ({ page }) => {
    for (const id of ['dev', 'safe', 'faq']) {
      await page.goto(`/zh/#${id}`);
      await page.waitForTimeout(2500);
      expect(Math.abs(await page.evaluate((x) => document.getElementById(x)?.getBoundingClientRect().top ?? 1e9, id))).toBeLessThan(2);
    }
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
