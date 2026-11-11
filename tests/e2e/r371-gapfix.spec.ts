// R-371 底栏偏高修复 Gap fix（platform/vh-gapfix.ts；11-11 起 iOS 主屏幕版默认开，诊断页“Gap fix: OFF (compare)”关掉对照）：Chromium 里模拟负责人那次冷启动——
// iPhone（navigator.userAgent 换成 iPhone 的，只在页面里换，请求头不动）、主屏幕版（navigator.standalone）、屏幕 956、可见高度 895（视口 440×895）、顶部安全区 61（--inset-top；Chromium 的 env() 恒为 0，用 CSSOM 盖上）。
// ① 根据：895 高时只有日历页文档比视口高（6 行月格，和数据无关），今天页正好一屏——负责人“只有切到日历才回落”，iOS 是在文档变得能滚时重算的；
// ② 默认开着：底栏挂上以后放看不见的垫块让今天页文档比视口高（照日历），Chromium 不会改 innerHeight，到 1.5 秒撤掉，日志记 no-change；
//    垫块在的时候底栏位置不变、点不到垫块；稳定后的今天页和开关关着时逐像素一样；
// ③ 诊断页关掉：什么都不做、不记日志；④ 正常启动（956 / 956）开着也只记 skip，画面和关着时逐像素一样
// chromium、webkit 两个项目都跑：webkit 下全程（含放垫块、撤垫块）不许有 CSP 违规；“逐像素一样”在 webkit 改比版面指纹（见 shot）；触屏上文档高多 base.css 的 1px（见 restH）
import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const SHOTS = process.env['R371_SHOTS'] ?? 'test-results/r371-gapfix';

/** 打开前注入：开关（on: false = 诊断页关掉，存 lemo-gapfix-off）、iPhone、主屏幕版、屏幕高、顶部安全区 */
async function launch(page: Page, o: { on: boolean; screenH: number; top: number }): Promise<void> {
  await page.addInitScript((a) => {
    try {
      if (a.on) localStorage.removeItem('lemo-gapfix-off');
      else localStorage.setItem('lemo-gapfix-off', '1');
      localStorage.removeItem('lemo-gapfix-out');
    } catch {
      // 不会走到
    }
    // Gap fix 只在 iOS 主屏幕版做（vh-gapfix-gate.ts）：chromium 项目是电脑 UA，页面里换成 iPhone 的（webkit 项目本来就是 iPhone 15）
    if (!/iPhone|iPad/.test(navigator.userAgent))
      Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1', configurable: true });
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    Object.defineProperty(screen, 'height', { get: () => a.screenH, configurable: true });
    // 注入脚本跑的时候 <html> 可能还没建出来：出来了再设
    const set = (): boolean => {
      document.documentElement?.style.setProperty('--inset-top', `${a.top}px`);
      return document.documentElement !== null;
    };
    if (!set()) {
      const mo = new MutationObserver(() => {
        if (set()) mo.disconnect();
      });
      mo.observe(document, { childList: true });
    }
  }, o);
  await page.goto('/app/#/today');
  await expect(page.getByTestId('today')).toBeVisible();
}

/** 启动的淡入都放完：启动画面撤了、安全区放行、实色带不透明 */
async function settle(page: Page): Promise<void> {
  await expect(page.locator('#lemo-splash')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('html[data-inset-wait]')).toHaveCount(0, { timeout: 10_000 });
  const band = page.getByTestId('tabbar-band');
  await expect(band).toBeAttached({ timeout: 10_000 });
  await expect.poll(() => band.evaluate((el) => (el.getAnimations().length === 0 ? Number(getComputedStyle(el).opacity) : -1)), { timeout: 5000 }).toBe(1);
}

/** 不撑开时的文档高：触屏（hover: none，webkit 项目是 iPhone 15）上 base.css 的 html { min-height: calc(100% + 1px) }（CI-webkit-crash 11-04）
 *  让文档永远比视口高 1px，电脑上不加——所以触屏上今天页本来就能滚 1px（和真机 scrollBy 1px 滚到 y=1 对得上） */
const restH = (page: Page, vh: number): Promise<number> => page.evaluate((h) => (matchMedia('(hover: none)').matches ? h + 1 : h), vh);
const log = (page: Page): Promise<string> => page.evaluate(() => localStorage.getItem('lemo-gapfix-out') ?? '');
/** “逐像素一样”的比对材料：chromium 截图；webkit 改比版面指纹（底栏、实色带、“＋”、main 的位置大小，实色带透明度，文档高，滚动位置）。
 *  webkit 上 Playwright 每截一次图都往页面插 <style>body {}</style>（inPagePrepareForScreenshots，关不掉，见 visual/visual-helpers.ts），
 *  被 App 的 CSP 拦成 style-src-elem 违规，csp-fixture 判失败——那是测试工具自己的；不截图，App 自己在 webkit 下的 CSP 违规照样由 csp-fixture 判 */
