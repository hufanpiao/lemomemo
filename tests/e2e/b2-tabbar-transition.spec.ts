// 液态玻璃底栏在切页过渡进行中的样子和点按（B2 FA-7 设计复审一 R1、复审二 R4、R5）；别的底栏用例见 b2-tabbar.spec.ts。
// 两条都用“把 ::view-transition 的伪元素动画暂停在中途”的办法，让过渡停住再截图、再按坐标点
import type { Page } from '@playwright/test';
import { expect, test } from './session-fixture.ts';

const bar = (page: Page) => page.getByTestId('tabbar');
const tab = (page: Page, name: string) => bar(page).locator(`a[data-tab="${name}"]`);

test.describe('底栏：切页过渡进行中（FA-7）', () => {
  // 手机宽度的底栏：chromium 项目默认 1280 宽，那里是电脑版侧栏（D5，见 b2-sidebar.spec.ts）
  test.use({ loggedIn: true, viewport: { width: 375, height: 812 } });

  // 设计复审一 R1：webkit 切页的过渡期间画面上没有底栏和“＋”（DOM 一直在、看得见，是过渡层没画新的那一份），上面那条查 DOM 查不出来。
  // 这里比像素，底栏和“＋”两块分开比：点之前截一张；点页签以后把整页过渡的动画（::view-transition-* 的伪元素动画）暂停住，等液滴滑完再截一张；
  // 过渡放完、停稳以后截一张“画着”的，再把底栏和“＋”临时藏起来（CSSOM 写 visibility）截一张“没画”的。
  // 只看“画着”和“没画”明显不同的像素（图标、字、液滴、边、阴影；玻璃和底色太接近的不算），中途那张这些像素里
  // 更像“没画”的超过 10% 就算没画出来（设计复审二 R5：原来整块一起数、门槛 5%，只缺底栏时默认皮肤才差 3.7%，抓不住）
  test('切页过渡进行中，画面上有底栏和“＋”（比像素；设计复审一 R1）', async ({ page, context, csp }) => {
    // webkit 的 page.screenshot 自己会往页面插一段 <style>（CSP 报 style-src-elem inline、没有来源文件）：只放过截图那一刻冒出来的这一种，
    // 别的违规（和截图以外时刻的同种违规）照样判失败
    test.setTimeout(90_000); // 三次切页、每次三张截图加解码，webkit 4 并发时 30 秒不够
    csp.expectViolations();
    let excused = 0;
    const shot = async (clip: { x: number; y: number; width: number; height: number }): Promise<Buffer> => {
      const n0 = (await csp.allViolations()).length;
      const png = await page.screenshot({ clip, animations: 'allow', caret: 'initial' });
      await page.waitForTimeout(50);
      const fresh = (await csp.allViolations()).slice(n0);
      excused += fresh.filter((v) => v.directive === 'style-src-elem' && v.blocked === 'inline' && !v.source).length;
      return png;
    };
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 }); // 首屏后部分到了，之后底栏不再变样
    const fab = page.getByTestId('tabbar-add');
    const decoder = await context.newPage(); // 空白页解码 PNG（被测页面有 CSP）
    const pixels = async (png: Buffer): Promise<number[]> =>
      decoder.evaluate(async (b64) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        const g = c.getContext('2d') as CanvasRenderingContext2D;
        g.drawImage(bmp, 0, 0);
        return Array.from(g.getImageData(0, 0, bmp.width, bmp.height).data);
      }, png.toString('base64'));
    const dist = (x: number[], y: number[], k: number): number =>
      Math.max(Math.abs((x[k] ?? 0) - (y[k] ?? 0)), Math.abs((x[k + 1] ?? 0) - (y[k + 1] ?? 0)), Math.abs((x[k + 2] ?? 0) - (y[k + 2] ?? 0)));
    const setShown = (on: boolean) =>
      page.evaluate((v) => {
        for (const el of document.querySelectorAll<HTMLElement>('[data-testid="tabbar"],[data-testid="tabbar-add"]')) {
          if (v) el.style.removeProperty('visibility');
          else el.style.setProperty('visibility', 'hidden');
        }
      }, on);
    const boxOf = async (l: ReturnType<typeof bar>) => {
      const r = await l.boundingBox();
      expect(r).not.toBeNull();
      return { x: Math.floor(r?.x ?? 0), y: Math.floor(r?.y ?? 0), width: Math.ceil(r?.width ?? 1), height: Math.ceil(r?.height ?? 1) };
    };
    for (const name of ['todos', 'calendar', 'today'] as const) {
      const clips = { 底栏: await boxOf(bar(page)), '“＋”': await boxOf(fab) };
      const before: Record<string, Buffer> = {};
      const mid: Record<string, Buffer> = {};
      const end: Record<string, Buffer> = {};
      const gone: Record<string, Buffer> = {};
      for (const [k, c] of Object.entries(clips)) before[k] = await shot(c);
      await tab(page, name).click();
      // 等过渡的伪元素动画出来，全部暂停（过渡就停在中途不结束）
      const paused = await page
        .waitForFunction(
          () => {
            const vt = document.getAnimations().filter((x) => String((x.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition'));
            for (const x of vt) x.pause();
            return vt.length;
          },
          undefined,
          { timeout: 2000, polling: 4 },
        )
        .then((h) => h.jsonValue());
      expect(paused, `${name}：没等到切页过渡`).toBeGreaterThan(0);
      await page.waitForTimeout(700); // 液滴滑完（--dur-drop 0.55s），过渡仍停着
      for (const [k, c] of Object.entries(clips)) mid[k] = await shot(c);
      const still = await page.evaluate(() => document.getAnimations().filter((x) => x.playState === 'paused').length);
      expect(still, `${name}：截图时过渡还停在中途`).toBeGreaterThan(0);
      await page.evaluate(() => {
        for (const x of document.getAnimations()) if (String((x.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition')) x.finish();
      });
      await expect(page).toHaveURL(new RegExp(`#/${name}$`));
      await page.waitForTimeout(700);
      for (const [k, c] of Object.entries(clips)) end[k] = await shot(c);
      await setShown(false);
      for (const [k, c] of Object.entries(clips)) gone[k] = await shot(c);
      await setShown(true);
      for (const k of Object.keys(clips)) {
        const [o, p, q, z] = [await pixels(before[k] as Buffer), await pixels(mid[k] as Buffer), await pixels(end[k] as Buffer), await pixels(gone[k] as Buffer)];
        let telling = 0;
        let missing = 0;
        for (let j = 0; j < p.length; j += 4) {
          if (dist(q, z, j) <= 32) continue; // 画着、没画看不出差别的像素不算
          telling += 1;
          if (dist(p, z, j) < Math.min(dist(p, o, j), dist(p, q, j))) missing += 1;
        }
        expect(telling, `${name} ${k}：能分辨画没画的像素太少`).toBeGreaterThan(200);
        const ratio = missing / telling;
        if (ratio >= 0.1) await test.info().attach(`${name}-${k}-过渡中`, { body: mid[k] as Buffer, contentType: 'image/png' });
        expect(ratio, `${name}：过渡中${k}那块，能分辨的像素里 ${(ratio * 100).toFixed(1)}% 更像“没画”`).toBeLessThan(0.1);
      }
    }
    await decoder.close();
    const all = await csp.allViolations();
    expect(all.length - excused, `截图以外的 CSP 违规：${JSON.stringify(all)}`).toBe(0);
    expect(await csp.violations().then((v) => v.filter((x) => !(x.directive === 'style-src-elem' && x.blocked === 'inline' && !x.source)))).toEqual([]);
  });

  // 设计复审二 R4：上面那条用 locator.click，Playwright 会等过渡结束、元素稳定了才点，测不出“过渡中点按被吞”。
  // 这里点日历以后等到切页过渡真的在跑（::view-transition 的伪元素动画出来），把它暂停在中途，再用 page.mouse 按坐标点“待办”：
  // 点按要落到底栏的“待办”上，马上切过去（打断还没放完的过渡）
  test('切页过渡进行中按坐标点页签：点按落在页签上，马上切过去（设计复审二 R4）', async ({ page }) => {
    await page.goto('/app/#/today');
    await expect(page.getByTestId('today')).toBeVisible();
    await expect(page.getByTestId('tabbar-band')).toBeAttached({ timeout: 10_000 });
    for (const [first, then] of [['calendar', 'todos'], ['today', 'calendar']] as const) {
      const box = await tab(page, then).boundingBox();
      expect(box).not.toBeNull();
      await page.evaluate(() => {
        const w = window as unknown as { __hit: string[] };
        w.__hit = [];
        document.addEventListener('click', (e) => w.__hit.push(e.target instanceof Element ? (e.target.closest('a[data-tab]')?.getAttribute('data-tab') ?? e.target.tagName) : '?'), { capture: true });
      });
      await tab(page, first).click();
      const n = await page
        .waitForFunction(
          () => {
            const vt = document.getAnimations().filter((x) => String((x.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition'));
            for (const x of vt) x.pause();
            return vt.length;
          },
          undefined,
          { timeout: 2000, polling: 4 },
        )
        .then((h) => h.jsonValue());
      expect(n, `${first}：没等到切页过渡`).toBeGreaterThan(0);
      await page.mouse.click((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2);
      const hit = await page.evaluate(() => (window as unknown as { __hit: string[] }).__hit);
      expect(hit.at(-1), `${first} 过渡中点 ${then}：点按落在了 ${hit.join('、')}`).toBe(then);
      await expect(page).toHaveURL(new RegExp(`#/${then}$`), { timeout: 3000 });
      await page.evaluate(() => {
        for (const x of document.getAnimations()) if (String((x.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition')) x.finish();
      });
      await expect(tab(page, then)).toHaveAttribute('aria-current', 'page');
    }
  });
});
