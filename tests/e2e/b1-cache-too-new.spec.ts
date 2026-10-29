// TC-B1-49（接手清单 K6-ver-new）：本机库来自更新的版本（DB 版本比本 App 的高）时，/app/ 只渲染整屏提示
// “本机数据是新版本写的，请更新 App”，只给“去更新 / 刷新”，不渲染今天页、不给继续使用；焦点落在“去更新”
// 造法：先在同源的 /app/auth/ 用更高版本（99）建好 planner-v4，再打开 /app/（openCache 遇到 VersionError → version_too_new）
// CSP 违规由 csp-fixture 自动检查
import { expect, test } from './session-fixture.ts';

test.use({ loggedIn: true });

test('本机库版本比 App 高：整屏提示请更新，只有两个按钮，焦点在“去更新”，今天页不渲染', async ({ page }) => {
  await page.goto('/app/auth/');
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('planner-v4', 99);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('meta');
        };
        req.onsuccess = () => {
          req.result.close();
          resolve();
        };
        req.onerror = () => reject(new Error(String(req.error)));
      }),
  );

  await page.goto('/app/');
  const screen = page.getByTestId('cache-too-new');
  await expect(screen).toBeVisible();
  await expect(page.getByRole('alertdialog', { name: '本机数据是新版本写的，请更新 App' })).toBeVisible();
  await expect(screen.getByRole('button')).toHaveText(['去更新', '刷新']);
  await expect(screen.getByRole('button', { name: '去更新' })).toBeFocused();
  await expect(page.locator('main[data-feature]')).toHaveCount(0);

  // 库原样不动（没被降级删掉）
  const version = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('planner-v4');
        req.onsuccess = () => {
          const v = req.result.version;
          req.result.close();
          resolve(v);
        };
      }),
  );
  expect(version).toBe(99);
});
