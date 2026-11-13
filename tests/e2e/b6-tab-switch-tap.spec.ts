// 推进计划 7b：B6 皮肤 e2e 运行日志 route 1.63 → click 1.70 → settled 2.04，删除没生效。
// 根因（运行日志定的）：页签互切后 FADE_GUARD_MS（100 ms）以内落在 main 里的点按，按设计由 motion/index.ts 的 guardTaps 吞掉
// （主持人 11-05“过渡开始很短时间内的点按算点在旧画面上”、代码审查方案 B M8；时机细节由 b2-vt-taps.spec.ts 的 L17 守）。
// 这里守两件事：① 运行日志能看出是谁吞的：这一下记成“click … prevented-later”（run-log 的捕获监听最先跑，派发完补记）；
// ② e2e 等的是这个窗口本身：新页出来以后过 FADE_GUARD_MS 再点就是真点（不用等 400 ms 的 settled 快照）
import type { Page } from '@playwright/test';
import { FADE_GUARD_MS } from '../../src/motion/index.ts';
import { FAKE_USER_ID, expect, test } from './session-fixture.ts';

test.use({ loggedIn: true, timezoneId: 'Asia/Seoul', locale: 'zh-CN', viewport: { width: 390, height: 844 } });

const TZ = 'Asia/Seoul';
const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const go = (page: Page, hash: string) =>
  page.evaluate((h) => {
    window.location.hash = h;
  }, hash);

/** 本机库放一条今天的待办 n1 */
async function seed(page: Page): Promise<void> {
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30000 });
  const n1 = {
    user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, undone: false, short: null, project: '', due_time: null, done: false,
    id: 'n1', title: '买牛奶', due: today(), rev: 1, deleted_at: null,
  };
  await page.evaluate(async (n1) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('planner-v4');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = db.transaction(['todos'], 'readwrite');
    tx.objectStore('todos').put({ id: 'n1', server: n1, view: n1 });
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, n1);
  await page.reload();
  await page.getByTestId('todos-row-n1').waitFor({ timeout: 30000 });
}

const runLog = (page: Page) => page.evaluate(() => localStorage.getItem('lemo-run-log') ?? '');

test('随手记 → 待办：窗口以内点删除被吞、日志记 prevented-later；过了窗口再点真删、出撤销条', async ({ page }) => {
  await seed(page);
  await go(page, '#/notes');
  await page.getByTestId('notes').waitFor({ timeout: 30000 });
  // 切回待办，新页的删除 × 一出来就在页面里点（page 的往返赶不上 100 ms）；返回离换页过了多少毫秒
  const at = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        window.addEventListener(
          'hashchange',
          () => {
            const t0 = performance.now();
            const poll = (): void => {
              const x = document.querySelector<HTMLElement>('[data-testid="todos-del-n1"]');
              if (!x) return void requestAnimationFrame(poll);
              x.click();
              resolve(performance.now() - t0);
            };
            poll();
          },
          { once: true },
        );
        window.location.hash = '#/todos';
      }),
  );
  expect(at, '新页出来得太晚，已经过了吞点按的窗口').toBeLessThan(FADE_GUARD_MS);
  await expect.poll(() => runLog(page), { timeout: 3000 }).toMatch(/ click button#todos-del-n1 prevented-later/);
  await expect(page.getByTestId('todos-row-n1')).toHaveCount(1);
  await expect(page.locator('[data-undo-toast]')).toHaveCount(0);

  // 过了窗口（新页早已出来，从现在起再等一整段）再点：真删
  await page.waitForTimeout(FADE_GUARD_MS);
  await page.getByTestId('todos-del-n1').click();
  await expect(page.locator('[data-undo-toast]')).toBeVisible();
  await expect(page.getByTestId('todos-row-n1')).toHaveCount(0);
});
