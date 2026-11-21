// R-371 底栏偏高修复 Gap fix（platform/vh-gapfix.ts；11-11 起 iOS 主屏幕版默认开，诊断页“Gap fix: OFF (compare)”关掉对照）：Chromium 里模拟负责人那次冷启动——
// iPhone（navigator.userAgent 换成 iPhone 的，只在页面里换，请求头不动）、主屏幕版（navigator.standalone）、屏幕 956、可见高度 895（视口 440×895）、顶部安全区 61（--inset-top；Chromium 的 env() 恒为 0，用 CSSOM 盖上）。
// ① 根据：当时 895 高时只有日历页文档比视口高（6 行月格，和数据无关），今天页正好一屏——负责人“只有切到日历才回落”，iOS 是在文档变得能滚时重算的；
//    R-472 月格变矮后日历页也正好一屏，这里改成四页都断言一屏；
// ② 默认开着：底栏挂上以后放看不见的垫块让今天页文档比视口高（照日历），Chromium 不会改 innerHeight，到 1.5 秒撤掉，日志记 no-change；
//    垫块在的时候底栏位置不变、点不到垫块；稳定后的今天页和开关关着时逐像素一样；
// ③ 诊断页关掉：什么都不做、不记日志；④ 正常启动（956 / 956）开着也只记 skip，画面和关着时逐像素一样
// chromium、webkit 两个项目都跑：webkit 下全程（含放垫块、撤垫块）不许有 CSP 违规；“逐像素一样”在 webkit 改比版面指纹（见 shot）；触屏上文档高多 base.css 的 1px（见 restH）
import type { Page } from '@playwright/test';
import { readRunLogInPage, SHOT_DIR } from './page-helpers.ts';
import { expect, test } from './session-fixture.ts';

/**
 * 打开前注入：开关（on: false = 诊断页关掉，存 lemo-gapfix-off）、清掉运行日志、iPhone、主屏幕版、屏幕高、顶部安全区。
 * 另记两样给“关着什么都不做”当证据：垫块出没出现过（window.__padSeen），vh-gapfix 那一块有没有被请求（返回的数组）
 */
async function launch(page: Page, o: { on: boolean; screenH: number; top: number }): Promise<string[]> {
  const gapReqs: string[] = [];
  page.on('request', (r) => {
    if (/vh-gapfix/.test(r.url())) gapReqs.push(r.url());
  });
  await page.addInitScript((a) => {
    const w = window as unknown as { __padSeen: boolean };
    w.__padSeen = false;
    new MutationObserver(() => {
      if (document.getElementById('lemo-gapfix-pad')) w.__padSeen = true;
    }).observe(document, { childList: true, subtree: true });
    try {
      if (a.on) localStorage.removeItem('lemo-gapfix-off');
      else localStorage.setItem('lemo-gapfix-off', '1');
      for (const k of Object.keys(localStorage)) if (k.startsWith('lemo-run-log')) localStorage.removeItem(k); // 运行日志分段存（lemo-run-log.c<序号>），各段都清
    } catch {
      // 不会走到
    }
    // Gap fix 只在 iOS 主屏幕版做（vh-gapfix-gate.ts）：chromium 项目是电脑 UA，页面里换成 iPhone 的（webkit 项目本来就是 iPhone 15）
    if (!/iPhone|iPad/.test(navigator.userAgent))
      Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1', configurable: true });
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    Object.defineProperty(screen, 'height', { get: () => a.screenH, configurable: true });
    // 横屏按 innerWidth 比 screen 短边判（viewport-screen.ts）：webkit 项目的 iPhone 15 screen 宽 393，比视口 440 窄，盖成和视口一样宽
    Object.defineProperty(screen, 'width', { get: () => 440, configurable: true });
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
  return gapReqs;
}

/**
 * 关着就什么都不做的证据（不靠睡过 1.5 秒）：开不开是 main.tsx 同步判的（gapFixWanted），判成开时早试同步放垫块、vh-gapfix 那一块同时开始下载，
 * 都在今天页画出来之前。所以今天页出来时垫块没出现过、那一块没被请求，后面就不会再有；再等这次启动的运行日志落盘（=== start 那行，隔 300ms 存），里面没有 gapfix 的行
 */
async function expectOffInert(page: Page, gapReqs: readonly string[]): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __padSeen: boolean }).__padSeen), '垫块没出现过').toBe(false);
  expect(gapReqs, '没下载 vh-gapfix').toEqual([]);
  await expect.poll(() => page.evaluate(readRunLogInPage), { timeout: 5000 }).toContain('=== start');
  await expect(page.locator('#lemo-gapfix-pad')).toHaveCount(0);
  // 总开关（lemo-gapfix-off）只停放垫块那三套（early、bar、kb）；第四套 css（贴底元素补 --vh-gap，viewport.ts）一直不归它管、照旧生效，
  // fdf2e50e 起它的值一变就记一行 gapfix css set=…（负责人 11-20 选“手机上对照一次”，四套都要能在日志里看出来）。所以除了这一行，gapfix 的行一条都不许有
  expect((await log(page)).split('\n').filter((l) => l !== '' && !l.includes(' app gapfix css ')).join('\n')).toBe('');
}

