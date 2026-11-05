// 液态玻璃底栏的电脑版侧栏（B2 FA-7 D5）；手机宽度的底栏见 b2-tabbar.spec.ts
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const bar = (page: Page) => page.getByTestId('tabbar');
const tab = (page: Page, name: string) => bar(page).locator(`a[data-tab="${name}"]`);

// 电脑版侧栏（设计动效评审 D5，主持人 11-05：断点 (width >= 900px)、不放 ⋯、方案 A 只用 CSS 复用底栏的 DOM）：
// 1280 宽时底栏排成左边竖的侧栏（上“＋”、中四个页签、下设置入口；选中项 --accent 底），没有模糊带和液滴，页面让出左边；今天页右上角头像藏掉；
// 899 宽照旧是底栏
test.describe('电脑版侧栏（FA-7 D5）', () => {
  test.use({ loggedIn: true, viewport: { width: 1280, height: 800 } });

  test('1280 宽：左边竖的侧栏，选中项柠檬黄；“＋”在上、设置入口在下；页面让出左边；今天页头像藏掉；切页、“＋”、设置都能用', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    const nav = await bar(page).boundingBox();
    expect(nav).not.toBeNull();
    expect(nav?.x).toBe(16);
    expect(nav?.width).toBe(78);
    expect(nav?.height ?? 0).toBeGreaterThan(500); // 竖的、几乎占满高度
    // 四个页签从上往下排
    const ys: number[] = [];
    for (const name of ['today', 'calendar', 'todos', 'notes']) ys.push((await tab(page, name).boundingBox())?.y ?? 0);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(new Set(ys).size).toBe(4);
    // “＋”在侧栏里、页签上面
    const add = await page.getByTestId('tabbar-add').boundingBox();
    expect(add?.x ?? 0).toBeGreaterThan(16);
    expect((add?.x ?? 0) + (add?.width ?? 0)).toBeLessThan(16 + 78);
    expect((add?.y ?? 0) + (add?.height ?? 0)).toBeLessThanOrEqual(ys[0] ?? 0);
    // 选中项柠檬黄底，液滴藏掉；首屏后部分到了以后：没有模糊带，设置入口在最下面
    const bgOf = (name: string) => tab(page, name).evaluate((el) => getComputedStyle(el).backgroundColor);
    const accent = await page.evaluate(() => {
      const probe = document.createElement('i');
      probe.style.setProperty('color', 'var(--accent)');
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    expect(await bgOf('today')).toBe(accent);
    expect(await bgOf('todos')).toBe('rgba(0, 0, 0, 0)');
    await expect(bar(page).locator('[class*="drop"]')).toBeHidden();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    await expect(page.getByTestId('tabbar-band')).toBeHidden();
    const me = page.getByTestId('tabbar-settings');
    await expect(me).toBeVisible();
    expect((await me.boundingBox())?.y ?? 0).toBeGreaterThan(ys[3] ?? 0);
    await expect(page.getByTestId('today-settings')).toBeHidden();
    // 页面让出左边
    const main = await page.locator('main[data-feature="today"]').boundingBox();
    expect(main?.x ?? 0).toBeGreaterThanOrEqual(16 + 78);
    // 切页、选中项跟着走；“＋”按页新建；设置入口进设置
    await tab(page, 'todos').click();
    await expect(page.getByTestId('todos')).toBeVisible();
    await expect(tab(page, 'todos')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('tabbar-add')).toHaveAccessibleName('新建待办');
    await me.click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(bar(page)).toHaveCount(0);
  });

  // 设计复审三 S1：设置入口在首屏外壳里，首屏后部分（GlassBarFx 分包）下载失败时宽屏也有设置入口
  test('首屏后部分下载失败：侧栏照样有设置入口，能进设置', async ({ page }) => {
    await page.route(/\/assets\/GlassBarFx-[^/]+\.js$/, (r) => r.abort());
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    const me = page.getByTestId('tabbar-settings');
    await expect(me).toBeVisible();
    await page.waitForTimeout(1500); // 等过首屏后下载的时机，确认下载失败以后它也一直在
    await expect(page.getByTestId('tabbar-band')).toHaveCount(0);
    await expect(me).toBeVisible();
    await me.click();
    await expect(page).toHaveURL(/#\/settings$/);
  });

  // 设计复审三 S2：Tab 顺序和画面上下一致（“＋”→ 四个页签 → 设置）。
  // webkit 默认 Tab 不经过链接（Safari 的“按 Tab 高亮每一项”设置），只在 chromium 按键走一遍；DOM 顺序两种浏览器都核对
  test('键盘 Tab 顺序：“＋”→ 今天 → 日历 → 待办 → 随手记 → 设置', async ({ page, browserName }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    const ids = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="tabbar-add"], a[data-tab], [data-testid="tabbar-settings"]')].map(
        (el) => el.dataset['tab'] ?? el.dataset['testid'] ?? '',
      ),
    );
    expect(ids).toEqual(['tabbar-add', 'today', 'calendar', 'todos', 'notes', 'tabbar-settings']);
    if (browserName === 'webkit') return;
    await page.getByTestId('tabbar-add').focus();
    for (const name of ['today', 'calendar', 'todos', 'notes']) {
      await page.keyboard.press('Tab');
      await expect(tab(page, name)).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('tabbar-settings')).toBeFocused();
  });

  // 设计复审三 S3：有悬停的设备上，没选中的页签悬停时铺 --panel-2、字色 --text；没有悬停的设备（触屏）不变
  test('悬停反馈：没选中的页签悬停时换底色和字色（只在 hover: hover 的设备上）', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    const colorOf = (v: string) =>
      page.evaluate((name) => {
        const probe = document.createElement('i');
        probe.style.setProperty('color', `var(${name})`);
        document.body.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      }, v);
    const look = () => tab(page, 'calendar').evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
    const before = await look();
    expect(before[0]).toBe('rgba(0, 0, 0, 0)');
    await tab(page, 'calendar').hover();
    const canHover = await page.evaluate(() => matchMedia('(hover: hover)').matches);
    if (canHover) await expect.poll(look).toEqual([await colorOf('--panel-2'), await colorOf('--text')]);
    else expect(await look()).toEqual(before);
    // 选中的页签悬停不变（还是柠檬黄底）
    const cur = await tab(page, 'today').evaluate((el) => getComputedStyle(el).backgroundColor);
    await tab(page, 'today').hover();
    expect(await tab(page, 'today').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(cur);
  });

  test('899 宽照旧是底栏（贴底、横排），今天页头像在右上角，侧栏的设置入口不出', async ({ page }) => {
    await page.setViewportSize({ width: 899, height: 800 });
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    const nav = await bar(page).boundingBox();
    expect((nav?.y ?? 0) + (nav?.height ?? 0)).toBeGreaterThan(800 - 120);
    expect(nav?.height ?? 0).toBeLessThan(80);
    await expect(page.getByTestId('today-settings')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    await expect(page.getByTestId('tabbar-settings')).toBeHidden();
  });
});
