// 日历页页顶提示（提醒接线代码审查 L3、L8）：离线“联网后显示节假日”和 reminders 的“未同步，提醒可能不响”放在同一个常驻的
// role="status" 容器（cal-notice）里。jsdom 量不出布局，这里在真浏览器里看：
// • 没有提示时容器在、但高度为 0，不画灰底，翻页按钮下面紧接正文（不占位）
// • 有提示（离线：节假日文件拉不到）时同一个容器画一块浅灰，高度 > 0
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const TZ = 'Asia/Seoul';

async function box(page: Page) {
  return page.getByTestId('cal-notice').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const next = el.nextElementSibling?.getBoundingClientRect();
    return { h: r.height, bg: cs.backgroundColor, ps: el.querySelectorAll('p').length, gapToNext: next ? Math.round(next.top - r.bottom) : null, role: el.getAttribute('role') };
  });
}

test.describe('日历页页顶提示（代码审查 L3、L8）', () => {
  test.use({ loggedIn: true, viewport: { width: 390, height: 844 }, timezoneId: TZ, locale: 'zh-CN' });

  test('没有提示：常驻容器高度为 0、不画底色、不多出间距', async ({ page }) => {
    await page.goto('/app/#/calendar');
    await page.getByTestId('calendar-page').waitFor({ timeout: 30000 });
    await page.getByTestId('cal-month').waitFor();
    // 节假日文件有结果（拿到或明确没有）以后才算稳定
    await expect.poll(async () => (await box(page)).ps).toBe(0);
    const b = await box(page);
    expect(b.role).toBe('status');
    expect(b.h).toBe(0);
    expect(b.bg).toBe('rgba(0, 0, 0, 0)');
    expect(b.gapToNext).toBe(0);
  });

  test('离线拉不到节假日：同一个容器画一块浅灰', async ({ page }) => {
    await page.route('**/holidays/**', (r) => r.abort('internetdisconnected'));
    await page.goto('/app/#/calendar');
    await page.getByTestId('calendar-page').waitFor({ timeout: 30000 });
    await expect(page.getByTestId('cal-offline')).toBeVisible();
    const b = await box(page);
    expect(b.ps).toBe(1);
    expect(b.h).toBeGreaterThan(20);
    expect(b.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(b.gapToNext).toBe(8);
  });
});
