// R-371 底栏偏高修复 Gap fix（platform/vh-gapfix-gate.ts，“布局视口少一截”唯一的一套：main.tsx 一开始同步做这一次；11-25 删了等底栏后、收键盘后两次和 CSS 补偿 --vh-gap）：Chromium 里模拟负责人那次冷启动——
// iPhone（navigator.userAgent 换成 iPhone 的，只在页面里换，请求头不动）、主屏幕版（navigator.standalone）、屏幕 956、可见高度 895（视口 440×895）、顶部安全区 61（--inset-top；Chromium 的 env() 恒为 0，用 CSSOM 盖上）。
// ① 根据：当时 895 高时只有日历页文档比视口高（6 行月格，和数据无关），今天页正好一屏——负责人“只有切到日历才回落”，iOS 是在文档变得能滚时重算的；
//    R-472 月格变矮后日历页也正好一屏，这里改成四页都断言一屏；
// ② 冷启动一开始（启动画面盖着）放看不见的垫块让文档比视口高（照日历），Chromium 不会改 innerHeight，到 1 秒撤掉，日志记 early no-change，之后不再放；
//    垫块看不见、不接点按；本机留着诊断页旧开关键（lemo-gapfix-off）也照做；稳定后的今天页和“垫块一出现就拿掉”的基准逐像素一样；
// ③ 正常启动（956 / 956）只记 skip，画面和基准逐像素一样
// 基准（pads: false）：注入脚本盯着，垫块一挂上就在同一个微任务里拿掉（还没排版、画不出来），等于从没放过垫块。pads: true 时同一个注入脚本记下垫块挂上那一刻的样子和一共挂过几次（__gapPads）
// chromium、webkit 两个项目都跑：webkit 下全程（含放垫块、撤垫块）不许有 CSP 违规；“逐像素一样”在 webkit 改比版面指纹（见 shot）；触屏上文档高多 base.css 的 1px（见 restH）
import type { Page } from '@playwright/test';
import { readRunLogInPage, SHOT_DIR } from './page-helpers.ts';
import { expect, test } from './session-fixture.ts';

/**
 * 打开前注入：清掉运行日志、存上诊断页旧开关键 lemo-gapfix-off（11-24 起不再读，留着证明不影响）、iPhone、主屏幕版、屏幕高、顶部安全区。
 * pads: false 是基准：垫块一挂上就拿掉（见文件头）
 */
