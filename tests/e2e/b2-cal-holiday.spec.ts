// 月历节假日（R-432，负责人 11-15“照参考图做”）在真浏览器里量（chromium、webkit，不要后端；节假日用 dist 里真的 holidays/cn/2026.json）：
// • 国庆连休只在 10-01 写节日名（柠檬黄字色 --hol-name），10-02～10-07 照常写农历，七天都画斜纹；10-10 补班：右上角“班”标 + 那一行“国庆节”
// • “班”标不和“今天”圆底叠在一起、整个落在格子里、靠右、字不溢出：手机 393 宽、窄屏 320 宽，中文“班”和韩文“근무”都量；
//   放得下时和日期数字同一行，320 宽的“근무”放不下，折到下一行（CalendarPage.module.css .cellTop）
//   （R-432 评审第 2、3 条：320 宽时“今天”圆底和“班”标叠在一起；韩文“근무”在 15 px 圆里装不下）
import type { Page } from '@playwright/test';
import { cached, idbPut } from './idb.ts';
import { expect, test } from './session-fixture.ts';

const TZ = 'Asia/Seoul';

/** 打开 2026 年 10 月月历，“现在”固定在 10-10（补班日）中午，等节假日拉到 */
async function openOct(page: Page, settings: readonly Record<string, unknown>[] = []): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-10-10T12:00:00+09:00'));
  await page.goto('/app/#/cal/month/2026-10');
  await page.getByTestId('cal-month').waitFor({ timeout: 30000 });
  if (settings.length > 0) {
    await idbPut(
      page,
      settings.map((s) => ['settings', cached(s)] as const),
    );
    await page.reload();
    await page.getByTestId('cal-month').waitFor();
  }
}

interface Box {
  readonly l: number;
  readonly r: number;
  readonly t: number;
  readonly b: number;
}

/** 10-10 那一格：格子、日期数字（今天圆底）、“班”标的位置，标的字有没有溢出 */
function measureWorkday(page: Page): Promise<{ cell: Box; num: Box; ban: Box | null; banText: string; banOverflow: boolean; numBg: string }> {
  return page.evaluate(() => {
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { l: r.left, r: r.right, t: r.top, b: r.bottom };
    };
    const c = document.querySelector<HTMLElement>('[data-testid="cal-month"] button[data-date="2026-10-10"]');
    if (!c) throw new Error('没有 10-10 这一格');
    // 第一行是“日期数字 + 补班标”
    const num = c.querySelector<HTMLElement>(':scope > span > span');
    if (!num) throw new Error('没有日期数字');
    const ban = c.querySelector<HTMLElement>('[data-testid="cal-ban"]');
    return {
      cell: box(c),
      num: box(num),
      ban: ban ? box(ban) : null,
      banText: ban?.textContent ?? '',
      banOverflow: ban ? ban.scrollWidth > ban.clientWidth + 0.5 : false,
      numBg: getComputedStyle(num).backgroundColor,
    };
  });
}

/** oneRow：标和日期数字排在同一行（放得下的宽度都该这样；320 宽的韩文“근무”放不下，折到下一行） */
function expectBanFits(m: Awaited<ReturnType<typeof measureWorkday>>, word: string, oneRow: boolean): void {
  expect(m.banText).toBe(word);
  const ban = m.ban;
  if (!ban) throw new Error('没有“班”标');
  expect(m.numBg, '10-10 是今天，日期数字有圆底').not.toBe('rgba(0, 0, 0, 0)');
  expect(m.banOverflow, '标里的字不溢出').toBe(false);
  // 落在格子里
  expect(ban.l).toBeGreaterThanOrEqual(m.cell.l);
  expect(ban.r).toBeLessThanOrEqual(m.cell.r);
  expect(ban.t).toBeGreaterThanOrEqual(m.cell.t);
  // 和今天圆底不重叠：左右分开，或上下分开
  const apart = ban.l >= m.num.r || ban.r <= m.num.l || ban.t >= m.num.b || ban.b <= m.num.t;
  expect(apart, `“班”标 ${JSON.stringify(ban)} 和今天圆底 ${JSON.stringify(m.num)} 叠在一起`).toBe(true);
  expect(ban.t < m.num.b, `标和日期数字${oneRow ? '同一行' : '折到下一行'}`).toBe(oneRow);
  // 靠右：右边离格子边不超过 4 px
  expect(m.cell.r - ban.r).toBeLessThanOrEqual(4);
}

