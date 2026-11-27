// 电脑版日历的详情抽屉（R-130“电脑版所有画面的详情抽屉一律默认从右边滑出，包括周视图、月视图”，11-17 接上）的真浏览器用例，chromium、webkit 都跑（1280×800）：
//   ① 月视图日清单点日程：不换页，右边盖上抽屉（右沿离窗口 16），里面是日程编辑器；运行日志记一行“cal drawer open kind=event view=month”（不带标题）；
//      Esc 关上，焦点回到那一行
//   ② 电脑周表点全天行的待办：抽屉里是待办编辑器；× 关上，焦点回到那个按钮
//   ③ 抽屉里删了这一条：这一行从日清单里没了，× 关上时焦点退到页顶 h1（不掉到 body）
//   ④ 抽屉里打开 kit 选择器：Esc 只收起选择器，抽屉不关（11-22 选择器评审第 3 条）
import type { Page } from '@playwright/test';
import { runLog } from './fake-media.ts';
import { cached, idbPut } from './idb.ts';
import { afterPageFade } from './page-helpers.ts';
import { expect, FAKE_USER_ID, test } from './session-fixture.ts';
import { logOnFail } from './fail-log.ts';

logOnFail(test);

const TZ = 'Asia/Seoul';
const NOW = new Date('2026-11-12T09:00:00+09:00');
const DAY = '2026-11-12';
const EV = '0e2e0000-0000-4000-8000-000000130e01';
const TD = '0e2e0000-0000-4000-8000-000000130d01';
const base = { user_id: FAKE_USER_ID, created_at: NOW.getTime() - 86_400_000, updated_at: NOW.getTime() - 86_400_000, deleted_at: null, undone: false, short: null };

test.use({ trace: 'off', loggedIn: true, viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, timezoneId: TZ, locale: 'zh-CN' });

async function openCal(page: Page, hash: string): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(`/app/#${hash}`);
  await page.getByTestId('calendar-page').waitFor({ timeout: 30_000 });
  await idbPut(page, [
    ['events', cached({ ...base, id: EV, title: 'NEOX 横版对片', project: 'NEOX', date: DAY, time: '14:00', tz: TZ, duration_min: 60 })],
    ['todos', cached({ ...base, id: TD, title: 'NEOX 竖版 4K 导出', project: 'NEOX', tz: TZ, due: DAY, due_time: null, done: false })],
  ]);
  await page.reload();
  await page.getByTestId('calendar-page').waitFor({ timeout: 30_000 });
  await afterPageFade(page);
}

test.describe('R-130 电脑版日历的详情抽屉', () => {
  test('① 月视图日清单：右边盖上抽屉、不换页、日志一行；Esc 关上焦点回到那一行', async ({ page }) => {
    await openCal(page, `/cal/month/2026-11`);
    const row = page.getByTestId(`cal-day-row-${EV}`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    const drawer = page.getByTestId('cal-drawer');
    await expect(drawer.getByTestId('event-edit-title')).toHaveValue('NEOX 横版对片', { timeout: 20_000 });
    await expect(page).toHaveURL(/#\/cal\/month\/2026-11$/);
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => drawer.evaluate((el) => Math.round(window.innerWidth - el.getBoundingClientRect().right))).toBe(16);
    await expect.poll(async () => (await runLog(page)).some((l) => l.includes('cal drawer open kind=event view=month'))).toBe(true);
    expect((await runLog(page)).some((l) => l.includes('cal drawer') && l.includes('NEOX'))).toBe(false);
    // 抽屉是层栈栈顶时 Esc 关上（打开时焦点已移到抽屉）
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(row).toBeFocused();
  });

  test('② 电脑周表：全天行的待办开待办编辑器；× 关上焦点回到那个按钮', async ({ page }) => {
    await openCal(page, `/cal/week/${DAY}`);
    await expect(page.getByTestId('cal-week')).toHaveAttribute('data-layout', 'desk');
    const all = page.getByTestId(`cal-desk-all-${TD}`);
    await expect(all).toBeVisible({ timeout: 20_000 });
    await all.click();
    const drawer = page.getByTestId('cal-drawer');
    await expect(drawer.getByTestId('todo-edit-title')).toHaveValue('NEOX 竖版 4K 导出', { timeout: 20_000 });
    await expect(page).toHaveURL(new RegExp(`#/cal/week/${DAY}$`));
    await expect.poll(async () => (await runLog(page)).some((l) => l.includes('cal drawer open kind=todo view=week'))).toBe(true);
    await drawer.getByTestId('todo-edit-close').click();
    await expect(drawer).toHaveCount(0);
    await expect(all).toBeFocused();
  });

  test('③ 抽屉里删了这一条：行没了，× 关上焦点退到页顶 h1', async ({ page }) => {
    await openCal(page, `/cal/month/2026-11`);
    const row = page.getByTestId(`cal-day-row-${EV}`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    const drawer = page.getByTestId('cal-drawer');
    await expect(drawer.getByTestId('event-edit-title')).toHaveValue('NEOX 横版对片', { timeout: 20_000 });
    await drawer.getByTestId('event-edit-delete').click();
    await expect(drawer.getByTestId('event-edit-undo')).toBeVisible();
    await expect(row).toHaveCount(0);
    await drawer.getByTestId('event-edit-close').click();
    await expect(drawer).toHaveCount(0);
    await expect(page.locator('main[data-feature="calendar"] h1')).toBeFocused();
  });

  test('④ 抽屉里打开结束时刻的选择器：Esc 只收起选择器（抽屉还在、焦点回到时刻按钮），再按一次才关抽屉（选择器评审第 3 条）', async ({ page }) => {
    await openCal(page, `/cal/month/2026-11`);
    const row = page.getByTestId(`cal-day-row-${EV}`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    const drawer = page.getByTestId('cal-drawer');
    await expect(drawer.getByTestId('event-edit-title')).toHaveValue('NEOX 横版对片', { timeout: 20_000 });
    const end = drawer.getByTestId('event-edit-end');
    await end.click();
    await expect(end).toHaveAttribute('aria-expanded', 'true');
    const id = await end.getAttribute('aria-controls');
    const box = page.locator(`[id="${id ?? ''}"]`);
    await expect(box).toBeVisible();
    await box.locator('[data-v="h16"]').focus();
    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(end).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });
});
