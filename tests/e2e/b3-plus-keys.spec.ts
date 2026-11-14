// “＋”打字条的离线“准备中”和窗口内快捷键（B3 FA-2 M4、Q4；S24），以及中文相对时刻记下以后在今天页的时刻（R-374）：
// • 打字条那一块下载不到（离线冷启动又没缓存）：点“＋”显示“准备中”，不换页、不是点了没反应；“关闭”能关掉
//   （拦掉 TypeBar 那一块的请求模拟，小气泡、按住手势也在这一块里；SW 也拦掉，免得它从缓存里给）
// • Ctrl+N 打开打字条（焦点在输入框里）；记下一条以后打字条自动收起（R-392），这时按 Ctrl+Z 撤销这一批，提示条收起
// • 点“＋”冷启动当场聚焦（Q-24）、原地聚焦（Q-8）、贴底浮条按钮按下不让输入框失焦（Q-25）
// • 键盘弹着时底栏、“＋”藏起不上移，打字条贴键盘，收起后原样（R-389）
import type { Page } from '@playwright/test';
import { waitVoiceHost } from './fake-media.ts';
import { expect, test } from './session-fixture.ts';
import { logOnFail } from './fail-log.ts';

// 失败时带运行日志、控制台错误（B4b-3 返工第三条）
logOnFail(test);

const TYPEBAR = /\/TypeBar-[^/]*\.js$/;

/** 打字条那一块的主块和共用样式块（TypeBar.module）都下载到了（Q-8 用：它只看聚焦带不带 preventScroll、页面滚没滚，
 *  那一块晚一点执行也一样能判；要“点按当场聚焦”的 Q-24 不能只等下载，改等运行日志“voice host ready”，见那一组的说明）。
 *  共用样式块以后要是被并进主块，第二个等 10 秒超时后照常往下走 */
function typeBarLoaded(page: Page): Promise<unknown> {
  return Promise.all([
    page.waitForResponse(TYPEBAR),
    page.waitForResponse(/\/TypeBar\.module-[^/]*\.js$/, { timeout: 10_000 }).catch(() => undefined),
  ]);
}

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
// 这里等打字条那一块执行完，用脚本点一下“＋”，点按处理完的同一个任务里焦点必须已经在输入框里。
// 等什么（FA-3 复查时按调试日志查明）：那一块要等全部依赖（TypeBar、TypeBar.module、Form、UndoToast 几份 JS 和三份 CSS、TypeBarPreload）都到了才执行，
// app/plus-slot.tsx 这时才记住组件；只等主块的响应再留 200 ms，负载下会在执行之前点（日志：“typeBarAtClick=false … TypeBarPreload end=+171ms”，
// 1.5 秒后打字条已出来、“准备中”已收起——应用按设计走了“还没下载好”那条路，不是聚焦晚了）。
// 所以等应用自己的信号：运行日志“voice host ready”（那一块执行完、Preload 挂上、录音那一套也挂上以后才有）
test.describe('冷启动后第一次点“＋”当场聚焦（Q-24）', () => {
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Seoul' });

  test('打字条下载好以后第一次点“＋”：点按处理完时焦点已在输入框', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await waitVoiceHost(page, 0);
    // React 在点按这个任务的微任务里提交、聚焦（iOS 认这一段）；下一个任务（setTimeout 0）开始时焦点必须已经在输入框
    const focused = await page.evaluate(async () => {
      (document.querySelector('[data-testid="tabbar-add"]') as HTMLElement).click();
      await new Promise((ok) => setTimeout(ok, 0));
      return document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null;
    });
    expect(focused, '点按的同一个任务里就聚焦').toBe('type-input');
  });
});

