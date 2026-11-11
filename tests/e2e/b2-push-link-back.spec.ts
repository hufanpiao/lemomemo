// TC-B2-17 后半（B2 QA 缺口 G-03）：从推送链接打开、再按返回，按 R-372 的层级规则回去
// 推送点开时 SW 做的事（src/sw/push.ts 的 openReminderWindow）：已经开着 /app/ 的窗口就 WindowClient.navigate(reminderUrl)；没有就 openWindow 新开。
// 这里在真 SW 里调同一个 WindowClient.navigate（Playwright 的 serviceWorker.evaluate；focus、openWindow 要通知点按的用户激活，测不了，
// 那两步由 tests/sw 的单元测试覆盖），然后按返回（page.goBack，和 iPhone 左边缘侧滑同一条历史）：
//   ① App 开着、停在日历某一周（从今天点底栏进日历、点“周”、再翻到下一周）：推送打开整页提醒 → 返回回到原来那一周（原页、同一天）；
//      再返回回到今天（R-372 ②：日历里切周、翻页算同一层，不多记步数）；
//   ② App 开着、停在待办：推送打开 → 整页提醒的“‹”关闭：SW 跳过来的这条历史不是 App 自己压的（canGoBack 为假），原地换成今天，
//      不新压（R-372“直接打开的页面一律原地换”）；
//   ③ App 没开（冷启动，openWindow 新开的窗口直接落在 reminderUrl）：关闭后原地换成今天，历史条数不变。
// 地址照 shared/logic/remind-route.ts 的 reminderUrl 拼（SW 和页面同一份）；条目在本机没有，整页提醒显示“找不到了”，返回规则不受影响。
import type { Page } from '@playwright/test';
import { reminderUrl } from '../../shared/logic/remind-route.ts';
import { expect, test } from './session-fixture.ts';

test.use({ loggedIn: true, timezoneId: 'Asia/Seoul', locale: 'zh-CN' });
test.skip(({ browserName }) => browserName !== 'chromium', '要在 Service Worker 里执行 WindowClient.navigate（Playwright 只在 chromium 暴露 serviceWorker）');

const ID = '0e2e0000-0000-4000-8000-0000000000b7';
const DUE = Date.parse('2026-11-12T15:00:00+09:00');
const URL_ = reminderUrl('event', ID, DUE);

const len = (page: Page): Promise<number> => page.evaluate(() => history.length);
const tab = (page: Page, name: string) => page.locator(`[data-testid="tabbar"] a[data-tab="${name}"]`);

/** 打开今天页，等 SW 接管（navigate 只能用在本 SW 控制的窗口上） */
async function openControlled(page: Page): Promise<void> {
  await page.goto('/app/#/today');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(page.locator('main[data-feature="today"]')).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null), '页面归 SW 管').toBe(true);
}

/** 和 openReminderWindow 同一步：SW 找到开着的 /app/ 窗口，WindowClient.navigate 过去 */
async function swNavigate(page: Page, url: string): Promise<void> {
  const [sw] = page.context().serviceWorkers();
  if (!sw) throw new Error('没有 Service Worker');
  const r = await sw.evaluate(async (u) => {
    // 这里跑在 SW 里；node 一侧的类型库没有 ServiceWorkerGlobalScope，只声明用到的几样
    interface Win {
      url: string;
      navigate(u: string): Promise<unknown>;
    }
    const s = self as unknown as { location: Location; clients: { matchAll(o: object): Promise<readonly Win[]> } };
    const wins = await s.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = wins.find((w) => new URL(w.url).pathname.startsWith('/app/'));
    if (!app) return 'no-window';
    await app.navigate(new URL(u, s.location.origin).href);
    return 'ok';
  }, url);
  expect(r).toBe('ok');
  await expect(page.getByTestId('remind-full')).toBeVisible();
  expect(new URL(page.url()).hash).toBe(url.slice('/app/'.length));
}

test('① 停在日历某一周时推送打开整页提醒：返回回到原来那一周，再返回回到今天', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-12T12:00:00+09:00'));
  await openControlled(page);
  await tab(page, 'calendar').click();
  await expect(page).toHaveURL(/#\/calendar$/);
  // 页签互切后 100 ms 内落在 main 里的点按按设计吞掉（motion/index.ts 的 guardTaps、FADE_GUARD_MS，主持人 11-05 的规则）；
  // 窗口从淡入开始算，分包到得晚时淡入开始得也晚，等“没有在播的动画”不够：点不中就隔一会儿再点
  await expect(async () => {
    await page.getByTestId('cal-mode-week').click();
    await expect(page).toHaveURL(/#\/cal\/week\//, { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await page.getByTestId('cal-next').click();
  await expect(page).toHaveURL(/#\/cal\/week\/2026-11-1[5-9]$/);
  await page.getByTestId('cal-week').waitFor();
  const weekHash = new URL(page.url()).hash;

  await swNavigate(page, URL_);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${weekHash.replace(/[/#]/g, '\\$&')}$`));
  await expect(page.getByTestId('cal-week')).toBeVisible();
  await expect(page.getByTestId('remind-full')).toHaveCount(0);
  // 日历里点“周”、翻页都是原地换：再退一步直接回今天
  await page.goBack();
  await expect(page).toHaveURL(/#\/today$/);
  await expect(page.locator('main[data-feature="today"]')).toBeVisible();
});

test('② 停在待办时推送打开整页提醒：点“‹”关闭，原地换成今天、不新压', async ({ page }) => {
  await openControlled(page);
  await tab(page, 'todos').click();
  await expect(page).toHaveURL(/#\/todos$/);
  await swNavigate(page, URL_);
  const before = await len(page);
  await page.getByTestId('remind-full-back').click();
  await expect(page).toHaveURL(/#\/today$/);
  await expect(page.locator('main[data-feature="today"]')).toBeVisible();
  expect(await len(page)).toBe(before);
});

test('③ App 没开、推送新开窗口直接落在整页提醒：关闭后原地换成今天，历史条数不变', async ({ page }) => {
  await page.goto(URL_);
  await expect(page.getByTestId('remind-full')).toBeVisible();
  const before = await len(page);
  await page.getByTestId('remind-full-back').click();
  await expect(page).toHaveURL(/#\/today$/);
  await expect(page.locator('main[data-feature="today"]')).toBeVisible();
  expect(await len(page)).toBe(before);
});