/** 启动的淡入都放完：启动画面撤了、安全区放行、实色带不透明 */
async function settle(page: Page): Promise<void> {
  await expect(page.locator('#lemo-splash')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('html[data-inset-wait]')).toHaveCount(0, { timeout: 10_000 });
  const band = page.getByTestId('tabbar-band');
  await expect(band).toBeAttached({ timeout: 10_000 });
  await expect.poll(() => band.evaluate((el) => (el.getAnimations().length === 0 ? Number(getComputedStyle(el).opacity) : -1)), { timeout: 5000 }).toBe(1);
  // “＋”上方的新手气泡（前 3 次打开都出；每条用例新开的 context 只开两次）挂在首屏以后才下载的那一块里，机器慢时 2.5 秒后才出来：
  // 等它出来再截，不然开、关两张一张有气泡一张没有（11-17 CI 同款镜像里探针实测过一次）
  await expect(page.getByTestId('plus-hint')).toBeVisible({ timeout: 10_000 });
}

/** 不撑开时的文档高：触屏（hover: none，webkit 项目是 iPhone 15）上 base.css 的 html { min-height: calc(100% + 1px) }（CI-webkit-crash 11-04）
 *  让文档永远比视口高 1px，电脑上不加——所以触屏上今天页本来就能滚 1px（和真机 scrollBy 1px 滚到 y=1 对得上） */
const restH = (page: Page, vh: number): Promise<number> => page.evaluate((h) => (matchMedia('(hover: none)').matches ? h + 1 : h), vh);
/** Gap fix 的日志：经 rlog 进全局运行日志（分段存在 lemo-run-log.c<序号>，运行日志隔 300ms 存一次），只取 gapfix 那几行 */
const log = (page: Page): Promise<string> =>
  page.evaluate(readRunLogInPage).then((t) => t.split('\n').filter((l) => l.includes(' app gapfix ')).join('\n'));
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
  // 截图本身就是比对材料（返回的 Buffer），不落盘；设了 LEMO_SHOT_DIR 才另存一份给人看（同 page-helpers.ts 的 shot，原来另认 R371_SHOTS、默认写进 test-results）
  // 盖住今天页“现在”卡：卡里的时间尺圆点、“现在 HH:MM”跟着真实时钟走，开、关两张图隔几秒截会挪零点几个像素（11-16 本机 chromium 圆点边差 42 级，
  // r371 偶发的根因）；R-439 起卡的渐变阴影合成在渐变底上，两次渲染也会差 1 级。盖的是同一块实色，卡要是跟着版面错位，色块位置照样对不上。
  // 同样盖住右上角头像圈（today-settings）：CI 同款 Linux 镜像里（11-17 ci 9e39ba10 r371:131 红），只要启动时文档短暂比视口高（垫块在），
  // Chromium 画这个圆圈下半圈描边的抗锯齿就时而差 1～3 级（固定是 (387～416, 106～107) 那 9 个像素）：关、关两次冷启动 3/3 一样；
  // 关着只在注入时仿早试放 1 秒垫块，2 次里 1 次差；开、开两次 2 次里 1 次差，差的都是这 9 个像素；头像的位置大小、样式开关两边一样。
  // 是渲染器的抗锯齿，不是 Gap fix 留了东西；盖住以后头像要是跟着版面挪了，色块位置照样对不上
  return page.screenshot({ ...(SHOT_DIR ? { path: `${SHOT_DIR}/r371-${name}.png` } : {}), animations: 'disabled', mask: [page.getByTestId('now-card'), page.getByTestId('today-settings')] });
};

