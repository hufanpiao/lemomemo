// 临时探查（B6 开工前看现状），交付前删掉
import { expect, test } from './session-fixture.ts';

test.use({ loggedIn: true, viewport: { width: 1280, height: 800 } });

test('现状截图', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium');
  const dir = process.env['LEMO_SHOT_DIR'] ?? '.';
  for (const t of ['today', 'calendar', 'todos', 'notes', 'settings']) {
    await page.goto(`/app/#/${t}`);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${dir}/now-${t}.png` });
  }
  await expect(page.locator('body')).toBeVisible();
});