test.describe('月历节假日：连休只在第一天写名字、补班“班”标（R-432）', () => {
  test.use({ loggedIn: true, viewport: { width: 393, height: 852 }, timezoneId: TZ, locale: 'zh-CN' });

  test('国庆：10-01 写“国庆节”（柠檬黄字色），10-02～10-07 写农历；七天都画斜纹，10-08 不画；10-10 补班“班”标 + 国庆节', async ({ page }) => {
    await openOct(page);
    const cell = (d: string) => page.locator(`[data-testid="cal-month"] button[data-date="2026-10-${d}"]`);
    await expect(cell('01')).toContainText('国庆节', { timeout: 10_000 });
    // 农历按需加载：等 10-02 那一行有字
    await expect(cell('02').locator(':scope > span').nth(1)).toHaveText(/\S/, { timeout: 10_000 });
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="cal-month"] button[data-date^="2026-10-"]')].slice(0, 10).map((c) => {
        // 格子里第二段是那一行（第一段是“日期数字 + 补班标”）
        const [top, line] = c.querySelectorAll<HTMLElement>(':scope > span');
        return {
          date: c.dataset.date ?? '',
          // 那一行紧跟在第一行下面（格子第一行的类名曾和页顶的 .top 撞名，被撑成 44 px 高，把农历挤到格子底部）
          gap: top && line ? line.getBoundingClientRect().top - top.getBoundingClientRect().bottom : -1,
          line: line?.textContent ?? '',
          // 第二段里第一行才是“那一行”（R-445 评审第 2 条：第二段外面一层 .lines 收着那一行和第二个节日名，颜色挂在里面）
          lineColor: line?.firstElementChild ? getComputedStyle(line.firstElementChild).color : '',
          stripe: getComputedStyle(c, '::before').content !== 'none',
          label: c.getAttribute('aria-label') ?? '',
        };
      }),
    );
    const at = (d: string) => rows.find((r) => r.date === `2026-10-${d}`);
    expect(at('01')?.line).toBe('国庆节');
    for (const d of ['02', '03', '04', '05', '06', '07']) {
      expect(at(d)?.line, `10-${d} 不再写节日名`).not.toContain('国庆');
      expect(at(d)?.line, `10-${d} 照常写农历`).not.toBe('');
      expect(at(d)?.lineColor, `10-${d} 农历是次要文字色，不是节日名色`).not.toBe(at('01')?.lineColor);
      expect(at(d)?.label, `10-${d} 读屏照旧念节日名`).toContain('国庆节');
    }
    for (const d of ['01', '02', '03', '04', '05', '06', '07', '10']) expect(at(d)?.stripe, `10-${d} 有斜纹`).toBe(true);
    for (const d of ['08', '09']) expect(at(d)?.stripe, `10-${d} 没有斜纹`).toBe(false);
    for (const r of rows) {
      expect(r.gap, `${r.date} 那一行紧跟日期数字`).toBeGreaterThanOrEqual(0);
      expect(r.gap, `${r.date} 那一行紧跟日期数字`).toBeLessThanOrEqual(4);
    }
    const m = await measureWorkday(page);
    expectBanFits(m, '班', true);
    await expect(cell('10')).toContainText('国庆节');
  });

  test('窄屏 320 宽：今天恰好是补班日，“班”标和今天圆底不重叠', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await openOct(page);
    await expect(page.locator('[data-testid="cal-month"] button[data-date="2026-10-10"]')).toContainText('班', { timeout: 10_000 });
    expectBanFits(await measureWorkday(page), '班', true);
  });
});

test.describe('韩文界面的补班“근무”标（R-432 评审第 2 条）', () => {
  test.use({ loggedIn: true, viewport: { width: 393, height: 852 }, timezoneId: TZ, locale: 'ko-KR' });
  const CN = [{ id: 'e2e-set-hol', key: 'cal.holidays', value: 'cn', deleted_at: null, undone: false, updated_at: 1 }];

  for (const width of [393, 320]) {
    test(`${width} 宽：“근무”放得下（不溢出、在格子里），不压今天圆底`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await openOct(page, CN);
      await expect(page.locator('[data-testid="cal-month"] button[data-date="2026-10-10"]')).toContainText('근무', { timeout: 10_000 });
      expectBanFits(await measureWorkday(page), '근무', width >= 393);
    });
  }
});
