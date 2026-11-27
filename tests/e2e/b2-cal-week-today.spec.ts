// CAL-week-today-circle（提醒接线设计复审 L4）：手机周视图左列“周三 / 30 / 十九”三行，
// 今天那天的日期圆圈原来上下贴着两行小字。在真浏览器里量：每一行的日期数字和上下两行小字之间都至少留 1 px，
// 今天的圆圈是 22×22 的正圆，各行日期数字一样高。
// 这一周带国庆休息日（柠檬黄斜纹；假期第一天农历位置换成节日名，后几天照写农历，R-432）和一条全天日程（多一行全天标签）：
// 没有全天标签的各行等高（今天那行、休息日不比别的行高），全天那行最多高 16 px（审查建议一）
import type { Page } from '@playwright/test';
import { cached, idbPut } from './idb.ts';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
const ALL_DAY = { id: 'ad1', user_id: FAKE_USER_ID, title: '出差', project: '', date: '2026-09-29', time: null, tz: null, duration_min: null, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null };

async function seed(page: Page): Promise<void> {
  await idbPut(page, [['events', cached(ALL_DAY)]]);
}

test.describe('手机周视图：今天的日期圆圈不贴上下两行字（CAL-week-today-circle）', () => {
  test.use({ loggedIn: true, viewport: { width: 390, height: 844 }, timezoneId: TZ, locale: 'zh-CN' });

  test('圆圈和“周几”“农历”上下各留出空隙，是 22 px 正圆；休息日、今天不长高，全天那行最多高 16 px', async ({ page }) => {
    // 固定“现在”在 2026-09-30（周三）中午：这一周 9-28～10-04，10-01 起是国庆休息日
    await page.clock.setFixedTime(new Date('2026-09-30T12:00:00+09:00'));
    await page.goto('/app/#/cal/week/2026-09-30');
    await page.getByTestId('cal-week').waitFor({ timeout: 30000 });
    await seed(page);
    await page.reload();
    await page.getByTestId('cal-week').waitFor();
    await expect(page.locator('[data-testid="cal-week"] li[data-date="2026-09-29"]')).toContainText('出差');
    // 节假日是页面画出来以后才拉的（useHolidays 拉 holidays/<国>/<年>.json，异步）：只等全天日程就量，帧稀时节假日还没到（11-10 镜像 b2 组 3/18 遍“有国庆休息日”挂）。
    // 先等它到了再量；拉不到的话这里照样挂
    await expect(page.locator('[data-testid="cal-week"] li[data-date="2026-10-01"]')).toContainText('国庆', { timeout: 10_000 });
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="cal-week"] li[data-date]')].map((li) => {
        const col = li.querySelector<HTMLElement>('[aria-hidden="true"]');
        const b = col?.querySelector('b');
        const [up, down] = col ? [...col.querySelectorAll(':scope > small')] : [];
        if (!b || !up || !down) return null;
        const r = b.getBoundingClientRect();
        const u = up.getBoundingClientRect();
        const d = down.getBoundingClientRect();
        return {
          date: li.dataset.date ?? '',
          sub: down.textContent ?? '',
          // R-445 周视图 A：全天日程画在右边轨道顶上一整条，不再在左列多一行标签
          allDay: (li.textContent ?? '').includes('出差'),
          rowH: Math.round(li.getBoundingClientRect().height),
          // R-445：今天是淡黄小框，刚打开时今天也是选中日（深色小方块、不画框线），都按“日期数字有底色”认
          ring: getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)',
          w: Math.round(r.width),
          h: Math.round(r.height),
          gapUp: r.top - u.bottom,
          gapDown: d.top - r.bottom,
        };
      }),
    );
    expect(rows.length).toBe(7);
    const got = rows.filter((r) => r !== null);
    expect(got.length, '每行都有周几、日期、农历三行').toBe(7);
    for (const r of got) {
      expect(r.gapUp, `${r.date} 日期和周几之间`).toBeGreaterThanOrEqual(1);
      expect(r.gapDown, `${r.date} 日期和农历之间`).toBeGreaterThanOrEqual(1);
      expect(r.h, `${r.date} 日期数字一样高`).toBe(22);
    }
    const today = got.filter((r) => r.ring);
    expect(today.map((r) => r.date)).toEqual(['2026-09-30']);
    expect(today[0]?.w).toBe(22);

    // 这一周确实有休息日和全天日程，下面的等高断言才有意义
    expect(got.some((r) => r.sub.includes('国庆')), '有国庆休息日').toBe(true);
    expect(got.filter((r) => r.allDay).map((r) => r.date)).toEqual(['2026-09-29']);
    const plain = got.filter((r) => !r.allDay);
    const h0 = plain[0]?.rowH ?? 0;
    for (const r of plain) expect(r.rowH, `${r.date} 和别的行一样高`).toBe(h0);
    const tall = got.find((r) => r.allDay)?.rowH ?? 0;
    expect(tall - h0, '全天那行多出的高度').toBeLessThanOrEqual(16);
  });
});