// Q-8（负责人 11-11“点+输入框蓝色输入标位置不对”）：iPhone 上系统为了露出输入框会滚页面，滚过以后固定浮条里的光标偏位。
// 打字条一律原地聚焦（focus 带 preventScroll，platform/viewport.ts 的 focusInPlace）。系统那一侧的滚动、光标只能真机看，这里守两件：
// ① 点“＋”那一次 focus 带 preventScroll；② 页面先滚到 y=800 再点“＋”，滚动位置不变（Chromium 本来就不为固定元素滚，只防以后有人改成 scrollIntoView 之类）
test.describe('打字条原地聚焦（Q-8）', () => {
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Seoul' });

  test('点“＋”：输入框的 focus 带 preventScroll；先滚到 y=800 再点，scrollY 不变', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __focusOpts: string[] };
      w.__focusOpts = [];
      const orig = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function (this: HTMLElement, o?: FocusOptions) {
        if (this.getAttribute('data-testid') === 'type-input') w.__focusOpts.push(`preventScroll=${String(o?.preventScroll)}`);
        orig.call(this, o);
      };
    });
    const loaded = typeBarLoaded(page);
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await loaded;
    await page.waitForTimeout(200); // 下载完到模块执行、记住组件之间留一拍
    // 页面撑高到能滚 800（测试数据里今天页不够长）
    const y = await page.evaluate(() => {
      const pad = document.createElement('div');
      pad.style.height = '3000px';
      document.body.append(pad);
      window.scrollTo(0, 800);
      return window.scrollY;
    });
    expect(y).toBe(800);
    await page.getByTestId('tabbar-add').click();
    await expect(page.getByTestId('type-input')).toBeFocused();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __focusOpts: string[] }).__focusOpts)).toEqual(['preventScroll=true']);
    expect(await page.evaluate(() => window.scrollY), '聚焦没滚页面').toBe(800);
  });

  test('随手记页点“＋”：底部输入行（也是贴底浮条）的 focus 带 preventScroll', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __focusOpts: string[] };
      w.__focusOpts = [];
      const orig = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function (this: HTMLElement, o?: FocusOptions) {
        if (this.getAttribute('data-testid') === 'notes-input') w.__focusOpts.push(`preventScroll=${String(o?.preventScroll)}`);
        orig.call(this, o);
      };
    });
    await page.goto('/app/#/notes');
    await expect(page.getByTestId('notes-input')).toBeVisible();
    await page.getByTestId('tabbar-add').click();
    await expect(page.getByTestId('notes-input')).toBeFocused();
    expect(await page.evaluate(() => (window as unknown as { __focusOpts: string[] }).__focusOpts)).toEqual(['preventScroll=true']);
    await expect(page.getByTestId('type-bar')).toHaveCount(0);
  });
});

