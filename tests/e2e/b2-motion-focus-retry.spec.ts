// FA-6 ② 审查（docs/03-评审/B2/B2-代码审查-FA-6②动效异步加载.md）的两条低问题，在真浏览器里验证：
// • L4：用键盘关弹层（在“取消”上按回车、按 Esc）以后，焦点回到打开它的那个按钮，并把中间焦点在 body 上待了多久记进附件。
//   11-04 实测改前两个浏览器都回不去、焦点一直留在 body（和 inert 无关）：Radix 的 modal Content 关闭时 preventDefault 掉 FocusScope 的
//   “还给原来的元素”，改成 triggerRef.current?.focus()；kit Dialog 的使用方都是自己的按钮 setOpen(true)，没用 RD.Trigger，triggerRef 是空的。
//   主持人定了改 kit/components/Dialog.tsx：打开那一刻记下焦点，onCloseAutoFocus 里还回去（单测在 kit 的 Dialog.test.tsx）。
//   对照组（试验页的 Radix 原样弹层，用 RD.Trigger）一直回得去
//   11-05（MOTION-②-low 与 Dialog 焦点审查 L-1）：改成 open 变 false 那一次提交就还，不等退场动画、Content 卸载；
//   原来焦点先在 body 上停 26～376 ms，现在断言“在 body 上最多 1 帧”（每帧取样一次；偶尔赶上提交和取样之间那一帧算 1 帧）
//   第 1 批审查 M1（11-05，主持人定第一种）：提前还的那一刻页面其余部分还带着 Radix 的 aria-hidden，读屏不报；卸载以后
//   Dialog 对打开按钮再聚焦一次。断言：弹层从文档里没了以后，焦点在打开按钮上、不在 [aria-hidden="true"] 里，
//   而且打开按钮最后一次收到 focus 事件时已经不在 aria-hidden 里（读屏是按这次 focus 报的）
// • L2：功能包第一次下载失败（离线、块丢了）以后，下一个新挂上的 LazyMotion 再试一次，不刷新能不能装上
//   （担心的是浏览器的模块表把失败的动态 import 缓存住）。判据是 features.ts 在包到了时打的 <html data-motion="ready">（审查 L5）。
//   **实测（11-04）：chromium、webkit 都不再去取，要刷新页面才恢复**——这条按实测行为写（不刷新不去取、刷新以后装上），
//   哪天浏览器改了会挂，提醒去改 features.ts 的说法。刷新以后两个浏览器都断言装上：刷新前等 SW 就绪（webkit 没被 SW 接管时刷新照样用缓存的失败结果，审查 L-5 查清，见下面）。
//   后果只是这一页没有动画（元素照常显示、照常能点），见 src/motion/features.ts 文件头
// 用的是开发试验页 #/dev-csp 的 kit Dialog（csp.spec.ts 同一个），e2e 构建里有这一页
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const LAB = '/app/#/dev-csp';
// R-354：功能包和动画实现合成 motion-impl 一块，main.tsx 在首屏画完以后下载
const BUNDLE = /\/motion-impl-[^/]*\.js$/;

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
      // 记下打开按钮每次收到 focus 时在不在 aria-hidden 里（M1）
      await page.evaluate(() => {
        const w = window as Window & { __openerFocus?: boolean[] };
        w.__openerFocus = [];
        document.querySelector('[data-testid="dialog-open"]')?.addEventListener('focus', (e) => {
          w.__openerFocus?.push((e.target as Element).closest('[aria-hidden="true"]') !== null);
        });
      });
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
      expect(onBody.length, `焦点在 body 上停了 ${onBody.length} 帧（${span}），关上那一刻就该还回去（审查 L-1）`).toBeLessThanOrEqual(1);

      // M1：弹层卸掉以后焦点不在 aria-hidden 里，且最后一次 focus 发生在 aria-hidden 撤掉以后
      await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null, undefined, { timeout: 3000 });
      await expect
        .poll(() => page.evaluate(() => (window as Window & { __openerFocus?: boolean[] }).__openerFocus?.at(-1) ?? null), { timeout: 3000 })
        .toBe(false);
      const after = await page.evaluate(() => {
        const a = document.activeElement;
        return { who: a?.getAttribute('data-testid') ?? null, hidden: a?.closest('[aria-hidden="true"]') !== null, focus: (window as Window & { __openerFocus?: boolean[] }).__openerFocus ?? [] };
      });
      await info.attach('打开按钮的 focus 事件（true = 当时在 aria-hidden 里）', { body: JSON.stringify(after.focus), contentType: 'text/plain' });
      expect(after.who).toBe('dialog-open');
      expect(after.hidden, '弹层卸掉以后焦点不在 aria-hidden 里（审查 M1）').toBe(false);
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

  test('下载被拦下：没有标记；放开以后再挂新的 LazyMotion（打开弹层）也不再去取；刷新页面以后装上', async ({ page }) => {
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
    // 放行，再打开弹层：R-354 起首屏的是门面，打开弹层不会再触发下载（原来新挂的 LazyMotion 会再调一次 import()，浏览器的模块表也记着上次失败、不再去取）
    blocking = false;
    await page.getByTestId('dialog-open').click();
    await expect(page.getByRole('dialog'), '没有动画也照常打开').toBeVisible();
    await page.waitForTimeout(3000);
    expect(served, '不刷新又去取了：浏览器不缓存失败的 import 了，可以把 features.ts 文件头和这条改成“不用刷新就能恢复”').toBe(0);
    expect(await mark()).toBeNull();
    // 刷新以后：两个浏览器都断言装上（审查 L-5，11-05 查清）。刷新前先等 SW 装好（navigator.serviceWorker.ready），刷新后的页面由 SW 接管：
    // webkit 在页面没被 SW 接管时，刷新以后照样用内存缓存里上次被拦下的失败结果，功能包的 import() 不发请求就失败（诊断：请求、资源记录都没有，
    // 15 秒后在页面里手动 import 同一个地址却能成功）；被 SW 接管时请求走 SW，照常取到。
    // 原来“并行时 15 秒没装上”就是这个：单独跑时 SW 在刷新前已经装好；4 个 worker 并行时 SW 装得慢，刷新时还没接管（12 遍里失败的 6 遍全是没接管、成功的 6 遍全是接管了；
    // 刷新前等 SW 就绪以后，4 个 worker 并行 12 遍全过）。真实使用里第二次打开起页面都由 SW 接管，见 src/motion/features.ts 文件头
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect(page.getByTestId('csp-lab')).toBeVisible({ timeout: 30000 });
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), '刷新以后页面由 SW 接管').toBe(true);
    await expect.poll(mark, { timeout: 15000 }).toBe('ready');
  });
});
