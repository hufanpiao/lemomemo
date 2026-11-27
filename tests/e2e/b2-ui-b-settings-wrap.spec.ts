// B2-UI-b W2（B11）设置说明文字断行的自动检查（任务单 M8）：
// • 中文：设置说明（kit 的 .meta、.note，设置页的 .sn）计算样式里 text-wrap-style 不是 pretty（pretty 让中文提前换行，拆开“之后”“能不能”）；
// • 韩文：同一批说明 word-break 是 keep-all（按词断、不拆词；<html lang> 由 src/platform/doc-locale.ts 设成界面语言）。
// 三种说明各取一处：设置首页“界面语言”一行的说明（.meta，分段按钮 aria-describedby 指向它；原来取“倾斜高光”开关的说明，倾斜高光 R-373 已删除）、数据页导出说明（.sn）、日历页节假日说明（.note）
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

type Wrap = { lang: string; textWrapStyle: string; wordBreak: string };

async function notes(page: Page): Promise<Record<string, Wrap>> {
  const read = (sel: string): Promise<Wrap> =>
    page.locator(sel).first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return { lang: document.documentElement.lang, textWrapStyle: cs.getPropertyValue('text-wrap-style'), wordBreak: cs.wordBreak };
    });
  const out: Record<string, Wrap> = {};
  await page.goto('/app/#/settings');
  await expect(page.locator('main[data-feature="settings"]')).toBeVisible({ timeout: 20_000 });
  // 网页版宽屏（≥ 1024，chromium 这一组是 1280 宽）设置首页是“左目录右详情”（2026-11-24 负责人定的“设置版本 1”），右边默认是账号一组；
  // 界面语言在“外观”一组，先点左目录的这一组。手机宽度（webkit 这一组）没有左目录，照旧在首页整页卡片里
  const look = page.getByTestId('settings-dk-nav-look');
  if (await look.isVisible()) await look.click();
  const lang = page.locator('[data-row-id="language"] [aria-describedby]').first();
  await expect(lang).toBeVisible();
  const metaId = await lang.getAttribute('aria-describedby');
  expect(metaId, '界面语言一行应挂着说明').toBeTruthy();
  out['meta'] = await read(`[id="${metaId}"]`);
  await page.goto('/app/#/settings/data');
  await expect(page.getByTestId('settings-export-notes')).toBeVisible();
  out['sn'] = await read('[data-testid="settings-export-notes"]');
  await page.goto('/app/#/settings/calendar');
  await expect(page.getByTestId('settings-calendar')).toBeVisible();
  out['note'] = await read('[data-testid="settings-calendar"] [role="radiogroup"] + p');
  return out;
}

test.describe('设置说明断行：中文（B2-UI-b W2）', () => {
  test.use({ loggedIn: true, locale: 'zh-CN', timezoneId: 'Asia/Seoul' });
  test('不用 text-wrap: pretty，也不按词断', async ({ page }) => {
    const n = await notes(page);
    for (const [k, v] of Object.entries(n)) {
      expect(v.lang, k).toMatch(/^zh/);
      expect(v.textWrapStyle, `${k} 的 text-wrap-style`).not.toBe('pretty');
      expect(v.wordBreak, `${k} 的 word-break`).not.toBe('keep-all');
    }
  });
});

test.describe('设置说明断行：韩文（B2-UI-b W2）', () => {
  test.use({ loggedIn: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  test('按词断（word-break: keep-all），不用 text-wrap: pretty', async ({ page }) => {
    const n = await notes(page);
    for (const [k, v] of Object.entries(n)) {
      expect(v.lang, k).toMatch(/^ko/);
      expect(v.wordBreak, `${k} 的 word-break`).toBe('keep-all');
      expect(v.textWrapStyle, `${k} 的 text-wrap-style`).not.toBe('pretty');
    }
  });
});
