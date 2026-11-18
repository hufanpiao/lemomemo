// 页签互切时右上角设置头像钉在原处不动（负责人 11-18 录屏“切页的时候头像抖动”：原来新页和旧页快照各带一个头像往两边滑，两三帧里叠出左右错开约 30 px 的两个）。
// 做法见 src/motion/page-swap.ts 的 data-swap-pin。这里在点页签的同一个任务里包住 Element.prototype.animate，
// 换页动画一建好（微任务里，还没出帧）就全部暂停、按进度拨到各点量：画面上看得见的头像（算上祖先的透明度）只有一个、全亮、位置和点之前一样；
// 拨回原处接着放，放完新页自己的头像露出来、还是那个位置。不靠帧率（CI WebKit 一帧几百毫秒也量得到）
import { expect, test } from './session-fixture.ts';
import { waitPreloaded } from './page-helpers.ts';

test.use({ loggedIn: true, viewport: { width: 430, height: 932 }, locale: 'zh-CN' });

/** 抽查的进度点 */
const AT = [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1] as const;

type Box = { x: number; y: number; w: number; h: number; op: number };

test('今天 → 待办 → 日历 → 随手记 → 今天：切页全程头像只有一个、全亮、不动', async ({ page }) => {
  await page.goto('/app/#/today');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30_000 });
  await waitPreloaded(page);
  for (const [tab, feature] of [
    ['待办', 'todos'],
    ['日历', 'calendar'],
    ['随手记', 'notes'],
    ['今天', 'today'],
  ] as const) {
    const res = await page.evaluate(
      ({ tab, at }) =>
        new Promise<{ before: Box[]; frames: Box[][]; err: string }>((done) => {
          /** 画面上看得见的头像：钉住的副本和真页面里的，算上自己和祖先的 visibility、透明度 */
          const visible = (): Box[] =>
            [...document.querySelectorAll<HTMLElement>('[data-swap-pin]')]
              .map((el) => {
                if (getComputedStyle(el).visibility !== 'visible') return null;
                let op = 1;
                for (let e: Element | null = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
                const r = el.getBoundingClientRect();
                if (r.width === 0 || op < 0.02) return null;
                return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width), h: Math.round(r.height), op: Math.round(op * 100) / 100 };
              })
              .filter((b): b is Box => b !== null);
          const before = visible();
          const link = [...document.querySelectorAll<HTMLAnchorElement>('[data-testid="tabbar"] a')].find((a) => a.textContent?.includes(tab));
          if (!link) return done({ before, frames: [], err: `找不到页签 ${tab}` });
          const orig = Element.prototype.animate;
          let queued = false;
          const timer = setTimeout(() => {
            Element.prototype.animate = orig;
            done({ before, frames: [], err: '2 秒内没起换页动画' });
          }, 2000);
          Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
            const a = orig.apply(this, args);
            if (!queued && this.matches('main')) {
              queued = true;
              queueMicrotask(() => {
                Element.prototype.animate = orig;
                clearTimeout(timer);
                const anims = document.getAnimations().filter((x) => x instanceof CSSAnimation === false && x instanceof CSSTransition === false);
                const total = Number(a.effect?.getComputedTiming().duration ?? 0);
                const keep = anims.map((x) => [x, x.currentTime, x.playState] as const);
                for (const x of anims) x.pause();
                const frames: Box[][] = [];
                for (const p of at) {
                  for (const x of anims) x.currentTime = p * total;
                  frames.push(visible());
                }
                for (const [x, t, st] of keep) {
                  x.currentTime = t;
                  if (st === 'running') x.play();
                }
                done({ before, frames, err: '' });
              });
            }
            return a;
          };
          link.click();
        }),
      { tab, at: [...AT] },
    );
    expect(res.err, tab).toBe('');
    expect(res.before, `${tab} 点之前头像应只有一个`).toHaveLength(1);
    const was = res.before[0] as Box;
    res.frames.forEach((f, i) => {
      const msg = `切到${tab} 进度 ${AT[i]}：看得见的头像 ${JSON.stringify(f)}，点之前 ${JSON.stringify(was)}`;
      expect(f, msg).toHaveLength(1);
      const b = f[0] as Box;
      expect(b.op, msg).toBeGreaterThanOrEqual(0.99);
      expect(Math.abs(b.x - was.x), msg).toBeLessThanOrEqual(0.5);
      expect(Math.abs(b.y - was.y), msg).toBeLessThanOrEqual(0.5);
    });
    // 放完：钉住的副本拿掉，新页自己的头像露出来，还在原处
    await page.locator(`main[data-feature="${feature}"]`).waitFor();
    await expect.poll(() => page.locator('[data-tab-pin]').count()).toBe(0);
    const end = await page.locator(`main[data-feature="${feature}"] [data-swap-pin]`).boundingBox();
    expect(end, `${tab} 放完新页头像`).not.toBeNull();
    expect(Math.abs((end?.x ?? 0) - was.x), `${tab} 放完位置`).toBeLessThanOrEqual(0.5);
    expect(Math.abs((end?.y ?? 0) - was.y), `${tab} 放完位置`).toBeLessThanOrEqual(0.5);
  }
});
