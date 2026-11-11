// “＋”打字条的离线“准备中”和窗口内快捷键（B3 FA-2 M4、Q4；S24），以及中文相对时刻记下以后在今天页的时刻（R-374）：
// • 打字条那一块下载不到（离线冷启动又没缓存）：点“＋”显示“准备中”，不换页、不是点了没反应；“关闭”能关掉
//   （拦掉 TypeBar、TypeBarPreload 两块的请求模拟；SW 也拦掉，免得它从缓存里给）
// • Ctrl+N 打开打字条（焦点在输入框里）；记下一条以后打字条自动收起（R-392），这时按 Ctrl+Z 撤销这一批，提示条收起
import { expect, test } from './session-fixture.ts';

const TYPEBAR = /\/TypeBar(Preload)?-[^/]*\.js$/;

test.describe('“＋”离线“准备中”（B3 Q4）', () => {
  test.use({ loggedIn: true, serviceWorkers: 'block', viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Seoul' });

  test('打字条那一块下载不到：点“＋”显示“准备中”，不换页；“关闭”关掉', async ({ page }) => {
    await page.route(TYPEBAR, (route) => route.abort('internetdisconnected'));
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await page.getByTestId('tabbar-add').click();
    const wait = page.getByTestId('plus-preparing');
    await expect(wait).toBeVisible();
    await expect(wait).toHaveText(/准备中/);
    await expect(wait).toHaveAttribute('role', 'status');
    await expect(page).toHaveURL(/#\/today$/);
    await expect(page.getByTestId('type-bar')).toHaveCount(0);
    await page.getByTestId('plus-preparing-close').click();
    await expect(wait).toHaveCount(0);
  });
});

// Q-24（负责人 11-11“点+不出来键盘，还要点输入框才出来键盘”）：iOS 只在点按的同一个任务里 focus 才弹键盘。
// 运行日志：冷启动后第一次点＋，focusin 晚 310～480ms，键盘没弹；之后再点都在 10ms 内，键盘弹了。
// 这里等打字条那一块下载完，用脚本点一下“＋”，点按处理完的同一个任务里焦点必须已经在输入框里
test.describe('冷启动后第一次点“＋”当场聚焦（Q-24）', () => {
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Seoul' });

  test('打字条下载好以后第一次点“＋”：点按处理完时焦点已在输入框', async ({ page }) => {
    const loaded = page.waitForResponse(/\/TypeBar-[^/]*\.js$/);
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await loaded;
    await expect.poll(() => page.evaluate(() => Boolean(document.querySelector('[data-testid="tabbar-add"]')))).toBe(true);
    await page.waitForTimeout(200); // 下载完到模块执行、记住组件之间留一拍
    // React 在点按这个任务的微任务里提交、聚焦（iOS 认这一段）；下一个任务（setTimeout 0）开始时焦点必须已经在输入框
    const focused = await page.evaluate(async () => {
      (document.querySelector('[data-testid="tabbar-add"]') as HTMLElement).click();
      await new Promise((ok) => setTimeout(ok, 0));
      return document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null;
    });
    expect(focused, '点按的同一个任务里就聚焦').toBe('type-input');
  });
});

test.describe('窗口内快捷键（S24）', () => {
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Seoul' });

  test('Ctrl+N 打开打字条；记下一条后打字条自动收起（R-392），按 Ctrl+Z 撤销这一批', async ({ page }) => {
    await page.goto('/app/#/todos');
    await expect(page.getByTestId('todos')).toBeVisible();
    await page.keyboard.press('Control+n');
    await expect(page.getByTestId('type-bar')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('type-input')).toBeFocused();
    await expect(page).toHaveURL(/#\/todos$/);
    await page.getByTestId('type-input').fill('买牛奶');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('type-notice')).toContainText('买牛奶');
    await expect(page.getByTestId('type-bar')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('type-notice')).toHaveCount(0);
  });
});

test.describe('中文相对时刻（R-374）', () => {
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Seoul' });

  test('“半小时后开会”按记下那一刻算：10:00 记下就是今天 10:30 的日程', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-11-02T10:00:00+09:00') });
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await page.keyboard.press('Control+n');
    await expect(page.getByTestId('type-input')).toBeFocused({ timeout: 10_000 });
    await page.getByTestId('type-input').fill('半小时后开会');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('type-notice')).toContainText('开会');
    // 今天页的日程行：时刻 10:30、标题“开会”（相对说法不留在标题里）
    const row = page.getByTestId('today').locator('[data-testid^="today-event-"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('10:30');
    await expect(row).toContainText('开会');
    await expect(row).not.toContainText('半小时');
  });
});
