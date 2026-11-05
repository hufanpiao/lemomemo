// 切页过渡进行中点页面内容（B2 FA-7 设计复审三 R6，主持人 11-05 定做法 A）：webkit 过渡期间把点按算到 <html> 上，页面里的链接、按钮接不到；
// 首屏后部分 GlassBarFx 接住落在 <html> 上的点按：过渡开始 50 ms 以内的丢掉（算点在旧画面上），之后的先把过渡放完、再按坐标替真正的目标点
// 办法同 b2-tabbar-transition.spec.ts 的 R4：等切页过渡真的在跑，把伪元素动画暂停在指定时刻，再用 page.mouse 按真实坐标点
import type { Page } from '@playwright/test';
import { FAKE_USER_ID, expect, test } from './session-fixture.ts';

const bar = (page: Page) => page.getByTestId('tabbar');
const tab = (page: Page, name: string) => bar(page).locator(`a[data-tab="${name}"]`);

/** 等切页过渡出来，暂停在 at 毫秒处；返回动画个数 */
const holdAt = (page: Page, at: number) =>
  page
    .waitForFunction(
      (ms) => {
        const vt = document.getAnimations().filter((x) => String((x.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition'));
        for (const x of vt) {
          x.pause();
          x.currentTime = ms;
        }
        return vt.length;
      },
      at,
      { timeout: 2000, polling: 4 },
    )
    .then((h) => h.jsonValue());
const finishAll = (page: Page) =>
  page.evaluate(() => {
    for (const x of document.getAnimations()) if (String((x.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition')) x.finish();
  });

test.describe('切页过渡进行中点页面内容（FA-7 R6）', () => {
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 } });

  // 目标：今天页右上角的头像（进设置的链接）。从待办点“今天”，过渡中按头像的真实坐标点
  const setup = async (page: Page) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    const box = await page.getByTestId('today-settings').boundingBox();
    expect(box).not.toBeNull();
    await tab(page, 'todos').click();
    await expect(page.getByTestId('todos')).toBeVisible();
    await finishAll(page);
    return { x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 };
  };

  test('过渡开始 50 ms 以后点新页面上的链接：过渡放完，替它点到（进设置）', async ({ page }) => {
    const at = await setup(page);
    for (const ms of [80, 200]) {
      await tab(page, 'today').click();
      expect(await holdAt(page, ms), `${ms} ms：没等到切页过渡`).toBeGreaterThan(0);
      await page.mouse.click(at.x, at.y);
      await expect(page).toHaveURL(/#\/settings$/, { timeout: 3000 });
      await page.goto('/app/#/todos');
      await expect(page.getByTestId('todos')).toBeVisible();
    }
  });

  test('过渡开始 50 ms 以内的点按丢掉：不代点，照常停在新页面', async ({ page }) => {
    const at = await setup(page);
    await tab(page, 'today').click();
    expect(await holdAt(page, 10)).toBeGreaterThan(0);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(300);
    await finishAll(page);
    await expect(page.getByTestId('today')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/#\/today$/);
  });

  // L17（代码审查复审建议 + 主持人 11-05 收紧、设计复审五 R6-a）：过渡开始 50 ms 后点到新页面同一位置会改数据的东西——
  // 待办的勾选圈（复选框）不代点、删除 ×（data-no-proxy）不代点，数据不变、没有撤销条；过渡放完后正常点 ×，有撤销条、能撤销
  test('L17 过渡中点到今天页待办的勾选圈、删除 ×：都不代点；过渡外点 × 有撤销条、能撤销', async ({ page }) => {
    const TZ = 'Asia/Seoul';
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
    const row = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null, id: 't3', title: '买牛奶', project: '', due: day, due_time: null, done: false };
    await page.goto('/app/#/todos');
    await expect(page.getByTestId('todos')).toBeVisible();
    await page.evaluate(async (r) => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const o = indexedDB.open('planner-v4');
        o.onsuccess = () => res(o.result);
        o.onerror = () => rej(o.error);
      });
      const tx = db.transaction(['todos'], 'readwrite');
      tx.objectStore('todos').put({ id: r.id, server: r, view: r });
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    }, row);
    await page.goto('/app/#/today');
    await page.reload();
    await expect(page.getByTestId('today-todo-t3')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    await expect(page.locator('[data-testid="today"] [data-state="entering"]')).toHaveCount(0);
    await page.waitForTimeout(400);
    const centre = async (id: string) => {
      const b = await page.getByTestId(id).boundingBox();
      expect(b, id).not.toBeNull();
      return { x: (b?.x ?? 0) + (b?.width ?? 0) / 2, y: (b?.y ?? 0) + (b?.height ?? 0) / 2 };
    };
    const del = await centre('today-del-t3');
    const done = await centre('today-done-t3');

    for (const [name, at] of [['删除 ×', del], ['勾选圈', done]] as const) {
      await tab(page, 'todos').click();
      await expect(page.getByTestId('todos')).toBeVisible();
      await finishAll(page);
      await tab(page, 'today').click();
      expect(await holdAt(page, 200), `${name}：没等到切页过渡`).toBeGreaterThan(0);
      await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(300);
      await finishAll(page);
      await expect(page.getByTestId('today')).toBeVisible();
      await page.waitForTimeout(300);
      await expect(page.getByTestId('today-todo-t3'), name).toBeVisible();
      await expect(page.getByTestId('today-done-t3'), name).not.toBeChecked();
      await expect(page.getByTestId('today-toast'), name).toHaveCount(0);
      await expect(page).toHaveURL(/#\/today$/);
    }

    // 对照：不在过渡里正常点 ×，有撤销条，点撤销行回来
    await page.getByTestId('today-del-t3').click();
    await expect(page.getByTestId('today-todo-t3')).toHaveCount(0);
    await expect(page.getByTestId('today-toast')).toBeVisible();
    await page.getByTestId('today-toast').getByRole('button').first().click();
    await expect(page.getByTestId('today-todo-t3')).toBeVisible();
  });
});
