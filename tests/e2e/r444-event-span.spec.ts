// R-444 跨天日程：真浏览器里走一遍。全天 3 天的出差和 23:00 起 2 小时的通宵，
// 日清单第一天、中间一天、最后一天各写什么；手机周视图每天都有；编辑页“结束”能选到第 4 天，改完日清单跟着变。
// 跨天的连条画法等负责人定图，这里只守“每天都在、写对第几天和到几点”
import type { Page } from '@playwright/test';
import { cached, idbPut } from './idb.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
const base = { user_id: FAKE_USER_ID, project: '', created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null };
// 编辑页路由只认 UUID
const TRIP_ID = '0e2e0000-0000-4000-8000-000000444001';
const LATE_ID = '0e2e0000-0000-4000-8000-000000444002';
const TRIP = { ...base, id: TRIP_ID, title: '出差', date: '2026-11-18', time: null, tz: null, duration_min: 3 * 1440 };
const LATE = { ...base, id: LATE_ID, title: '通宵', date: '2026-11-18', time: '23:00', tz: TZ, duration_min: 120 };

async function seed(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-11-17T12:00:00+09:00'));
  await page.goto('/app/#/cal/month/2026-11');
  await page.getByTestId('cal-month').waitFor({ timeout: 30000 });
  await idbPut(page, [['events', cached(TRIP)], ['events', cached(LATE)]]);
  await page.reload();
  await page.getByTestId('cal-month').waitFor();
}

const pick = async (page: Page, day: string): Promise<void> => {
  await page.locator(`[data-testid="cal-month"] button[data-date="${day}"]:not([inert])`).first().click();
};

test.describe('R-444 跨天日程', () => {
  test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, timezoneId: TZ, locale: 'zh-CN' });

  test('日清单：第一天写到哪天几点、中间一天写第几天、最后一天写到几点', async ({ page }) => {
    await seed(page);
    const list = page.getByTestId('cal-day-list');
    const trip = list.getByTestId(`cal-day-row-${TRIP_ID}`);
    const late = list.getByTestId(`cal-day-row-${LATE_ID}`);
    await pick(page, '2026-11-18');
    await expect(trip).toContainText('第 1/3 天');
    await expect(late).toContainText('至 11月19日 01:00');
    await pick(page, '2026-11-19');
    await expect(trip).toContainText('第 2/3 天');
    await expect(late).toContainText('01:00');
    await pick(page, '2026-11-20');
    await expect(trip).toContainText('第 3/3 天');
    await expect(late).toHaveCount(0);
    await pick(page, '2026-11-21');
    await expect(trip).toHaveCount(0);
  });

  test('手机周视图：出差三天每天一行', async ({ page }) => {
    await seed(page);
    await page.goto('/app/#/cal/week/2026-11-18');
    await page.getByTestId('cal-week').waitFor();
    for (const d of ['2026-11-18', '2026-11-19', '2026-11-20']) {
      await expect(page.locator(`[data-testid="cal-week"] li[data-date="${d}"]`)).toContainText('出差');
    }
    await expect(page.locator('[data-testid="cal-week"] li[data-date="2026-11-21"]')).not.toContainText('出差');
  });

  test('编辑页：全天的“结束”显示最后一天，改到 11-21 以后日清单多出第 4 天', async ({ page }) => {
    await seed(page);
    await page.goto(`/app/#/event/${TRIP_ID}`);
    const end = page.getByTestId('event-edit-end-date');
    await expect(end).toHaveValue('2026-11-20', { timeout: 20_000 });
    await expect(end).toHaveAttribute('min', '2026-11-18');
    await expect(end).toHaveAttribute('max', '2026-12-18');
    await expect(page.getByTestId('event-edit-end')).toHaveCount(0);
    await end.fill('2026-11-21');
    await end.press('Tab');
    await expect(end).toHaveValue('2026-11-21');
    await page.goto('/app/#/cal/month/2026-11');
    await pick(page, '2026-11-21');
    await expect(page.getByTestId('cal-day-list').getByTestId(`cal-day-row-${TRIP_ID}`)).toContainText('第 4/4 天');
  });

  test('编辑页：有时刻的“结束”有日期和时刻两格', async ({ page }) => {
    await seed(page);
    await page.goto(`/app/#/event/${LATE_ID}`);
    await expect(page.getByTestId('event-edit-end-date')).toHaveValue('2026-11-19', { timeout: 20_000 });
    await expect(page.getByTestId('event-edit-end')).toHaveValue('01:00');
    // 有时刻的结束日期上限也是开始 + 30 天（评审第 4 条）
    await expect(page.getByTestId('event-edit-end-date')).toHaveAttribute('max', '2026-12-18');
  });
});