const shot = async (page: Page, name: string): Promise<Buffer> => {
  if (page.context().browser()?.browserType().name() === 'webkit') {
    const print = await page.evaluate(() => {
      const box = (sel: string): string => {
        const el = document.querySelector(sel);
        if (!el) return `${sel}:-`;
        const b = el.getBoundingClientRect();
        return `${sel}:${b.x},${b.y},${b.width},${b.height}`;
      };
      const band = document.querySelector('[data-testid="tabbar-band"]');
      return [
        box('[data-testid="tabbar"]'), box('[data-testid="tabbar-band"]'), box('[data-testid="tabbar-add"]'), box('main'),
        `band-opacity:${band ? getComputedStyle(band).opacity : '-'}`,
        `docH:${document.documentElement.scrollHeight}`, `scrollY:${scrollY}`, `pad:${document.getElementById('lemo-gapfix-pad') ? 1 : 0}`,
      ].join(' | ');
    });
    return Buffer.from(print);
  }
  mkdirSync(SHOTS, { recursive: true });
  return page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' });
};

test.describe('冷启动可见高度少了顶部安全区（895 / 956）', () => {
  test.use({ loggedIn: true, viewport: { width: 440, height: 895 }, timezoneId: 'Asia/Seoul' });

  test('根据：895 高时日历页文档比视口高，今天、待办、随手记不超过一屏', async ({ page }) => {
    await launch(page, { on: false, screenH: 956, top: 61 });
    const docH = async (name: string): Promise<number> => {
      await page.goto(`/app/#/${name}`);
      await expect(page.locator(`main[data-feature="${name}"]`)).toBeVisible();
      await page.waitForTimeout(300);
      return page.evaluate(() => document.documentElement.scrollHeight);
    };
    const rest = await restH(page, 895);
    expect(await docH('calendar')).toBeGreaterThan(rest);
    // 今天、待办、随手记：正好是不撑开时的高（电脑 895；触屏 896，只多 base.css 那 1px）
    for (const name of ['today', 'todos', 'notes']) expect(await docH(name), name).toBe(rest);
  });

  test('默认开着：底栏挂上后放垫块，今天页文档比视口高、底栏不动、垫块看不见也点不到；1.5 秒撤掉，记 no-change；稳定后和关着时逐像素一样', async ({ page }) => {
    await launch(page, { on: true, screenH: 956, top: 61 });
    const pad = page.locator('#lemo-gapfix-pad');
    await expect.poll(() => log(page), { timeout: 10_000 }).toMatch(/pad gap=61 top=61/);
    await expect(pad).toBeAttached();
    const during = await page.evaluate(() => {
      const p = document.getElementById('lemo-gapfix-pad');
      const cs = p ? getComputedStyle(p) : null;
      return {
        docH: document.documentElement.scrollHeight,
        vis: cs?.visibility,
        pe: cs?.pointerEvents,
        bar: Math.round(document.querySelector('[data-testid="tabbar"]')?.getBoundingClientRect().bottom ?? -1),
        hit: document.elementFromPoint(1, 10)?.id ?? '',
      };
    });
    expect(during.docH).toBe(895 + 61 + 1);
    expect(during.vis).toBe('hidden');
    expect(during.pe).toBe('none');
    expect(during.hit).not.toBe('lemo-gapfix-pad');
    expect(await log(page)).toMatch(/pad gap=61 top=61/);
    await expect(pad).toHaveCount(0, { timeout: 5000 });
    expect(await log(page)).toMatch(/no-change pad-removed/);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(await restH(page, 895));
    expect(await page.evaluate(() => Math.round(document.querySelector('[data-testid="tabbar"]')?.getBoundingClientRect().bottom ?? -1))).toBe(during.bar);
    await settle(page);
    const on = await shot(page, '895-on');

    // 同一个页面按“诊断页关掉”重新冷启动一次（后加的注入脚本存上 lemo-gapfix-off；会话夹具挂在这个 context 上）
    await page.goto('about:blank');
    await launch(page, { on: false, screenH: 956, top: 61 });
    await settle(page);
    await page.waitForTimeout(1600);
    await expect(page.locator('#lemo-gapfix-pad')).toHaveCount(0);
    expect(await log(page)).toBe('');
    const off = await shot(page, '895-off');
    expect(on.equals(off), '开着（撤完垫块）和关着逐像素一样').toBe(true);
  });

  test('诊断页关掉：不放垫块、不记日志', async ({ page }) => {
    await launch(page, { on: false, screenH: 956, top: 61 });
    await page.waitForTimeout(2000);
    await expect(page.locator('#lemo-gapfix-pad')).toHaveCount(0);
    expect(await log(page)).toBe('');
  });
});

test.describe('正常启动（956 / 956）', () => {
  test.use({ loggedIn: true, viewport: { width: 440, height: 956 }, timezoneId: 'Asia/Seoul' });

  test('默认开着也只记 skip、不放垫块；今天页和关掉时逐像素一样', async ({ page }) => {
    await launch(page, { on: true, screenH: 956, top: 61 });
    await settle(page);
    await page.waitForTimeout(500);
    await expect(page.locator('#lemo-gapfix-pad')).toHaveCount(0);
    expect(await log(page)).toMatch(/skip no-gap\(0\)/);
    const on = await shot(page, '956-on');
    await page.goto('about:blank');
    await launch(page, { on: false, screenH: 956, top: 61 });
    await settle(page);
    await page.waitForTimeout(500);
    const off = await shot(page, '956-off');
    expect(on.equals(off), '正常启动开着和关着逐像素一样').toBe(true);
  });
});