// Q-25（负责人 preview.277“记下”第一下点不动，运行日志：up button → focusout 输入框 → click 落到空白处）：
// iOS 手指抬起后先派 mousedown 让输入框失焦、键盘收、浮条往下挪，click 才到，按钮已不在手指下。两条浮条的 form 拦按钮上的 mousedown 默认（keepFieldFocus）。
// Chromium 不挪浮条，这里守“按下按钮那一刻焦点还在输入框”和“这一条确实记下了”
test.describe('贴底浮条按钮第一下点得动（Q-25）', () => {
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Seoul' });

  test('随手记：输入框聚焦着点“记下”，按下时焦点还在输入框；松开记下这一条，记下以后输入框失焦（R-416）', async ({ page }) => {
    await page.goto('/app/#/notes');
    const input = page.getByTestId('notes-input');
    await input.click();
    await input.fill('首尔林银杏黄了');
    await expect(input).toBeFocused();
    const add = page.getByTestId('notes-add');
    await add.hover();
    await page.mouse.down();
    await expect(input, '按下“记下”时输入框没失焦').toBeFocused();
    await page.mouse.up();
    await expect(page.getByTestId(/^notes-card-/).first()).toContainText('首尔林银杏黄了');
    await expect(input).toHaveValue('');
    // R-416（负责人 11-13“按回车记下后输入框应该消失，不是继续记下一条”）：记下以后收起键盘，取代原来的“接着记”
    await expect(input, '记下以后输入框失焦').not.toBeFocused();
  });

  test('打字条：输入框聚焦着点“记下”，按下时焦点还在输入框；松开记下这一条，照旧自动收起', async ({ page }) => {
    await page.goto('/app/#/todos');
    await expect(page.getByTestId('todos')).toBeVisible();
    await page.getByTestId('tabbar-add').click();
    const input = page.getByTestId('type-input');
    await expect(input).toBeFocused({ timeout: 10_000 });
    await input.fill('买牛奶');
    await page.getByTestId('type-bar').getByRole('button', { name: '记下' }).hover();
    await page.mouse.down();
    await expect(input, '按下“记下”时输入框没失焦').toBeFocused();
    await page.mouse.up();
    await expect(page.getByTestId('type-notice')).toContainText('买牛奶');
    await expect(page.getByTestId('type-bar'), '记下后照旧自动收起（R-392）').toHaveCount(0);
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

// R-389（负责人 11-11“输入的时候导航栏不应该跟着升上来”，弹窗选“底栏和＋都不浮上来”）：键盘弹着时底栏、“＋”藏着（留在屏幕底、被键盘盖住），
// 打字条直接贴键盘上沿；收起键盘后底栏、“＋”原样回来。真浏览器弹不出 iOS 键盘，这里照 platform/viewport.ts 键盘弹着时写的根节点几样
// （data-kbo、data-kbhide、--kb）摆出来，守样式这一侧：键盘高度、主屏幕版布局视口被压矮的真实样子只能 iPhone 看（视口监听本身在 viewport-closed.test.ts）
test.describe('键盘弹着时底栏和“＋”不跟着上来（R-389）', () => {
  test.use({ loggedIn: true, viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul' });

  for (const route of ['today', 'todos', 'notes']) {
    test(`${route}：键盘弹着底栏、“＋”藏起不上移；收起后位置和平时一样`, async ({ page }) => {
      await page.goto(`/app/#/${route}`);
      await expect(page.getByTestId('tabbar-add')).toBeVisible({ timeout: 20_000 });
      const rect = (id: string) =>
        page.evaluate((i) => {
          const r = (document.querySelector(`[data-testid="${i}"]`) as HTMLElement).getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
        }, id);
      const before = { bar: await rect('tabbar'), add: await rect('tabbar-add') };
      /** 照 viewport.ts 摆键盘：kb 是键盘压住布局视口的高度（浏览器里 > 0，iOS 主屏幕版布局视口自己被压矮时是 0）；null = 收起 */
      const keyboard = (kb: number | null) =>
        page.evaluate((k) => {
          const r = document.documentElement;
          if (k === null) {
            for (const a of ['data-kbo', 'data-kbhide']) r.removeAttribute(a);
            r.style.removeProperty('--kb');
            return;
          }
          r.setAttribute('data-kbo', '1');
          r.setAttribute('data-kbhide', '1');
          if (k > 0) r.style.setProperty('--kb', `${k}px`);
          else r.style.removeProperty('--kb');
        }, kb);
      for (const kb of [300, 0]) {
        await keyboard(kb);
        await expect(page.getByTestId('tabbar')).toBeHidden();
        await expect(page.getByTestId('tabbar-add')).toBeHidden();
        // 藏是 visibility，不是挪：位置还在屏幕底，没有往上跑
        expect(await rect('tabbar'), '底栏没跟着键盘上移').toEqual(before.bar);
        expect(await rect('tabbar-add'), '“＋”没跟着键盘上移').toEqual(before.add);
      }
      // 今天、待办：打字条贴键盘上沿（下沿 = 布局视口底 − --kb）
      if (route !== 'notes') {
        await keyboard(null);
        await page.getByTestId('tabbar-add').click();
        await expect(page.getByTestId('type-bar')).toBeVisible();
        for (const kb of [300, 0]) {
          await keyboard(kb);
          const inner = await page.evaluate(() => window.innerHeight);
          await expect.poll(async () => (await rect('type-bar')).bottom, '打字条贴着键盘').toBe(inner - kb);
        }
      }
      await keyboard(null);
      await expect(page.getByTestId('tabbar')).toBeVisible();
      await expect(page.getByTestId('tabbar-add')).toBeVisible();
      expect(await rect('tabbar'), '收起后底栏原样').toEqual(before.bar);
      expect(await rect('tabbar-add'), '收起后“＋”原样').toEqual(before.add);
    });
  }
});
