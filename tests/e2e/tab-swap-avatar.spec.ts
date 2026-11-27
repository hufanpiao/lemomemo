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
            // 新页的淡入加在 main 或 main 里的子树上（头像所在的那一支不加，page-swap.ts 的 fadeTargets）
            if (!queued && this.closest('main')) {
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

// 负责人 11-18 录屏：自己的图片头像切页时空约 0.83 秒（= 切页时长 0.88 秒）。副本里新建的 <img> 要重新加载、解码，iPhone 上整段切页都空着；
// 改成已解码的小图当场画进画布（motion/copy-node.ts paintSmall）。这里塞一张品红色 blob 图片当头像，切页动画一建好就暂停，
// 看副本里是画布、不是 <img>，而且画布中间那一点就是品红色（像素当场就有，不等加载）。
// 11-19 起副本只管新页出来之前那一段（新页一出来就拿掉），所以在副本插进页面的那一刻量
test('图片头像：切页时钉住的副本是画好的画布，当场就有像素', async ({ page }) => {
  await page.goto('/app/#/today');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30_000 });
  await waitPreloaded(page);
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    if (!g) throw new Error('没有 2d');
    g.fillStyle = '#ff00ff';
    g.fillRect(0, 0, 64, 64);
    const b = await new Promise<Blob>((ok, no) => c.toBlob((x) => (x ? ok(x) : no(new Error('toBlob'))), 'image/png'));
    const img = document.createElement('img');
    img.src = URL.createObjectURL(b);
    await img.decode();
    const host = document.querySelector('main [data-swap-pin] span');
    if (!host) throw new Error('没有头像');
    host.append(img);
  });
  const got = await page.evaluate(
    () =>
      new Promise<{ canvas: number; img: number; rgb: number[] }>((done) => {
        const link = [...document.querySelectorAll<HTMLAnchorElement>('[data-testid="tabbar"] a')].find((a) => a.textContent?.includes('待办'));
        const mo = new MutationObserver((recs) => {
          const box = recs.flatMap((r) => [...r.addedNodes]).find((n): n is Element => n instanceof Element && n.hasAttribute('data-tab-pin'));
          if (!box) return;
          mo.disconnect();
          const cv = box.querySelector('canvas');
          const px = cv?.getContext('2d')?.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
          done({ canvas: box.querySelectorAll('canvas').length, img: box.querySelectorAll('img').length, rgb: px ? [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0] : [] });
        });
        mo.observe(document.body, { childList: true });
        link?.click();
      }),
  );
  expect(got.canvas, '副本里是画布').toBe(1);
  expect(got.img, '副本里没有要重新加载的 <img>').toBe(0);
  expect(got.rgb, '画布中间是头像的品红色').toEqual([255, 0, 255]);
});

// 负责人 11-19“头像怎么也还是会消失”：上一次切页还在播（880 ms）就又点了别的页签。原来新页的头像整段切页透明（opacity: 0）、由副本代画，
// 连点时下一次的副本抄到了这条透明，整段切页头像没了（11-19 实时逐帧：第二下之后约 1.2 秒看得见的头像为 0 个）；
// 还在等新页时又切，拷的是藏着的旧页（宽 0），头像跑到左边 x 44。
// 这里真的连点（不暂停动画），每 8 ms 量一次画面上看得见的头像（不用 requestAnimationFrame：本机 WebKit 后台标签会停帧几十秒）：
// 从点第一下到停住后再多 1 秒，每次都正好一个、全亮、在原处
test('连点切页：上一次没播完就切下一页，每一帧头像都在', async ({ page }) => {
  await page.goto('/app/#/today');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-motion') === 'ready', undefined, { timeout: 30_000 });
  await waitPreloaded(page);
  for (const [first, second] of [
    ['待办', '日历'],
    ['随手记', '今天'],
  ] as const) {
    const bad = await page.evaluate(
      ([first, second]) =>
        new Promise<string[]>((done) => {
          const tab = (name: string) => [...document.querySelectorAll<HTMLAnchorElement>('[data-testid="tabbar"] a')].find((a) => a.textContent?.includes(name));
          const visible = (): { x: number; y: number; op: number }[] =>
            [...document.querySelectorAll<HTMLElement>('[data-swap-pin]')].flatMap((el) => {
              if (getComputedStyle(el).visibility !== 'visible') return [];
              let op = 1;
              for (let e: Element | null = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
              const r = el.getBoundingClientRect();
              return r.width === 0 || op < 0.02 ? [] : [{ x: r.x, y: r.y, op }];
            });
          const was = visible()[0];
          if (!was) return done(['点之前没有头像']);
          const out: string[] = [];
          const t0 = performance.now();
          let clicked = false;
          let still = 0;
          const tick = (): void => {
            const now = performance.now();
            const v = visible();
            const one = v[0];
            if (v.length !== 1 || !one || one.op < 0.99 || Math.abs(one.x - was.x) > 0.5 || Math.abs(one.y - was.y) > 0.5) out.push(`${Math.round(now - t0)}ms ${JSON.stringify(v)}`);
            // 第二下在第一次切页正在播的时候点（快照还在、淡入还没完）
            if (!clicked && now - t0 >= 250 && document.querySelector('[data-tab-ghost]')) {
              clicked = true;
              tab(second)?.click();
            }
            if (clicked && still === 0 && !document.querySelector('[data-tab-ghost],[data-tab-pin]')) still = now;
            if (still > 0 && now - still > 1000) return done(out);
            if (now - t0 > 15_000) return done([...out, `15 秒没停住（第二下${clicked ? '已' : '没'}点）`]);
            setTimeout(tick, 8);
          };
          tab(first)?.click();
          setTimeout(tick, 8);
        }),
      [first, second] as const,
    );
    expect(bad, `${first} → ${second} 连点：头像不在、不止一个、不全亮或移位的帧`).toEqual([]);
  }
});
