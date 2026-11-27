// 今日运势卡（负责人 11-21 定稿：卡片“八字 B 版”、填写层“丙 打年份”）：真浏览器里走一遍 填生日 → 卡片变 → 清除 → 回到没填
// • 本机库 settings 里那一行（键 cal.fortune_birth）：填了是 {y,m,d,h}；清除后值抹成 {}、不软删（主持人 11-22：软删了别的设备拿旧行再存会被服务器回 gone）
// • 填写层不用系统日期框（页面上没有 input），年份是自己画的数字小键盘
import type { Page } from '@playwright/test';
import { idbRead } from './idb.ts';
import { SHEET_GONE } from './page-helpers.ts';
import { expect, test } from './session-fixture.ts';

const TZ = 'Asia/Seoul';

type Cached = { id: string; view?: Record<string, unknown> | null };
async function birthRow(page: Page): Promise<Record<string, unknown> | null> {
  const all = (await idbRead<Cached[]>(page, 'settings', 'getAll')) ?? [];
  return all.map((r) => r.view ?? null).find((v) => v?.['key'] === 'cal.fortune_birth') ?? null;
}

test.describe('今日运势卡', () => {
  test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, timezoneId: TZ, locale: 'zh-CN' });

  test('填生日 → 卡片变成星星和白话 → 详情 → 改生日里清除 → 回到没填', async ({ page }) => {
    test.setTimeout(120_000); // 弹层开关三次，每次退场在 webkit 软件合成下要几秒（SHEET_GONE）
    await page.goto('/app/#/calendar');
    await page.getByTestId('calendar-page').waitFor({ timeout: 30000 });
    const empty = page.getByTestId('fortune-empty');
    await expect(empty).toContainText('想按八字看每天的运势？');

    await page.getByTestId('fortune-set').click();
    const setup = page.getByTestId('fortune-setup');
    await expect(setup).toBeVisible();
    await expect(page.getByTestId('fortune-keypad')).toBeVisible();
    await expect(page.locator('[role="dialog"] input')).toHaveCount(0);
    await page.getByTestId('fortune-key-9').click();
    await page.getByTestId('fortune-key-2').click();
    await expect(page.getByTestId('fortune-keypad')).toHaveCount(0);
    await expect(page.getByTestId('fortune-year')).toHaveText('1992');
    await page.getByTestId('fortune-m-6').click();
    await page.getByTestId('fortune-d-12').click();
    await expect(page.getByTestId('fortune-res')).toContainText('你的本色：');
    await page.getByTestId('fortune-ok').click();
    await expect(setup).toHaveCount(0, SHEET_GONE);

    const card = page.getByTestId('fortune-card');
    await expect(card).toBeVisible();
    await expect(empty).toHaveCount(0);
    expect(Number(await card.getAttribute('data-stars'))).toBeGreaterThanOrEqual(2);
    expect(Number(await card.getAttribute('data-stars'))).toBeLessThanOrEqual(5);
    await expect(page.getByTestId('fortune-meta')).toContainText('幸运数字');
    await expect.poll(() => birthRow(page)).toMatchObject({ value: { y: 1992, m: 6, d: 12, h: null } });
    expect((await birthRow(page))?.['deleted_at'] ?? null).toBeNull();

    await card.click();
    const detail = page.getByTestId('fortune-detail');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('仅供娱乐');
    await page.getByTestId('fortune-edit').click();
    await expect(setup).toBeVisible();
    await page.getByTestId('fortune-clear').click();
    await expect(setup).toHaveCount(0, SHEET_GONE);
    await expect(empty).toBeVisible();
    await expect(card).toHaveCount(0);
    await expect.poll(async () => (await birthRow(page))?.['value']).toEqual({});
    expect((await birthRow(page))?.['deleted_at'] ?? null).toBeNull();
    // 弹层关上，焦点回到卡片的位置（换成了“填生日”），不掉到 body
    await expect(page.getByTestId('fortune-set')).toBeFocused();

    // 重开页面也还是没填
    await page.reload();
    await expect(page.getByTestId('fortune-empty')).toBeVisible({ timeout: 30000 });
  });
});