test.describe('冷启动可见高度少了顶部安全区（895 / 956）', () => {
  test.use({ loggedIn: true, viewport: { width: 440, height: 895 }, timezoneId: 'Asia/Seoul' });

  // R-472 当时以为 6 行月格在 895 高时正好一屏，其实是 subgrid 下 .cell 的最矮格高没生效、格子被压到 42 量出来的。
  // 11-18 负责人“日历所有月份按照第一张图固定，不要随意缩小”：格高真按 78 以后，日历页（月格 + 下面的日清单）本来就比一屏高、能往下滚，
  // 和负责人第一张图（11 月）一致。所以这里只断言今天、待办、随手记三页不超过一屏；日历页只断言它确实能滚（版面事实）。Gap fix 自己放垫块让文档变得能滚，不靠日历页
  test('根据：895 高时今天、待办、随手记都不超过一屏；日历页月格按 78 格高、比一屏高', async ({ page }) => {
    await launch(page, { on: false, screenH: 956, top: 61 });
    const docH = async (name: string): Promise<number> => {
      await page.goto(`/app/#/${name}`);
      await expect(page.locator(`main[data-feature="${name}"]`)).toBeVisible();
      await page.waitForTimeout(300);
      return page.evaluate(() => document.documentElement.scrollHeight);
    };
    const rest = await restH(page, 895);
    // 正好是不撑开时的高（电脑 895；触屏 896，只多 base.css 那 1px）
    for (const name of ['today', 'todos', 'notes']) expect(await docH(name), name).toBe(rest);
    expect(await docH('calendar'), 'calendar').toBeGreaterThan(rest);
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
    await expect.poll(() => log(page)).toMatch(/no-change pad-removed/);
    // 台账 Q-2 早试：main.tsx 一开始就同步放过一次垫块（Chromium 不改 innerHeight，1 秒撤掉记 no-change），记在“等底栏后那一次”前面
    const full = await log(page);
    expect(full).toMatch(/early nav=\d+ms no-change inner=895 after=\d+ms gap=61 top=(0|61)/);
    expect(full.indexOf('early nav=')).toBeLessThan(full.indexOf('pad gap=61'));
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(await restH(page, 895));
    expect(await page.evaluate(() => Math.round(document.querySelector('[data-testid="tabbar"]')?.getBoundingClientRect().bottom ?? -1))).toBe(during.bar);
    await settle(page);
    const on = await shot(page, '895-on');

    // 同一个页面按“诊断页关掉”重新冷启动一次（后加的注入脚本存上 lemo-gapfix-off；会话夹具挂在这个 context 上）
    await page.goto('about:blank');
    const offReqs = await launch(page, { on: false, screenH: 956, top: 61 });
    await settle(page);
    await expectOffInert(page, offReqs);
    const off = await shot(page, '895-off');
    expect(on.equals(off), '开着（撤完垫块）和关着逐像素一样').toBe(true);
  });

  test('诊断页关掉：不放垫块、不记日志', async ({ page }) => {
    await expectOffInert(page, await launch(page, { on: false, screenH: 956, top: 61 }));
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
    expect(await log(page)).toMatch(/early nav=\d+ms skip no-gap\(0\) gap=0 /);
    const on = await shot(page, '956-on');
    await page.goto('about:blank');
    await launch(page, { on: false, screenH: 956, top: 61 });
    await settle(page);
    await page.waitForTimeout(500);
    const off = await shot(page, '956-off');
    expect(on.equals(off), '正常启动开着和关着逐像素一样').toBe(true);
  });
});
