// 页签互切进行中点页面内容（B2 FA-7 设计复审三 R6、L17；负责人 11-06 选方案 B 以后改写）：
// 页签互切不再起 View Transition，新页一换上就是真元素，只是 main 在做 opacity 0→1。
// 换页后 FADE_GUARD_MS（100 ms，按挂钟）以内落在 main 里的点按吞掉（代码审查方案 B M8：沿用主持人 11-05“过渡开始很短时间内的点按算点在旧画面上”）；
// 过了这一段，点按直接落在新页面的真元素上。
// 办法：点页签时在页面里记下时刻（capture 监听），把 main 的淡入动画暂停在指定时刻，等挂钟过了窗口再用 page.mouse 按真实坐标点；
// 窗口以内的那一下在页面里用定时器按坐标发 pointerdown、click（page.mouse 的往返本身就要几十毫秒，赶不上 10 ms）
import type { Page } from '@playwright/test';
import { FAKE_USER_ID, expect, test } from './session-fixture.ts';

const bar = (page: Page) => page.getByTestId('tabbar');
const tab = (page: Page, name: string) => bar(page).locator(`a[data-tab="${name}"]`);

/** 等新页 main 的淡入出来，暂停在 at 毫秒处；返回暂停时的不透明度（没等到是 -1）。同时确认没有 View Transition */
const holdAt = (page: Page, at: number) =>
  page
    .waitForFunction(
      (ms) => {
        if (document.getAnimations().some((x) => String((x.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition'))) return 'vt';
        const a = document.querySelector('main')?.getAnimations() ?? [];
        for (const x of a) {
          x.pause();
          x.currentTime = ms;
        }
        return a.length > 0 ? Number(getComputedStyle(document.querySelector('main') as Element).opacity) : null;
      },
      at,
      { timeout: 2000, polling: 4 },
    )
    .then((h) => h.jsonValue());
/** 下一次点页签时记下时刻（window.__tabAt），用来按挂钟等过吞点按的窗口 */
const markTab = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __tabAt?: number };
    delete w.__tabAt;
    document.querySelector('[data-testid="tabbar"]')?.addEventListener(
      'click',
      () => {
        w.__tabAt = performance.now();
      },
      { capture: true, once: true },
    );
  });
/** 等到点页签以后过了 ms 毫秒（挂钟） */
const sinceTab = (page: Page, ms: number) =>
  page.waitForFunction((t) => {
    const at = (window as unknown as { __tabAt?: number }).__tabAt;
    return at !== undefined && performance.now() - at >= t;
  }, ms);
const finishAll = (page: Page) =>
  page.evaluate(() => {
    for (const x of document.querySelector('main')?.getAnimations() ?? []) x.finish();
  });

test.describe('页签互切淡入进行中点页面内容（FA-7 R6、L17，方案 B）', () => {
  // 浏览器时区和造数据用的首尔一致：本机不在首尔时，跨零点那一小时“今天”对不上（11-06 23 点实测挂）
test.use({ loggedIn: true, timezoneId: 'Asia/Seoul', viewport: { width: 375, height: 812 } });

  // 目标：今天页右上角的头像（进设置的链接）。从待办点“今天”，淡入中按头像的真实坐标点
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

  test('换页 100 ms 以后、淡入还在进行（停在 10、80、200 ms 处）点新页面上的链接：直接点到（进设置），没有 View Transition', async ({ page }) => {
    const at = await setup(page);
    for (const ms of [10, 80, 200]) {
      await markTab(page);
      await tab(page, 'today').click();
      const op = await holdAt(page, ms);
      expect(op, `${ms} ms：起了 View Transition`).not.toBe('vt');
      expect(typeof op === 'number' && op < 1, `${ms} ms：没等到淡入`).toBe(true);
      await sinceTab(page, 130);
      await page.mouse.click(at.x, at.y);
      await expect(page).toHaveURL(/#\/settings$/, { timeout: 3000 });
      await page.goto('/app/#/todos');
      await expect(page.getByTestId('todos')).toBeVisible();
    }
  });

  // L17（代码审查复审建议 + 主持人 11-05 收紧、设计复审五 R6-a）：防的是“看着旧画面、点到新页面会改数据的东西”。
  // 方案 B 下旧页在点页签那一刻就没了：换页 10 ms 点到新页同一位置的删除 × 要吞掉（不删、不出撤销条）；200 ms 点是真点，删掉、有撤销条、能撤销（代码审查方案 B M8）
  test('L17 换页 10 ms 点今天页待办的删除 ×：吞掉，不删；200 ms 点：真删、有撤销条、能撤销', async ({ page }) => {
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

    // 10 ms：页面里点页签、10 ms 后按 × 的坐标发 pointerdown、click（和真手指一样按坐标找元素）
    await tab(page, 'todos').click();
    await expect(page.getByTestId('todos')).toBeVisible();
    await finishAll(page);
    const hit = await page.evaluate(
      ({ x, y }) =>
        new Promise<string>((res) => {
          const t = document.querySelector<HTMLElement>('[data-testid="tabbar"] a[data-tab="today"]');
          t?.click();
          const t0 = performance.now();
          setTimeout(() => {
            const el = document.elementFromPoint(x, y);
            const o = { bubbles: true, cancelable: true, clientX: x, clientY: y };
            el?.dispatchEvent(new PointerEvent('pointerdown', o));
            el?.dispatchEvent(new PointerEvent('pointerup', o));
            el?.dispatchEvent(new MouseEvent('click', o));
            res(`${el?.closest('[data-testid]')?.getAttribute('data-testid') ?? '-'}@${Math.round(performance.now() - t0)}`);
          }, 10);
        }),
      del,
    );
    expect(hit, '10 ms 时坐标上应是新页的删除 ×').toMatch(/^today-del-t3@\d+$/);
    expect(Number(hit.split('@')[1]), '定时器拖过了吞点按窗口').toBeLessThan(100);
    await finishAll(page);
    await page.waitForTimeout(300);
    await expect(page.getByTestId('today-todo-t3')).toBeVisible();
    await expect(page.getByTestId('today-toast')).toHaveCount(0);

    // 200 ms：真点
    await tab(page, 'todos').click();
    await expect(page.getByTestId('todos')).toBeVisible();
    await finishAll(page);
    await markTab(page);
    await tab(page, 'today').click();
    const op = await holdAt(page, 120);
    expect(op).not.toBe('vt');
    await sinceTab(page, 200);
    await page.mouse.click(del.x, del.y);
    await finishAll(page);
    await expect(page.getByTestId('today-todo-t3')).toHaveCount(0);
    await expect(page.getByTestId('today-toast')).toBeVisible();
    await page.getByTestId('today-toast').getByRole('button').first().click();
    await expect(page.getByTestId('today-todo-t3')).toBeVisible();
    await expect(page).toHaveURL(/#\/today$/);
  });
});

// 从设置回今天走的是整页 View Transition（只有一边有底栏）：GlassBar 在过渡回调里重新挂上，GlassBarFx 第二次是缓存、几毫秒就挂好，
// 过渡中它是在的（代码审查方案 B：R6 删掉后又恢复）。webkit 过渡期间点按都算到 <html> 上；过渡开始 50 ms 以后点页面内容要能点到（R6 代点）
const vtHoldAt = (page: Page, at: number) =>
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

test.describe('从设置回今天的过渡中点页面内容（R6 恢复）', () => {
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 } });

  test('过渡停在 200 ms 处点今天页的头像：替它点到（进设置）', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    const box = await page.getByTestId('today-settings').boundingBox();
    expect(box).not.toBeNull();
    const at = { x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 };
    await page.getByTestId('today-settings').click();
    await expect(page).toHaveURL(/#\/settings$/);
    await page.waitForTimeout(600);
    await page.locator('main a[href$="#/today"]').first().click();
    expect(await vtHoldAt(page, 200), '没等到切页过渡').toBeGreaterThan(0);
    // 过渡中 GlassBarFx 已经挂上（底栏的实色带在）
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 1000 });
    await page.mouse.click(at.x, at.y);
    await expect(page).toHaveURL(/#\/settings$/, { timeout: 3000 });
  });
});
