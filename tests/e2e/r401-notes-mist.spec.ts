// 随手记输入框后面的整页模糊（R-401，负责人 11-13“随手记点输入框背景也要模糊”；kit Mist，和打字条 R-399 同一份；NotesPage.tsx、NotesPage.module.css 的 .mist）
// jsdom 不算布局、不画模糊，这里用真浏览器守：
// ① 实际生效的滤镜是 blur(16px) saturate(1.8)；② 各层谁在上面：页面中间点到的是模糊层，输入行点到的是输入行
//    （电脑上输入行的外框 .dock 是 sticky、自成一层，也要压在模糊层上面）；
// ③ 触屏点模糊处不点穿：落在一个页面按钮正上方，那个按钮收不到 click；输入框失焦、模糊层没了，打的字留着
// 键盘弹起时的真机样子（iOS 合成、模糊性能）这里测不了，只能 iPhone 看
import { expect, test } from './session-fixture.ts';

const SIZES = [
  { name: '手机', viewport: { width: 390, height: 844 }, hasTouch: true },
  { name: '电脑', viewport: { width: 1280, height: 800 }, hasTouch: false },
] as const;

for (const size of SIZES) {
  test.describe(`随手记输入框后面的整页模糊（R-401）· ${size.name}`, () => {
    test.use({ loggedIn: true, viewport: size.viewport, hasTouch: size.hasTouch, timezoneId: 'Asia/Seoul' });

    test('16px 模糊、输入行在上面、点模糊处不点穿、只收键盘', async ({ page }) => {
      await page.goto('/app/#/notes');
      const input = page.getByTestId('notes-input');
      await expect(input).toBeVisible({ timeout: 20_000 });
      // 页面中间放一个“看不清的按钮”，记它收到几次 click（模拟被糊住的随手记卡片）
      await page.evaluate(() => {
        const b = document.createElement('button');
        b.textContent = '后面的按钮';
        b.style.cssText = 'position:fixed;left:150px;top:180px;width:90px;height:60px';
        b.addEventListener('click', () => {
          (window as unknown as { __behind: number }).__behind = ((window as unknown as { __behind?: number }).__behind ?? 0) + 1;
        });
        document.body.append(b);
      });
      const mist = page.getByTestId('notes-mist');
      await expect(mist).toHaveCount(0);
      await input.click();
      await expect(mist).toBeVisible();

      const seen = await page.evaluate(() => {
        /** 这一点上最上面的元素在不在 id 那块里面（含它自己） */
        const on = (id: string, x: number, y: number): boolean => document.elementFromPoint(x, y)?.closest(`[data-testid="${id}"]`) != null;
        const r = (document.querySelector('[data-testid="notes-input"]') as HTMLElement).getBoundingClientRect();
        const m = document.querySelector('[data-testid="notes-mist"]') as HTMLElement;
        return { fx: getComputedStyle(m).backdropFilter, page: on('notes-mist', 195, 210), row: on('notes-input-row', r.left + 20, r.top + r.height / 2) };
      });
      expect(seen).toEqual({ fx: 'blur(16px) saturate(1.8)', page: true, row: true });

      await input.fill('明天买牛奶');
      if (size.hasTouch) await page.touchscreen.tap(195, 210);
      else await page.mouse.click(195, 210);
      await expect(input).not.toBeFocused();
      await expect(mist).toHaveCount(0);
      await expect(input).toHaveValue('明天买牛奶');
      await page.waitForTimeout(400); // 等触屏点按的兼容鼠标事件和 click 都派发完
      expect(await page.evaluate(() => (window as unknown as { __behind?: number }).__behind ?? 0)).toBe(0);
      await expect(page).toHaveURL(/#\/notes$/);
    });
  });
}
