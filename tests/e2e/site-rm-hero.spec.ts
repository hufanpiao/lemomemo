// 官网首页：减少动态效果时首屏也静态露出那台手机（11-26 负责人选“补上”），位置、大小和平时首屏一致。
// site.spec.ts 已近 300 行上限，这一条单放。测试钩子 window.__lemoTest 的用法同 site.spec.ts
import { expect, test } from '@playwright/test';

test('首页：减少动态效果时首屏能看到手机，位置、大小和平时首屏一样', async ({ browser }) => {
  const box = async (reducedMotion: 'reduce' | 'no-preference') => {
    const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, reducedMotion });
    const page = await ctx.newPage();
    await page.addInitScript(() => { (window as unknown as { __lemoTest: object }).__lemoTest = {}; });
    await page.goto('/zh/');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __lemoTest?: { mode?: string } }).__lemoTest?.mode))
      .toBe(reducedMotion === 'reduce' ? 'static' : 'fx');
    const rig = page.locator('#film .rig');
    await expect(rig).toBeVisible();
    await expect(rig.locator('.pg.s-type')).toBeVisible();
    const b = await rig.boundingBox();
    await ctx.close();
    return b ?? { x: NaN, y: NaN, width: NaN, height: NaN };
  };
  const rm = await box('reduce'), fx = await box('no-preference');
  // 上沿露在首屏里
  expect(rm.y).toBeLessThan(932 - 100);
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(rm[k] - fx[k])).toBeLessThanOrEqual(1);
});
