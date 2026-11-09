// R-354 动画库移出首屏（做法 A，方案 docs/10-架构/方案-动画库移出首屏.md 第 4 节 K2、K9）在真浏览器里验证：
// • K2 换实现时焦点不丢：今天页冷启动时列表是门面画的静态，动画实现（motion-impl 块）到了以后整个列表重挂一次换上。
//   焦点在列表里时不换（src/motion/swap-guard.ts）：拦住动画实现块，把焦点放到行里的删除按钮上，再放行；
//   到了以后焦点还在那个按钮上。焦点移出列表以后换上：之后删一行，有退场（data-state="leaving"），说明已经换成动画实现
// • K9 整页提醒冷启动：动画实现没到时页面照常显示，[data-appear] 没有停在透明里；之后动画实现照常到（data-motion="ready"）
// • M1（负责人选“修掉”）：实现到达前就已显示的 Appear（提醒横幅、冲突卡这类），到了以后按“已停稳”换上，关掉时有退场淡出
//   （用开发版试验页 #/dev-csp 的 Appear toast 模拟；关掉那一刻外层带 data-state="leaving"，透明度从 1 往下走，然后移除）
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';
import { FAKE_USER_ID } from './session-fixture.ts';

const TZ = 'Asia/Seoul';
const IMPL = /\/motion-impl-[^/]*\.js$/;
const base = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null };
const day = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + n * 86400000));
const TD = [
  { ...base, id: 't1', title: '交周报', project: '', due: day(0), due_time: null, done: false },
  { ...base, id: 't2', title: '订机票', project: '', due: day(0), due_time: null, done: false },
  { ...base, id: 't3', title: '买牛奶', project: '', due: day(0), due_time: null, done: false },
];

async function seed(page: Page): Promise<void> {
  await page.goto('/app/#/todos');
  await page.getByTestId('todos').waitFor({ timeout: 30000 });
  await page.evaluate(async (rows) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('planner-v4');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = db.transaction(['todos'], 'readwrite');
    for (const r of rows) tx.objectStore('todos').put({ id: r.id, server: r, view: r });
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, TD);
}

const ready = (page: Page) => page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30000 });
const focused = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);

test.describe('R-354：动画实现到了以后换上（K2、K9）', () => {
  // 不让 SW 接管：webkit 里 SW 取的请求 page.route 拦不到（seed 以后第二次打开已被接管，动画实现块直接从 SW 缓存来）
  test.use({ loggedIn: true, serviceWorkers: 'block' });

  test('焦点在今天页列表里时不换、焦点不丢；移出以后换上，删行有退场', async ({ page }) => {
    // 从第一次打开就拦：webkit 会把同一页面里取到过的模块放在内存缓存里，之后刷新不再发请求
    let hold = true;
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    await page.route(IMPL, async (route) => {
      if (hold) await gate;
      await route.continue();
    });
    await seed(page);
    await page.goto('/app/');
    await page.reload();
    await page.getByTestId('today-todo-t3').waitFor({ timeout: 30000 });
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-motion')), '拦住期间不该到').toBeNull();
    await page.getByTestId('today-del-t3').focus();
    expect(await focused(page)).toBe('today-del-t3');
    hold = false;
    release();
    await ready(page);
    await page.waitForTimeout(600);
    expect(await focused(page), '换实现把焦点弄丢了').toBe('today-del-t3');
    // 焦点移出列表：守卫放行，换成动画实现
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForTimeout(600);
    await page.getByTestId('today-del-t2').click();
    await expect(page.locator('[data-testid="today-todo-t2"][data-state="leaving"], [data-state="leaving"] [data-testid="today-todo-t2"]').first(), '换上以后删行要有退场').toBeAttached({ timeout: 2000 });
    await expect(page.getByTestId('today-todo-t2')).toHaveCount(0, { timeout: 3000 });
  });

  test('整页提醒冷启动：动画实现没到时照常显示，没有停在透明里的 [data-appear]', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    let hold = true;
    await page.route(IMPL, async (route) => {
      if (hold) await gate;
      await route.continue();
    });
    await page.goto(`/app/#/remind/todo/00000000-0000-4000-8000-000000000001?due=${Date.now() - 60000}`);
    await expect(page.getByTestId('remind-full')).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(1500);
    const stuck = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-appear]')].filter((e) => Number(getComputedStyle(e).opacity) < 0.99).map((e) => e.dataset['appear']),
    );
    expect(stuck, '动画实现没到时有元素停在透明里').toEqual([]);
    hold = false;
    release();
    await ready(page);
    await expect(page.getByTestId('remind-full')).toBeVisible();
  });

  test('M1：实现到达前已显示的 Appear，到了以后关掉有退场淡出（不是当场消失）', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    await page.route(IMPL, async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto('/app/#/dev-csp');
    await page.getByTestId('motion-toggle').click();
    const box = page.locator('[data-appear="toast"]', { has: page.getByTestId('motion-box') });
    await expect(box).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-motion')), '拦住期间不该到').toBeNull();
    release();
    await ready(page);
    await page.waitForTimeout(600);
    await expect(box, '换上以后还是停稳的样子').toHaveAttribute('style', /opacity: 1/);
    await page.getByTestId('motion-toggle').click();
    await expect(box, '关掉有退场').toHaveAttribute('data-state', 'leaving', { timeout: 1000 });
    const op = await box.evaluate((e) => Number(getComputedStyle(e).opacity)).catch(() => 0);
    expect(op, '退场途中透明度在往下走').toBeLessThan(1);
    await expect(box).toHaveCount(0, { timeout: 3000 });
  });
});
