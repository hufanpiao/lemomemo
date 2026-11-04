// 设置 › 提醒与通知 设计复审第二轮（N1、N2、N4）：jsdom 量不出布局和焦点框，这里在真浏览器里看
// • N1：免打扰打开后，“从 / 到”时刻框高 ≥ 44（--hit），这一行上下各留 8px，两半一样宽
// • N2：韩文界面正文按词换行（全局 :lang(ko) word-break: keep-all，接手清单 KO-keep-all）
// • N4：子页标题（程序放焦点的 h1 tabIndex=-1）不画焦点框；能点的控件用键盘拿到焦点时照旧画
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

async function openDnd(page: Page): Promise<void> {
  await page.goto('/app/#/settings/remind/dnd');
  await page.getByTestId('settings-remind-dnd').waitFor({ timeout: 30000 });
  const sw = page.getByTestId('remind-dnd-on');
  if (!(await sw.isChecked())) await sw.click();
  await page.getByTestId('remind-dnd-start').waitFor();
}

test.describe('设置 › 提醒 设计复审第二轮', () => {
  test.use({ loggedIn: true, viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', locale: 'zh-CN' });

  test('N1：免打扰时刻框高 ≥ 44，这一行上下各留 8px，两半一样宽', async ({ page }) => {
    await openDnd(page);
    const m = await page.getByTestId('remind-dnd-start').evaluate((start) => {
      const end = document.querySelector('[data-testid="remind-dnd-end"]') as HTMLElement;
      const li = start.closest('li') as HTMLElement;
      const [a, b] = [start.closest('label') as HTMLElement, end.closest('label') as HTMLElement].map((l) => l.getBoundingClientRect());
      const r = li.getBoundingClientRect();
      const s = start.getBoundingClientRect();
      const e = end.getBoundingClientRect();
      return { sh: s.height, eh: e.height, top: Math.round(Math.min(a?.top ?? 0, b?.top ?? 0) - r.top), bottom: Math.round(r.bottom - Math.max(a?.bottom ?? 0, b?.bottom ?? 0)), wa: a?.width ?? 0, wb: b?.width ?? 0, ew: e.width, sw: s.width };
    });
    expect(m.sh).toBeGreaterThanOrEqual(44);
    expect(m.eh).toBeGreaterThanOrEqual(44);
    expect(m.top).toBe(8);
    expect(m.bottom).toBe(8);
    expect(Math.abs(m.wa - m.wb)).toBeLessThanOrEqual(1);
  });

  test('N4：刷新后子页标题拿着焦点但不画框；键盘把焦点移到返回按钮时照旧画', async ({ page }) => {
    await page.goto('/app/#/settings/remind');
    await page.getByTestId('settings-reminders').waitFor({ timeout: 30000 });
    await page.reload();
    await page.getByTestId('settings-reminders').waitFor({ timeout: 30000 });
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
    expect(await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle)).toBe('none');
    // 先按一下键（浏览器按“最后一次是键盘”判断 :focus-visible），再把焦点放到返回按钮
    await page.keyboard.press('Shift');
    await page.getByTestId('settings-remind-back').focus();
    const o = await page.getByTestId('settings-remind-back').evaluate((el) => ({ fv: el.matches(':focus-visible'), style: getComputedStyle(el).outlineStyle }));
    expect(o.fv).toBe(true);
    expect(o.style).toBe('solid');
    // 中文界面不受韩文按词换行影响（N2）
    expect(await page.evaluate(() => getComputedStyle(document.body).wordBreak)).toBe('normal');
  });
});

test.describe('韩文按词换行（N2、KO-keep-all）', () => {
  test.use({ loggedIn: true, viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', locale: 'ko-KR' });

  test('韩文界面：html lang 是 ko，正文 word-break 是 keep-all', async ({ page }) => {
    await page.goto('/app/#/settings');
    await page.getByTestId('settings-remind-entry').waitFor({ timeout: 30000 });
    await expect(page.locator('html')).toHaveAttribute('lang', /^ko/);
    const wb = await page.evaluate(() => [...document.querySelectorAll('main p')].map((p) => getComputedStyle(p).wordBreak));
    expect(wb.length).toBeGreaterThan(0);
    expect(new Set(wb)).toEqual(new Set(['keep-all']));
  });
});
