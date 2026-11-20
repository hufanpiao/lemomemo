// 页签互切进行中点页面内容（B2 FA-7 设计复审三 R6、L17；负责人 11-06 选方案 B 以后改写）：
// 页签互切不再起 View Transition，新页一换上就是真元素，只是 main 在做 opacity 0→1。
// 换页后 FADE_GUARD_MS（100 ms，按挂钟）以内落在 main 里的点按吞掉（代码审查方案 B M8：沿用主持人 11-05“过渡开始很短时间内的点按算点在旧画面上”）；
// 过了这一段，点按直接落在新页面的真元素上。
// 负责人 11-18 选切页方案 B（按底栏顺序左右滑入）以后，滑入途中元素还没到最终位置：一律按点下那一刻屏上看得到的位置点（手指点的是看到的地方）
// 办法：点页签时在页面里记下时刻（capture 监听），把 main 的淡入动画暂停在指定时刻，等挂钟过了窗口再用 page.mouse 按真实坐标点；
// 窗口以内的那一下在页面里用定时器按坐标发 pointerdown、click（page.mouse 的往返本身就要几十毫秒，赶不上 10 ms）
import type { Page } from '@playwright/test';
import { cached, idbPut } from './idb.ts';
import { FAKE_USER_ID, expect, test } from './session-fixture.ts';

const bar = (page: Page) => page.getByTestId('tabbar');
const tab = (page: Page, name: string) => bar(page).locator(`a[data-tab="${name}"]`);

/** 等新页 main 里的切页淡入出来（11-19 头像整块重写起，有头像的页淡入加在 main 里不含头像的那几块上，不在 main 自己身上，page-swap.ts 的 fadeTargets），
 *  暂停在 at 毫秒处；返回暂停时的不透明度（没等到是 -1）。同时确认没有 View Transition */
