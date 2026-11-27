// 网页版宽屏今天页（负责人 11-25 两件），chromium、webkit 都跑（1440×900）：
//   ① 周历点某一天：整格不再画 2px 黑框（原 .wd[aria-pressed] 的 inset box-shadow），那天的日期数字变深色小方块（--cal-sel-bg，同手机月格 .sel .dayNum）；
//      鼠标点选不出焦点框，键盘 Tab 过去照旧有可见焦点框；选中的是今天时照旧柠檬黄（负责人 11-25“今天保留黄色”）
//   ② “今天的待办”卡：勾完的收成一行“已完成 N ›”（kit DoneFold，同待办页），默认收起、点开才列出，再点收起
import type { Page } from '@playwright/test';
import { cached, idbPut } from './idb.ts';
import { afterPageFade } from './page-helpers.ts';
import { expect, FAKE_USER_ID, test } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
const NOW = new Date('2026-11-25T12:00:00+09:00');
const T0 = NOW.getTime();
const base = { user_id: FAKE_USER_ID, created_at: T0 - 86_400_000, updated_at: T0 - 86_400_000, deleted_at: null, undone: false, short: null };
const TITLES = ['交 NEOX 片尾', '回复邮件', '买咖啡豆', '订春川的车票', '给猫买猫砂', '洗衣服'];
const id = (i: number): string => `0e2e0000-0000-4000-8000-0000000c1d${String(i).padStart(2, '0')}`;

test.use({ trace: 'off', loggedIn: true, viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, timezoneId: TZ, locale: 'zh-CN' });

/** 今天截止的 6 条待办，后 3 条已做完 */
async function openToday(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today')).toBeVisible({ timeout: 30_000 });
  const todos = TITLES.map((title, i) => ({ ...base, id: id(i), title, project: '', tz: TZ, due: '2026-11-25', due_time: null, done: i >= 3, done_at: i >= 3 ? T0 - 3_600_000 : null }));
  await idbPut(page, todos.map((r) => ['todos', cached(r)] as const));
  await page.reload();
  await expect(page.getByTestId('today-week')).toBeVisible({ timeout: 30_000 });
  await afterPageFade(page);
}

test.describe('网页版今天页：周历选中、已完成折叠（负责人 11-25）', () => {
  test('①-0 默认选中今天：今天的日期照旧柠檬黄；点 24 号那天变深色小方块、今天变回黄（负责人 11-25“今天保留黄色”）', async ({ page }) => {
    await openToday(page);
    const today = page.getByTestId('today-wd-2026-11-25');
    const bg = (sel: string, v: string) =>
      page.getByTestId(sel).evaluate((el, v) => {
        const probe = document.createElement('i');
        probe.style.background = `var(${v})`;
        el.append(probe);
        const want = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { got: getComputedStyle(el.querySelector('b') as HTMLElement).backgroundColor, want };
      }, v);
    await expect(today).toHaveAttribute('aria-pressed', 'true');
    let r = await bg('today-wd-2026-11-25', '--accent');
    expect(r.got, '默认选今天：柠檬黄').toBe(r.want);
    await page.getByTestId('today-wd-2026-11-24').click();
    await expect(today).toHaveAttribute('aria-pressed', 'false');
    r = await bg('today-wd-2026-11-24', '--cal-sel-bg');
    expect(r.got, '24 号：深色小方块').toBe(r.want);
    r = await bg('today-wd-2026-11-25', '--accent');
    expect(r.got, '今天：照旧柠檬黄').toBe(r.want);
    // 再点回今天：仍是柠檬黄，不变深色
    await today.click();
    await expect(today).toHaveAttribute('aria-pressed', 'true');
    r = await bg('today-wd-2026-11-25', '--accent');
    expect(r.got, '选中的是今天：柠檬黄').toBe(r.want);
  });

  test('① 选中那天不画整格黑框，日期数字变深色小方块；键盘焦点框照旧', async ({ page }) => {
    await openToday(page);
    const day = page.getByTestId('today-wd-2026-11-24');
    await day.click();
    await expect(day).toHaveAttribute('aria-pressed', 'true');
    const look = await day.evaluate((el) => {
      const probe = document.createElement('i');
      probe.style.background = 'var(--cal-sel-bg)';
      el.append(probe);
      const want = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const num = el.querySelector('b') as HTMLElement;
      return { shadow: getComputedStyle(el).boxShadow, outline: getComputedStyle(el).outlineStyle, numBg: getComputedStyle(num).backgroundColor, want };
    });
    expect(look.shadow, '整格不再有黑框').toBe('none');
    expect(look.outline, '鼠标点选不出焦点框').toBe('none');
    expect(look.numBg, '日期数字是 --cal-sel-bg 深色小方块').toBe(look.want);
    // 没选中的那几天（不是今天）日期数字不垫底
    expect(await page.getByTestId('today-wd-2026-11-26').locator('b').evaluate((b) => getComputedStyle(b).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    // 键盘 Tab 过去：可见焦点框（全站 :focus-visible）
    await page.getByTestId('today-wd-2026-11-23').focus();
    await page.keyboard.press('Tab');
    await expect(day).toBeFocused();
    expect(await day.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  });

  test('② 已完成的待办收成“已完成 N”，默认收起，点开才显示', async ({ page }) => {
    await openToday(page);
    const card = page.getByTestId('today-todos');
    for (let i = 0; i < 3; i++) await expect(card.getByText(TITLES[i] ?? '')).toBeVisible({ timeout: 20_000 });
    const fold = card.getByTestId('today-done-fold');
    await expect(fold).toHaveText(/已完成 3/);
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    for (let i = 3; i < 6; i++) await expect(card.getByText(TITLES[i] ?? '')).toHaveCount(0);
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    for (let i = 3; i < 6; i++) await expect(card.getByText(TITLES[i] ?? '')).toBeVisible();
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    for (let i = 3; i < 6; i++) await expect(card.getByText(TITLES[i] ?? '')).toHaveCount(0);
  });
});
