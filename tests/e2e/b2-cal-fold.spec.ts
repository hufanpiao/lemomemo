// B2 FA-3：月历上拖收起后按周翻（设计第三轮复审 H1）。在真浏览器里量位置，jsdom 量不出布局
// H1 的根因：按钮翻页横滑时 .pager 带着 translateX，Chrome 里带 transform 的祖先会变成 offsetParent，
// 量出来的 grid.offsetTop 少了一截，清单块多往上走 118 px、盖住星期表头和锚点行（useMonthFold 的 layoutTop）
// 每一步断言：锚点那一行（选中那天）的下沿 = 日清单那一块（拖动柄 + 清单）的上沿；星期表头整条看得见、没被盖住
// 示例日程让各行高度不一样（第 2 行有两个标签更高），收起状态下换锚点行时 shift 必须重量
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null };
const EV = [
  ['e1', '客户周会', 'NEOX', '2026-11-02', '10:00', 60],
  ['e2', '设计评审', '柠檬记', '2026-11-03', '14:00', 90],
  ['e3', '牙医', '家', '2026-11-04', '09:30', 45],
  ['e4', '版本发布', '柠檬记', '2026-11-04', '16:00', 60],
  ['e5', '和小王吃饭', '', '2026-11-04', '19:00', 90],
  ['e8', '季度复盘', 'NEOX', '2026-11-12', '15:00', 120],
  ['e12', '体检', '家', '2026-11-26', '08:30', 60],
  ['e13', '年会', 'NEOX', '2026-12-02', '18:00', 120],
].map(([id, title, project, date, time, dur]) => ({ ...base, id, title, project, date, time, duration_min: dur }));

async function seed(page: Page): Promise<void> {
  await page.evaluate(async (rows) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('planner-v4');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = db.transaction(['events'], 'readwrite');
    for (const r of rows) tx.objectStore('events').put({ id: r.id, server: r, view: r });
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, EV);
}

/** 量一次：选中那天的格子、日清单那一块、星期表头 */
async function geometry(page: Page) {
  return page.evaluate(() => {
    const sel = document.querySelector<HTMLElement>('[data-testid="cal-month"] button[aria-pressed="true"]');
    const wrap = document.querySelector<HTMLElement>('[data-testid="cal-fold"]')?.parentElement;
    const wd = document.querySelector<HTMLElement>('[data-testid="cal-month"] > div:first-child');
    if (!sel || !wrap || !wd) return null;
    const s = sel.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    const h = wd.getBoundingClientRect();
    // 星期表头中线上从左到右取几个点，最上面的元素都应该在表头里（没被别的东西盖住）
    const hits = [0.1, 0.5, 0.9].map((f) => document.elementFromPoint(h.left + h.width * f, h.top + h.height / 2));
    const covered = hits.some((hit) => !hit || !wd.contains(hit));
    // 按钮翻页时正文横滑进来（0.22 s）：滑完才量遮挡
    const pager = document.querySelector<HTMLElement>('[data-testid="cal-pager"]');
    const sliding = pager ? getComputedStyle(pager).transform !== 'none' : false;
    return { date: sel.dataset.date, sliding, selTop: Math.round(s.top), selBottom: Math.round(s.bottom), wrapTop: Math.round(w.top), wdTop: Math.round(h.top), wdBottom: Math.round(h.bottom), covered };
  });
}

async function expectAligned(page: Page, date: string): Promise<void> {
  // 等补间、横滑都停下来
  await expect.poll(async () => (await geometry(page))?.date).toBe(date);
  await expect.poll(async () => (await geometry(page))?.sliding).toBe(false);
  await expect
    .poll(async () => {
      const g = await geometry(page);
      return g ? Math.abs(g.selBottom - g.wrapTop) : 999;
    })
    .toBeLessThanOrEqual(1);
  const g = await geometry(page);
  expect(g?.covered).toBe(false);
  expect(g?.wdTop).toBeGreaterThanOrEqual(0);
  // 锚点行紧贴在星期表头下面
  expect(Math.abs((g?.selTop ?? 0) - (g?.wdBottom ?? 0))).toBeLessThanOrEqual(1);
}

test.describe('月历上拖收起后按周翻（设计第三轮复审 H1）', () => {
  test.use({ loggedIn: true, viewport: { width: 390, height: 844 }, timezoneId: TZ, locale: 'zh-CN' });

  test('收起 → 下一周 → 上一周 → 往后跨月 → 再跨回来：每一步锚点行下沿 = 清单块上沿，星期表头看得见', async ({ page }) => {
    await page.goto('/app/#/cal/month/2026-11');
    await page.getByTestId('calendar-page').waitFor({ timeout: 30000 });
    await seed(page);
    await page.reload();
    await page.getByTestId('cal-month').waitFor();
    await page.locator('[data-testid="cal-month"] [data-date="2026-11-04"]').click();
    await page.getByTestId('cal-fold').click();
    await expect(page.getByTestId('cal-fold')).toHaveAttribute('aria-expanded', 'false');
    await expectAligned(page, '2026-11-04');

    await page.getByTestId('cal-next').click();
    await expectAligned(page, '2026-11-11');
    await page.getByTestId('cal-prev').click();
    await expectAligned(page, '2026-11-04');

    // 往后跨月：11-04 → 11-11 → 11-18 → 11-25 → 12-02（换到 12 月）
    for (const d of ['2026-11-11', '2026-11-18', '2026-11-25', '2026-12-02']) {
      await page.getByTestId('cal-next').click();
      await expectAligned(page, d);
    }
    await expect(page).toHaveURL(/#\/cal\/month\/2026-12$/);
    // 再跨回来
    await page.getByTestId('cal-prev').click();
    await expectAligned(page, '2026-11-25');
    await expect(page).toHaveURL(/#\/cal\/month\/2026-11$/);
  });
});