const holdAt = (page: Page, at: number) =>
  page
    .waitForFunction(
      (ms) => {
        if (document.getAnimations().some((x) => String((x.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition'))) return 'vt';
        const a = document.querySelector('main')?.getAnimations({ subtree: true }) ?? [];
        for (const x of a) {
          x.pause();
          x.currentTime = ms;
        }
        const el = (a[0]?.effect as KeyframeEffect | null)?.target;
        return a.length > 0 && el ? Number(getComputedStyle(el).opacity) : null;
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
    for (const x of document.querySelector('main')?.getAnimations({ subtree: true }) ?? []) x.finish();
  });

test.describe('页签互切淡入进行中点页面内容（FA-7 R6、L17，方案 B）', () => {
  // 浏览器时区和造数据用的首尔一致：本机不在首尔时，跨零点那一小时“今天”对不上（11-06 23 点实测挂）
test.use({ loggedIn: true, timezoneId: 'Asia/Seoul', viewport: { width: 375, height: 812 } });

  /** 元素此刻在屏上的中心（滑入途中暂停时就是暂停那一刻的位置） */
  const centreNow = async (page: Page, id: string) => {
    const b = await page.getByTestId(id).boundingBox();
    expect(b, id).not.toBeNull();
    return { x: (b?.x ?? 0) + (b?.width ?? 0) / 2, y: (b?.y ?? 0) + (b?.height ?? 0) / 2 };
  };
  // 目标：今天页右上角的头像（进设置的链接）。从待办点“今天”，切换中按头像此刻的真实坐标点
  const setup = async (page: Page) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    await tab(page, 'todos').click();
    await expect(page.getByTestId('todos')).toBeVisible();
    await finishAll(page);
  };

  test('换页 100 ms 以后、淡入还在进行（停在 10、80、150 ms 处；--dur-tab 11-18 起 200ms）点新页面上的链接：直接点到（进设置），没有 View Transition', async ({ page }) => {
    await setup(page);
    for (const ms of [10, 80, 150]) {
      await markTab(page);
      await tab(page, 'today').click();
      const op = await holdAt(page, ms);
      expect(op, `${ms} ms：起了 View Transition`).not.toBe('vt');
      expect(typeof op === 'number' && op < 1, `${ms} ms：没等到淡入`).toBe(true);
      await sinceTab(page, 130);
      const at = await centreNow(page, 'today-settings');
      await page.mouse.click(at.x, at.y);
      await expect(page).toHaveURL(/#\/settings$/, { timeout: 3000 });
      await page.goto('/app/#/todos');
      await expect(page.getByTestId('todos')).toBeVisible();
    }
  });

  // L17（代码审查复审建议 + 主持人 11-05 收紧、设计复审五 R6-a）：防的是“看着旧画面、点到新页面会改数据的东西”。
  // 方案 B 下旧页在点页签那一刻就没了：换页 10 ms 点到新页同一位置的打勾圆圈要吞掉（不勾）；200 ms 点是真点，勾上、收进“已过去”（代码审查方案 B M8）。
  // 原来点的是行尾删除 ×，负责人 11-15 去掉 ×、改左滑删除（R-428），改点同样会改数据的打勾圆圈
  test('L17 换页 10 ms 点今天页待办的打勾圆圈：吞掉，不勾；200 ms 点：真勾上、收进已过去', async ({ page }) => {
    const TZ = 'Asia/Seoul';
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
    const row = { user_id: FAKE_USER_ID, tz: TZ, created_at: 1, updated_at: 1, deleted_at: null, undone: false, short: null, id: 't3', title: '买牛奶', project: '', due: day, due_time: null, done: false };
    await page.goto('/app/#/todos');
    await expect(page.getByTestId('todos')).toBeVisible();
    await idbPut(page, [['todos', cached(row)]]);
    await page.goto('/app/#/today');
    await page.reload();
    await expect(page.getByTestId('today-row-t3')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    await expect(page.locator('[data-testid="today"] [data-state="entering"]')).toHaveCount(0);
    await page.waitForTimeout(400);
    const centre = async (id: string) => {
      const b = await page.getByTestId(id).boundingBox();
      expect(b, id).not.toBeNull();
      return { x: (b?.x ?? 0) + (b?.width ?? 0) / 2, y: (b?.y ?? 0) + (b?.height ?? 0) / 2 };
    };
    await centre('today-done-t3');

    // 10 ms：页面里点页签、10 ms 后按打勾圆圈的坐标发 pointerdown、click（和真手指一样按坐标找元素）
    await tab(page, 'todos').click();
    await expect(page.getByTestId('todos')).toBeVisible();
    await finishAll(page);
    const hit = await page.evaluate(
      () =>
        new Promise<string>((res) => {
          const t = document.querySelector<HTMLElement>('[data-testid="tabbar"] a[data-tab="today"]');
          t?.click();
          const t0 = performance.now();
          setTimeout(() => {
            // 按打勾圆圈此刻（滑入途中）在屏上的位置点
            const r = document.querySelector('[data-testid="today-done-t3"]')?.getBoundingClientRect();
            const x = (r?.left ?? 0) + (r?.width ?? 0) / 2;
            const y = (r?.top ?? 0) + (r?.height ?? 0) / 2;
            const el = document.elementFromPoint(x, y);
            const o = { bubbles: true, cancelable: true, clientX: x, clientY: y };
            el?.dispatchEvent(new PointerEvent('pointerdown', o));
            el?.dispatchEvent(new PointerEvent('pointerup', o));
            el?.dispatchEvent(new MouseEvent('click', o));
            res(`${el?.closest('[data-testid]')?.getAttribute('data-testid') ?? '-'}@${Math.round(performance.now() - t0)}`);
          }, 10);
        }),
    );
    expect(hit, '10 ms 时坐标上应是新页的打勾圆圈').toMatch(/^today-done-t3@\d+$/);
    expect(Number(hit.split('@')[1]), '定时器拖过了吞点按窗口').toBeLessThan(100);
    await finishAll(page);
    await page.waitForTimeout(300);
    await expect(page.getByTestId('today-row-t3')).toBeVisible();
    await expect(page.getByTestId('today-done-t3')).not.toBeChecked();
    await expect(page.getByTestId('today-past')).toHaveCount(0);

    // 200 ms：真点
    await tab(page, 'todos').click();
    await expect(page.getByTestId('todos')).toBeVisible();
    await finishAll(page);
    await markTab(page);
    await tab(page, 'today').click();
    const op = await holdAt(page, 120);
    expect(op).not.toBe('vt');
    await sinceTab(page, 200);
    const del = await centreNow(page, 'today-done-t3');
    await page.mouse.click(del.x, del.y);
    await finishAll(page);
    await expect(page.getByTestId('today-past')).toContainText('买牛奶');
    await expect(page).toHaveURL(/#\/today$/);
  });
});

// 从设置回今天走的是整页推页（只有一边有底栏）：GlassBar 在换页时重新挂上，GlassBarFx 第二次是缓存、几毫秒就挂好，过渡中它是在的。
// 11-20 起整页推页不用 View Transition（motion/page-swap.ts）：过渡中页面、底栏都是真元素，点按直接落在它们身上，原来的 R6 按坐标代点删了
/** 把这次整页推页的动画（关键帧里带 vw 的平移，WAAPI）暂停在 at 毫秒处；返回暂停了几个 */
const vtHoldAt = (page: Page, at: number) =>
  page
    .waitForFunction(
      (ms) => {
        const vt = document.getAnimations().filter(
          (x) => x.effect instanceof KeyframeEffect && x.effect.getKeyframes().some((k) => String(k['translate'] ?? '').includes('vw')),
        );
        for (const x of vt) {
          x.pause();
          x.currentTime = ms;
        }
        return document.documentElement.hasAttribute('data-vt') ? vt.length : 0;
      },
      at,
      { timeout: 2000, polling: 4 },
    )
    .then((h) => h.jsonValue());

test.describe('从设置回今天的过渡中点页面内容', () => {
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 } });

  test('过渡停在 200 ms 处点今天页的头像：直接点到真元素（进设置）', async ({ page }) => {
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
    // 动画拨到了 200 ms，真实时间才过去几十毫秒：换页后 FADE_GUARD_MS（100 ms）以内落在 main 里的点按按 M8 吞掉（page-swap guardTaps，
    // 手指多半是冲着旧画面按的），所以真等过这 100 ms 再点，和真机过渡放到 200 ms 时点一样
    await page.waitForTimeout(150);
    await page.mouse.click(at.x, at.y);
    await expect(page).toHaveURL(/#\/settings$/, { timeout: 3000 });
  });
});
