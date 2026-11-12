// 打字条后面的整页液态玻璃（R-399，负责人 11-12 定中档 16px、点模糊处收起；ui/TypeBar.tsx 用 kit/components/Mist（样式 Mist.module.css，和随手记 R-401 共用））
// jsdom 不算布局、不画模糊，这里用真浏览器守三件事：
// ① 实际生效的滤镜是 blur(16px) saturate(1.8)；② 各层谁在上面：页面中间点到的是这一层，打字条、底栏、“＋”点到的是它们自己；
// ③ 触屏点这一层不点穿：点按落在一个页面按钮正上方，那个按钮收不到 click；没打字时打字条和这一层一起收起，打了字只收键盘
// 键盘弹起时的真机样子（iOS 合成、模糊性能）这里测不了，只能 iPhone 看
import { expect, test } from './session-fixture.ts';

test.describe('打字条后面的整页液态玻璃（R-399）', () => {
  test.use({ loggedIn: true, viewport: { width: 390, height: 844 }, hasTouch: true, timezoneId: 'Asia/Seoul' });

  for (const route of ['today', 'todos', 'calendar']) {
    test(`${route}：16px 模糊、层级、触屏点模糊处不点穿`, async ({ page }) => {
      await page.goto(`/app/#/${route}`);
      await expect(page.getByTestId('tabbar-add')).toBeVisible({ timeout: 20_000 });
      // 页面中间放一个“看不清的按钮”，记它收到几次 click（模拟被糊住的待办勾选框、卡片）
      await page.evaluate(() => {
        const b = document.createElement('button');
        b.textContent = '后面的按钮';
        b.style.cssText = 'position:fixed;left:150px;top:180px;width:90px;height:60px';
        b.addEventListener('click', () => {
          (window as unknown as { __behind: number }).__behind = ((window as unknown as { __behind?: number }).__behind ?? 0) + 1;
        });
        document.body.append(b);
      });
      await page.getByTestId('tabbar-add').click();
      const mist = page.getByTestId('type-mist');
      await expect(mist).toBeVisible();

      const seen = await page.evaluate(() => {
        /** 这一点上最上面的元素在不在 id 那块里面（含它自己） */
        const on = (id: string, x: number, y: number): boolean => document.elementFromPoint(x, y)?.closest(`[data-testid="${id}"]`) != null;
        const mid = (id: string): [number, number] => {
          const r = (document.querySelector(`[data-testid="${id}"]`) as HTMLElement).getBoundingClientRect();
          return [r.left + r.width / 2, r.top + r.height / 2];
        };
        const m = document.querySelector('[data-testid="type-mist"]') as HTMLElement;
        return {
          fx: getComputedStyle(m).backdropFilter,
          page: on('type-mist', 195, 210),
          bar: on('type-bar', ...mid('type-bar')),
          add: on('tabbar-add', ...mid('tabbar-add')),
        };
      });
      expect(seen).toEqual({ fx: 'blur(16px) saturate(1.8)', page: true, bar: true, add: true });

      // 打了字：触屏点模糊处只收键盘，打字条、字、这一层都在，后面的按钮没被点到
      const input = page.getByTestId('type-input');
      await input.fill('买牛奶');
      await page.touchscreen.tap(195, 210);
      await expect(input).not.toBeFocused();
      await expect(page.getByTestId('type-bar')).toBeVisible();
      await expect(mist).toBeVisible();
      await expect(input).toHaveValue('买牛奶');

      // 清空后再点：打字条和这一层一起收起，后面的按钮照样没被点到、页面没换
      await input.fill('');
      await page.touchscreen.tap(195, 210);
      await expect(page.getByTestId('type-bar')).toHaveCount(0);
      await expect(mist).toHaveCount(0);
      await page.waitForTimeout(400); // 等触屏点按的兼容鼠标事件和 click 都派发完
      expect(await page.evaluate(() => (window as unknown as { __behind?: number }).__behind ?? 0)).toBe(0);
      await expect(page).toHaveURL(new RegExp(`#/${route}$`));
    });
  }
});
