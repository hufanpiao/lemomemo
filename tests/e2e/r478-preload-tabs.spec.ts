// R-478 冷启动后台先下载三个页签页（负责人 11-18“冷启动后第一次进入日历，待办，随手页都会有一个加载过程，能不能冷启动后马上后台自动加载这3个页面”）：
// 打开今天页、首屏画完以后不点任何东西：日历、待办、随手记三页的代码都已经下载（网络请求里有、运行日志有 preload … ok=1）；
// 之后切到日历页不再下载日历那一包
import { runLog } from './fake-media.ts';
import { expect, test } from './session-fixture.ts';

test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, locale: 'zh-CN' });

test('冷启动不点任何页：三个页签页和设置页在后台下载好，点日历时不再下载', async ({ page }) => {
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  await page.goto('/app/#/today');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30_000 });
  await expect
    .poll(async () => (await runLog(page)).filter((l) => / preload (calendar|todos|notes|settings) ms=\d+ ok=1/.test(l)).length, { timeout: 20_000 })
    .toBe(4);
  for (const name of ['CalendarPage', 'TodosPage', 'NotesPage', 'SettingsPage']) expect(urls.some((u) => u.includes(name)), `${name} 没在后台下载`).toBe(true);
  const before = urls.filter((u) => u.includes('CalendarPage')).length;
  await page.getByRole('link', { name: /日历/ }).first().click();
  await page.locator('main[data-feature="calendar"]').waitFor({ timeout: 10_000 });
  expect(urls.filter((u) => u.includes('CalendarPage')).length, '点进日历又下载了一次').toBe(before);
});