async function launch(page: Page, o: { pads?: boolean; screenH: number; top: number }): Promise<void> {
  await page.addInitScript((a) => {
    const seen: Array<{ docH: number; vis: string; pe: string }> = [];
    (window as unknown as { __gapPads: typeof seen }).__gapPads = seen;
    new MutationObserver((recs) => {
      for (const r of recs)
        for (const n of r.addedNodes) {
          if (!(n instanceof HTMLElement) || n.id !== 'lemo-gapfix-pad') continue;
          if (!a.pads) n.remove();
          else {
            const cs = getComputedStyle(n);
            seen.push({ docH: document.documentElement.scrollHeight, vis: cs.visibility, pe: cs.pointerEvents });
          }
        }
    }).observe(document, { childList: true, subtree: true });
    try {
      localStorage.setItem('lemo-gapfix-off', '1');
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
  }, { pads: o.pads ?? true, screenH: o.screenH, top: o.top });
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
  // r371 偶发的根因）。盖的是同一块实色，卡要是跟着版面错位，色块位置照样对不上。
  // 抗锯齿那种 1～3 级的渲染噪声（11-17 CI 头像圈下半圈 9 个像素、11-23 组合区小方块圆角）不再一处处盖，由下面 same() 的 NOISE 容差统一吸收
  return page.screenshot({ ...(SHOT_DIR ? { path: `${SHOT_DIR}/r371-${name}.png` } : {}), animations: 'disabled', mask: [page.getByTestId('now-card')] });
};

/** 渲染噪声上限（色阶）：Chromium 画圆角阴影、描边的抗锯齿，两次冷启动会差 1～3 级（头像圈下半圈 9 个像素、11-23 今天页组合区“这周做完”小方块圆角边 28 个像素差 1 级）。
 *  原来一处处盖住（11-17 盖头像、11-23 又冒出组合区），重写评估后改成整页按色阶容差比：Gap fix 要是留了垫块、版面挪了，差的是成片的几十上百级，照样抓得到；
 *  “现在”卡跟着真实时钟挪位置（差 42 级），仍然盖住 */
const NOISE = 3;
/** “开、关两张图一样”：webkit 比版面指纹（文字，原样比）；chromium 在一个空白页里用 canvas 解码两张 PNG，RGB 任一通道差超过 NOISE 的像素数为 0 才算一样（空白页不受 App 的 CSP 限制） */
const same = async (page: Page, a: Buffer, b: Buffer): Promise<boolean> => {
  if (page.context().browser()?.browserType().name() === 'webkit') return a.equals(b);
  const blank = await page.context().newPage();
  try {
    const over = await blank.evaluate(
      async ([x, y, tol]) => {
        const px = async (b64: string) => {
          const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          const g = c.getContext('2d');
          if (!g) throw new Error('OffscreenCanvas 拿不到 2d');
          g.drawImage(bmp, 0, 0);
          return g.getImageData(0, 0, bmp.width, bmp.height).data;
        };
        const [p, q] = [await px(x as string), await px(y as string)];
        if (p.length !== q.length) return -1;
        let n = 0;
        for (let i = 0; i < p.length; i += 4) {
          for (let k = 0; k < 3; k++) {
            if (Math.abs((p[i + k] ?? 0) - (q[i + k] ?? 0)) > (tol as number)) {
              n++;
              break;
            }
          }
        }
        return n;
      },
      [a.toString('base64'), b.toString('base64'), NOISE] as const,
    );
    return over === 0;
  } finally {
    await blank.close();
  }
};

test.describe('冷启动可见高度少了顶部安全区（895 / 956）', () => {
  test.use({ loggedIn: true, viewport: { width: 440, height: 895 }, timezoneId: 'Asia/Seoul' });

  // R-472 当时以为 6 行月格在 895 高时正好一屏，其实是 subgrid 下 .cell 的最矮格高没生效、格子被压到 42 量出来的。
  // 11-18 负责人“日历所有月份按照第一张图固定，不要随意缩小”：格高真按 78 以后，日历页（月格 + 下面的日清单）本来就比一屏高、能往下滚，
  // 和负责人第一张图（11 月）一致。所以这里只断言今天、待办、随手记三页不超过一屏；日历页只断言它确实能滚（版面事实）。Gap fix 自己放垫块让文档变得能滚，不靠日历页
  test('根据：895 高时今天、待办、随手记都不超过一屏；日历页月格按 78 格高、比一屏高', async ({ page }) => {
    await launch(page, { pads: false, screenH: 956, top: 61 });
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

  test('冷启动一开始放一次垫块（旧开关键留着也照做）：文档比视口高、看不见也点不到；1 秒撤掉记 early no-change，之后不再放；稳定后和基准逐像素一样', async ({ page }) => {
    await launch(page, { screenH: 956, top: 61 });
    const pad = page.locator('#lemo-gapfix-pad');
    await expect(pad).toHaveCount(0, { timeout: 5000 });
    await expect.poll(() => log(page), { timeout: 10_000 }).toMatch(/early nav=\d+ms no-change inner=895 after=\d+ms gap=61 top=(0|61) gap-after=61/);
    const full = await log(page);
    expect(full).toMatch(/gapfix start nav=\d+ms screen=440x956 inner=895 full=956/);
    expect(full.indexOf('gapfix start')).toBeLessThan(full.indexOf('early nav='));
    const seen = await page.evaluate(() => (window as unknown as { __gapPads: Array<{ docH: number; vis: string; pe: string }> }).__gapPads);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ docH: 895 + 61 + 1, vis: 'hidden', pe: 'none' });
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(await restH(page, 895));
    await settle(page);
    // 只做这一次：底栏挂上、过了原来“等底栏后那一次”的 1.5 秒，都不再放
    await page.waitForTimeout(1600);
    expect(await page.evaluate(() => (window as unknown as { __gapPads: unknown[] }).__gapPads.length)).toBe(1);
    expect(await log(page)).not.toMatch(/pad gap=|pad-removed|gapfix css/);
    const on = await shot(page, '895-on');

    // 同一个页面按基准重新冷启动一次（后加的注入脚本盯着拿掉垫块；会话夹具挂在这个 context 上）
    await page.goto('about:blank');
    await launch(page, { pads: false, screenH: 956, top: 61 });
    await settle(page);
    await expect.poll(() => log(page), { timeout: 10_000 }).toMatch(/early nav=\d+ms no-change/);
    await page.waitForTimeout(1600);
    await expect(pad).toHaveCount(0);
    const base = await shot(page, '895-base');
    expect(await same(page, on, base), '撤完垫块和从没放过垫块一样（容差见 NOISE）').toBe(true);
  });
});

test.describe('正常启动（956 / 956）', () => {
  test.use({ loggedIn: true, viewport: { width: 440, height: 956 }, timezoneId: 'Asia/Seoul' });

  test('只记 skip、不放垫块；今天页和基准逐像素一样', async ({ page }) => {
    await launch(page, { screenH: 956, top: 61 });
    await settle(page);
    await page.waitForTimeout(500);
    await expect(page.locator('#lemo-gapfix-pad')).toHaveCount(0);
    expect(await log(page)).toMatch(/skip no-gap\(0\)/);
    expect(await log(page)).toMatch(/early nav=\d+ms skip no-gap\(0\) gap=0 /);
    const on = await shot(page, '956-on');
    await page.goto('about:blank');
    await launch(page, { pads: false, screenH: 956, top: 61 });
    await settle(page);
    await page.waitForTimeout(500);
    const base = await shot(page, '956-base');
    expect(await same(page, on, base), '正常启动和基准一样（容差见 NOISE）').toBe(true);
  });
});
