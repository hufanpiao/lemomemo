// 倾斜高光（B2 FA-7 TILT-b2 做法 ②，R-247；主持人 11-05：开关在设置页、存本机、默认关；倾斜监听在首屏后的副本引擎里，外壳不加代码）
// 两种浏览器都装一个假的 DeviceOrientationEvent.requestPermission（iOS、新版安卓 Chrome 都有这个接口；记次数），照真机的规矩答：
// 在点按里（最近 1 秒内有 click）答 granted，并在这次打开里记住；不在点按里、这次打开还没同意过就拒绝（像 iOS 要点按）；
// navigator.permissions.query 一律答 prompt（不让浏览器自己的权限状态混进来）。
// 设计评审 T1：设置里打开开关时同意了，回到今天页不用点底栏就跟倾斜；新打开 App（授权记不住）要先点底栏；默认关、减少动态效果时都不跟
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const bar = (page: Page) => page.getByTestId('tabbar');

/** 发一次方向读数（webkit 里不一定能 new DeviceOrientationEvent，统一用普通事件加属性） */
const orient = (page: Page, gamma: number, beta = 45) =>
  page.evaluate(
    ([g, b]) => {
      const e = new Event('deviceorientation');
      Object.defineProperty(e, 'gamma', { value: g });
      Object.defineProperty(e, 'beta', { value: b });
      dispatchEvent(e);
    },
    [gamma, beta] as const,
  );
const sx = (page: Page) => bar(page).evaluate((el) => el.style.getPropertyValue('--g-sx'));
const asks = (page: Page) => page.evaluate(() => (window as unknown as { __asks?: number }).__asks ?? 0);

test.describe('倾斜高光（TILT-b2）', () => {
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __asks: number; DeviceOrientationEvent?: unknown };
      w.__asks = 0;
      let lastTap = -1e9;
      let granted = false;
      addEventListener('click', () => (lastTap = performance.now()), true);
      const ask = () => {
        w.__asks += 1;
        if (performance.now() - lastTap < 1000) granted = true;
        return granted ? Promise.resolve('granted') : Promise.reject(new DOMException('requires a user gesture', 'NotAllowedError'));
      };
      // Windows 上 Playwright 的 webkit（iPhone 15 模拟）竖屏也报 screen.orientation.angle=90（type 是 portrait-primary），真机竖屏是 0：
      // 钉成 0，免得横屏换轴（T5）把竖屏读数换掉；横屏换轴本身由单测 glass-tilt.test.ts 管
      if (typeof ScreenOrientation === 'function') Object.defineProperty(ScreenOrientation.prototype, 'angle', { get: () => 0, configurable: true });
      if (navigator.permissions) {
        const query = () => Promise.resolve({ state: 'prompt' } as PermissionStatus);
        Object.defineProperty(navigator.permissions, 'query', { value: query, configurable: true });
      }
      if (typeof w.DeviceOrientationEvent === 'function') Object.defineProperty(w.DeviceOrientationEvent, 'requestPermission', { value: ask, configurable: true });
      else w.DeviceOrientationEvent = Object.assign(function DeviceOrientationEvent() {}, { requestPermission: ask });
    });
  });

  test('默认关：底栏不跟倾斜，也不问权限', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    await bar(page).locator('a[data-tab="today"]').click();
    await orient(page, 30);
    await page.waitForTimeout(300);
    expect(await sx(page)).toBe('');
    expect(await asks(page)).toBe(0);
  });

  test('T1：设置里打开（在点按里问、同意）→ 回今天页，不点底栏直接倾斜就跟；换页不再弹窗；关掉以后不跟', async ({ page }) => {
    await page.goto('/app/#/settings');
    const sw = page.getByRole('switch', { name: '倾斜高光' });
    await expect(sw).not.toBeChecked();
    await sw.click();
    await expect(sw).toBeChecked();
    expect(await asks(page)).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('lemo.tilt'))).toBe('1');

    await page.getByRole('link', { name: /今天/ }).first().click();
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    await expect.poll(() => page.evaluate(() => document.querySelector('[data-testid="tabbar"]')?.hasAttribute('data-glass') ?? false)).toBe(true); // 副本引擎开了
    await page.waitForTimeout(1100); // 过了“点按里”的 1 秒：下面的跟随只能靠这次打开里已同意，不靠刚才那下点“今天”
    // 不点底栏：直接倾斜
    await expect
      .poll(async () => {
        await orient(page, 30);
        return parseFloat((await sx(page)) || '0');
      })
      .toBeGreaterThan(90); // 往 50 + 30 × 1.6 = 98 靠
    // 高光真的画在那个位置（::after 的径向渐变中心跟着变量走）
    const bg = await bar(page).locator('[class*="barTint"]').evaluate((el) => getComputedStyle(el, '::after').backgroundImage);
    expect(bg).toMatch(/at (9\d|1\d\d)(\.\d+)?% /);
    // 换页、点底栏：这次打开 App 已经同意过，不再弹窗（requestPermission 可能被不在点按里问一下，但都直接回 granted）
    await bar(page).locator('a[data-tab="todos"]').click();
    await expect(page.getByTestId('todos')).toBeVisible();
    // 换页后底栏是新挂上的：不在点按里问那一下是异步的，读数一直发到它听上为止（真机上读数是连续来的）
    await expect
      .poll(async () => {
        await orient(page, -30);
        return parseFloat((await sx(page)) || '100');
      })
      .toBeLessThan(10);

    // 关掉：回到今天页后不跟
    await page.goto('/app/#/settings');
    await page.getByRole('switch', { name: '倾斜高光' }).click();
    await expect(page.getByRole('switch', { name: '倾斜高光' })).not.toBeChecked();
    await page.getByRole('link', { name: /今天/ }).first().click();
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    await bar(page).locator('a[data-tab="today"]').click();
    await orient(page, -30);
    await page.waitForTimeout(300);
    expect(await sx(page)).toBe('');
  });

  test('新打开 App、开关本来就开着（授权记不住）：倾斜不跟；第一次点底栏弹窗同意后才跟', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('lemo.tilt', '1'));
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    await expect.poll(() => page.evaluate(() => document.querySelector('[data-testid="tabbar"]')?.hasAttribute('data-glass') ?? false)).toBe(true);
    await orient(page, 30);
    await page.waitForTimeout(300);
    expect(await sx(page)).toBe('');
    await bar(page).locator('a[data-tab="today"]').click();
    await expect.poll(async () => {
      await orient(page, 30);
      return parseFloat((await sx(page)) || '0');
    }).toBeGreaterThan(90);
  });

  test('开着但系统减少动态效果：不跟倾斜、不问权限', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => localStorage.setItem('lemo.tilt', '1'));
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    await bar(page).locator('a[data-tab="today"]').click();
    await orient(page, 30);
    await page.waitForTimeout(300);
    expect(await sx(page)).toBe('');
    expect(await asks(page)).toBe(0);
  });
});
