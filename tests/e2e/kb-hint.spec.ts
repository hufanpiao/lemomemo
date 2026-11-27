// 打字条打开时按上次键盘高度就位（台账 #484，负责人 11-24 蓝色光标跑到输入框上面；platform/kb-hint.ts）。
// 499 日志：聚焦时输入框在底部（y=644），约 0.1 秒后键盘出来跳到 y=380，系统光标没跟上这次位移。
// 电脑上没有键盘，这里只核“聚焦那一刻打字条已经停在记住的高度上”和“等不到键盘就落回、忘掉”；光标画得对不对只能真机看
import { expect, test } from './session-fixture.ts';
import { logOnFail } from './fail-log.ts';
import { readRunLogInPage } from './page-helpers.ts';

logOnFail(test);
test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, timezoneId: 'Asia/Seoul' });

const fromBottom = (): number => {
  const bar = document.querySelector('[data-testid="type-bar"]');
  return bar ? Math.round(window.innerHeight - bar.getBoundingClientRect().bottom) : -1;
};

test('记过键盘高度：打开打字条聚焦时已经停在那个高度；等不到键盘落回底部并忘掉', async ({ page }) => {
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today')).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem('lemo.kb-last', '300');
    const w = window as Window & { __at?: number };
    // 输入框聚焦的那一刻量打字条离屏幕底多远
    document.addEventListener('focusin', (e) => {
      if ((e.target as Element | null)?.getAttribute('data-testid') !== 'type-input') return;
      const bar = document.querySelector('[data-testid="type-bar"]');
      w.__at = bar ? Math.round(window.innerHeight - bar.getBoundingClientRect().bottom) : -1;
    });
  });
  await page.getByTestId('tabbar-add').click();
  await expect(page.getByTestId('type-input')).toBeFocused();
  expect(await page.evaluate(() => (window as Window & { __at?: number }).__at)).toBe(300);
  await expect.poll(() => page.evaluate(readRunLogInPage)).toContain('kbhint on px=300');
  // 电脑上键盘不会出来：到点撤掉，落回底栏上方，记住的高度清掉
  await expect.poll(() => page.evaluate(readRunLogInPage), { timeout: 5000 }).toContain('kbhint off why=timeout');
  expect(await page.evaluate(fromBottom)).toBeLessThan(200);
  expect(await page.evaluate(() => localStorage.getItem('lemo.kb-last'))).toBeNull();
});

test('没记过键盘高度：打字条照旧从底栏上方打开', async ({ page }) => {
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today')).toBeVisible();
  await page.getByTestId('tabbar-add').click();
  await expect(page.getByTestId('type-input')).toBeFocused();
  expect(await page.evaluate(fromBottom)).toBeLessThan(200);
  expect(await page.evaluate(readRunLogInPage)).not.toContain('kbhint on');
});
