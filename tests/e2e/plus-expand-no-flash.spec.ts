// 打字条“展开编辑”进新建页不闪原页面（负责人 11-18 录屏：今天、日历、待办页点“＋”再点“详细”，第 104 帧先露出一帧清晰全亮的原页面再淡出）。
// 根因：展开时先拿掉打字条和模糊层，再起整页过渡，过渡截的旧画面只能是没模糊的原页面（WebKit 过渡截图本来也不画 backdrop-filter）。
// 现在直接换页：断言没起 View Transition，并且逐帧看，没有一帧是“原页面还在、打字条已经没了”。
// 负责人 11-18 选 A：打字条那张卡长成新建页（motion growSwap）——新建页 main 上有一次 clip-path 动画，放完旧页快照、打字条都收掉
import { expect, test } from './session-fixture.ts';
import { logOnFail } from './fail-log.ts';

logOnFail(test);

test.describe('展开编辑不闪原页面', () => {
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Seoul' });

  for (const [from, page0, to, dest] of [
    ['today', 'today', /#\/event\/new$/, 'event-edit-title'],
    ['todos', 'todos', /#\/todo\/(new|[0-9a-f-]{36})$/, 'todo-edit-title'],
    ['calendar', 'cal-title', /#\/event\/new$/, 'event-edit-title'],
  ] as const) {
    test(`${from}：点“展开编辑”直接换成新建页，没有只剩原页面的那一帧`, async ({ page }) => {
      await page.goto(`/app/#/${from}`);
      await expect(page.getByTestId(page0)).toBeVisible();
      await page.getByTestId('tabbar-add').click();
      await expect(page.getByTestId('type-bar')).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('type-input').fill('看牙医');
      await page.evaluate((ids) => {
        const w = window as unknown as { __vt: number; __bad: number; __blank: number; __stop: boolean; __grow: number; __hid: number };
        w.__vt = 0;
        w.__grow = 0;
        const anim = Element.prototype.animate;
        Element.prototype.animate = function (this: Element, ...a: Parameters<Element['animate']>) {
          if (this.tagName === 'MAIN' && JSON.stringify(a[0]).includes('clipPath')) w.__grow++;
          return anim.apply(this, a);
        };
        w.__blank = 0;
        w.__bad = 0;
        w.__hid = 0;
        w.__stop = false;
        const d = document as Document & { startViewTransition?: (cb: () => void) => unknown };
        const orig = d.startViewTransition?.bind(d);
        if (orig)
          d.startViewTransition = (cb: () => void) => {
            w.__vt++;
            return orig(cb);
          };
        const tick = (): void => {
          if (w.__stop) return;
          const shown = (sel: string): boolean => {
            const el = document.querySelector(sel);
            return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
          };
          const bar = shown('[data-testid="type-bar"]');
          if (shown(`[data-testid="${ids[0]}"]`) && !bar) w.__bad++;
          if (!bar && !shown(`[data-testid="${ids[1]}"]`)) w.__blank++;
          // 代码审查 H2：模糊层还在，新建页的临时层级（z-index）却已经还原了，这一帧新建页被模糊层盖住
          const main = document.querySelector<HTMLElement>(`main:has([data-testid="${ids[1]}"]), main[data-testid="${ids[1]}"]`);
          if (main && document.querySelector('[data-testid="type-mist"]') && main.style.zIndex === '' && !shown(`[data-testid="${ids[0]}"]`)) w.__hid++;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }, [page0, dest]);
      await page.getByTestId('type-bar').getByRole('button', { name: '展开编辑' }).click();
      await expect(page).toHaveURL(to);
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const w = window as unknown as { __vt: number; __bad: number; __blank: number; __stop: boolean; __grow: number; __hid: number };
        w.__stop = true;
        return { vt: w.__vt, bad: w.__bad, blank: w.__blank, grow: w.__grow, hid: w.__hid };
      });
      expect(r).toEqual({ vt: 0, bad: 0, blank: 0, grow: 1, hid: 0 });
      await expect(page.getByTestId('type-bar')).toHaveCount(0);
      await expect(page.locator('[data-tab-ghost]')).toHaveCount(0);
      // 打字条卸掉以后才还原（MutationObserver 回调里），等一下再读
      await expect.poll(() => page.evaluate(() => document.querySelector('main')?.getAttribute('style') ?? '')).toBe('');
    });
  }
});
