// P-idb-tx 余项（B1 接手清单 P-idb-tx“还没测”，10-30）：TC-B1-48 真 App 上的“A 页自动重新载入”，真浏览器（chromium、webkit）。
// b1-idb-tx.spec.ts 测的是 cache.ts 单独打包的 versionchange 行为；这里是整个 App：
//   ① A 页带假会话打开 /app/，等今天页出来（本机库 planner-v4 由 App 自己按 DB_VERSION 打开，连接一直开着）；
//   ② 同一浏览器上下文里的 B 页在同源的 /app/auth/（不开本机库）以 DB_VERSION + 1 打开 planner-v4；
//   ③ A 页收到 versionchange → cache.ts 先关库 → boot.ts 转给 upgrade.onCacheVersionChange → 没有 busy（今天页不占 busy）
//      → 直接重新载入（main.tsx 的 deps.reload）；B 页的升级不被挡住、打开成功。
// 重新载入之后 A 页按旧的 DB_VERSION 去开已经是新版本的库，会出 cache-too-new 整屏提示（TC-B1-49）——这是预期的，一并断言。
// 做不到的两项（写进接手清单）：
//   • “有新版本 · 重新打开”横幅：只在 busy 不为 0 时出；B1 唯一的 busy 来源是 holdBusy('sign_out')，退出登录本身就要关库删库，
//     真页面上造不出“busy 中收到 versionchange”；等 B2 的编辑、录音界面接上 holdBusy 再测（单测：update-banner.test.tsx）。
//   • 真页面上的 blocked 提示：只在本页升级库、被别的旧页挡住时出；真 App 的 DB_VERSION = 1，不会去升级别人的库（单测：cache-blocked.test.tsx、boot-blocked.test.ts）。
// CSP 违规由 csp-fixture 自动检查
import { expect, test } from './session-fixture.ts';

test.use({ loggedIn: true });

test('TC-B1-48 A 页自动重新载入：别的页升级本机库 → A 页（没有 busy）关库并重新载入，升级方打开成功；载入后出 cache-too-new', async ({ page, context }) => {
  // ① A 页：真 App 起来，今天页渲染
  await page.goto('/app/');
  await expect(page.locator('main[data-feature]')).toBeVisible();
  const v0 = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open('planner-v4');
        req.onsuccess = () => {
          const v = req.result.version;
          req.result.close();
          resolve(v);
        };
        req.onerror = () => reject(new Error(String(req.error)));
      }),
  );
  expect(v0).toBeGreaterThan(0);
  // 打个标记：重新载入以后 window 换新，标记就没了
  await page.evaluate(() => {
    (window as unknown as { __mark?: number }).__mark = 1;
  });
  const reloaded = page.waitForEvent('load');

  // ② B 页：同源、不开本机库的页面，以 v0 + 1 打开
  const other = await context.newPage();
  await other.goto('/app/auth/');
  const upgraded = await other.evaluate(
    (to) =>
      new Promise<{ version: number; blocked: boolean }>((resolve, reject) => {
        let blocked = false;
        const req = indexedDB.open('planner-v4', to);
        req.onblocked = () => {
          blocked = true;
        };
        req.onupgradeneeded = () => undefined;
        req.onsuccess = () => {
          const v = req.result.version;
          req.result.close();
          resolve({ version: v, blocked });
        };
        req.onerror = () => reject(new Error(String(req.error)));
      }),
    v0 + 1,
  );
  expect(upgraded.version, '升级方打开成功').toBe(v0 + 1);
  expect(upgraded.blocked, 'A 页先关了库，升级没被挡').toBe(false);

  // ③ A 页重新载入过：load 事件来了，标记没了
  await reloaded;
  await expect.poll(() => page.evaluate(() => (window as unknown as { __mark?: number }).__mark ?? null)).toBeNull();
  // 载入后的 App 按旧版本开新库 → cache-too-new 整屏提示（预期），今天页不渲染
  await expect(page.getByTestId('cache-too-new')).toBeVisible();
  await expect(page.locator('main[data-feature]')).toHaveCount(0);
  await other.close();
});
