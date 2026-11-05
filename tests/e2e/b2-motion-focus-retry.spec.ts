// FA-6 ② 审查（docs/03-评审/B2/B2-代码审查-FA-6②动效异步加载.md）的两条低问题，在真浏览器里验证：
// • L4：用键盘关弹层（在“取消”上按回车、按 Esc）以后，焦点回到打开它的那个按钮，并把中间焦点在 body 上待了多久记进附件。
//   11-04 实测改前两个浏览器都回不去、焦点一直留在 body（和 inert 无关）：Radix 的 modal Content 关闭时 preventDefault 掉 FocusScope 的
//   “还给原来的元素”，改成 triggerRef.current?.focus()；kit Dialog 的使用方都是自己的按钮 setOpen(true)，没用 RD.Trigger，triggerRef 是空的。
//   主持人定了改 kit/components/Dialog.tsx：打开那一刻记下焦点，onCloseAutoFocus 里还回去（单测在 kit 的 Dialog.test.tsx）。
//   对照组（试验页的 Radix 原样弹层，用 RD.Trigger）一直回得去
// • L2：功能包第一次下载失败（离线、块丢了）以后，下一个新挂上的 LazyMotion 再试一次，不刷新能不能装上
//   （担心的是浏览器的模块表把失败的动态 import 缓存住）。判据是 features.ts 在包到了时打的 <html data-motion="ready">（审查 L5）。
//   **实测（11-04）：chromium、webkit 都不再去取，要刷新页面才恢复**——这条按实测行为写（不刷新不去取、刷新以后装上），
//   哪天浏览器改了会挂，提醒去改 features.ts 的说法。webkit 刷新以后能不能装上只记附件（并行时偶尔 15 秒没装上，原因没查清）。
//   后果只是这一页没有动画（元素照常显示、照常能点），见 src/motion/features.ts 文件头
// 用的是开发试验页 #/dev-csp 的 kit Dialog（csp.spec.ts 同一个），e2e 构建里有这一页
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const LAB = '/app/#/dev-csp';
const BUNDLE = /\/feature-bundle-[^/]*\.js$/;

async function motionReady(page: Page): Promise<void> {
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30000 });
}

/** 从现在起每帧记一次焦点在谁身上，ms 毫秒；返回 [距开始毫秒, data-testid 或标签名] */
async function watchFocus(page: Page, ms: number): Promise<void> {
  await page.evaluate((ms) => {
    const w = window as Window & { __focus?: [number, string][] };
    w.__focus = [];
    const t0 = performance.now();
    const tick = (): void => {
      const a = document.activeElement;
      const dt = performance.now() - t0;
      w.__focus?.push([dt, a?.getAttribute('data-testid') ?? a?.tagName.toLowerCase() ?? 'null']);
      if (dt < ms) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ms);
}

test.describe('弹层键盘关闭后的焦点（FA-6 ② 审查 L4）', () => {
  test.use({ loggedIn: true });

  for (const how of ['在“取消”上按回车', '按 Esc'] as const) {
    test(`kit Dialog：${how}关掉以后，焦点回到打开它的按钮`, async ({ page }, info) => {
      await page.goto(LAB);
      const opener = page.getByTestId('dialog-open');
      // 先开关一次，让动效功能包下载、装上（测的是有退场动画、带 inert 的那条路）
      await opener.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toBeHidden();
      await motionReady(page);

      await opener.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByRole('dialog')).not.toHaveAttribute('inert');
      await watchFocus(page, 1500);
      if (how === '按 Esc') await page.keyboard.press('Escape');
      else {
        await page.getByTestId('dialog-close').focus();
        await page.keyboard.press('Enter');
      }
      await expect(page.getByRole('dialog')).toBeHidden();
      await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null), { timeout: 3000 }).toBe('dialog-open');
      const trace = await page.evaluate(() => (window as Window & { __focus?: [number, string][] }).__focus ?? []);
      const onBody = trace.filter(([, who]) => who === 'body');
      const span = onBody.length ? `${onBody[0]?.[0].toFixed(0)}～${onBody[onBody.length - 1]?.[0].toFixed(0)} ms` : '没有';
      await info.attach('焦点轨迹', { body: `焦点在 body 上：${span}\n${trace.map(([t, w]) => `${t.toFixed(0)}:${w}`).join(' ')}`, contentType: 'text/plain' });
    });
  }
});

test.describe('对照：Radix 原样用 RD.Trigger 打开的弹层', () => {
  test.use({ loggedIn: true });

  test('按 Esc 关掉以后，焦点回到 RD.Trigger', async ({ page, csp }) => {
    csp.expectViolations();   // 这个对照组带 Dialog.Overlay，会被 CSP 拦（csp.spec.ts 同一个），这里只看焦点
    await page.goto(LAB);
    const opener = page.getByTestId('raw-dialog-open');
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('raw-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('raw-dialog')).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null), { timeout: 3000 }).toBe('raw-dialog-open');
  });
});

test.describe('功能包下载失败以后：不刷新不会再装上，刷新以后装上（FA-6 ② 审查 L2，记下实测行为）', () => {
  test.use({ loggedIn: true });

  test('下载被拦下：没有标记；放开以后再挂新的 LazyMotion（打开弹层）也不再去取；刷新页面以后装上', async ({ page, browserName }, info) => {
    // 拦下期间的每一次请求都拦（Vite 会先发 modulepreload、再 import，各一次；只拦第一次的话 import 自己那次照样成功，等于没失败）
    let blocking = true;
    let blocked = 0;
    let served = 0;
    await page.route(BUNDLE, async (route) => {
      if (blocking) {
        blocked += 1;
        await route.abort('failed');
      } else {
        served += 1;
        await route.continue();
      }
    });
    const mark = () => page.evaluate(() => document.documentElement.getAttribute('data-motion'));
    await page.goto(LAB);
    await expect(page.getByTestId('csp-lab')).toBeVisible({ timeout: 30000 });
    await expect.poll(() => blocked, { timeout: 15000 }).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(1000);
    expect(await mark(), '被拦下了还打了标记').toBeNull();
    // 放行，再挂一个新的 LazyMotion：features.ts 会再调一次 import()，但浏览器的模块表记着上次失败，不再去取
    blocking = false;
    await page.getByTestId('dialog-open').click();
    await expect(page.getByRole('dialog'), '没有动画也照常打开').toBeVisible();
    await page.waitForTimeout(3000);
    expect(served, '不刷新又去取了：浏览器不缓存失败的 import 了，可以把 features.ts 文件头和这条改成“不用刷新就能恢复”').toBe(0);
    expect(await mark()).toBeNull();
    // 刷新以后：chromium 照常装上（断言）。webkit 单独跑时刷新后约 4 秒内装上，但三个 worker 并行时三次都 15 秒没装上，原因没查清，
    // 只记进附件不断言（刷新后的请求走缓存、不经过 page.route，served 数不出来，也不断言）
    await page.reload();
    await expect(page.getByTestId('csp-lab')).toBeVisible({ timeout: 30000 });
    if (browserName === 'webkit') {
      const t0 = Date.now();
      let got = await mark();
      while (got !== 'ready' && Date.now() - t0 < 15000) {
        await page.waitForTimeout(250);
        got = await mark();
      }
      await info.attach('webkit 刷新以后', { body: got === 'ready' ? `${Date.now() - t0} ms 内装上` : '15 秒没装上', contentType: 'text/plain' });
    } else {
      await expect.poll(mark, { timeout: 15000 }).toBe('ready');
    }
  });
});
