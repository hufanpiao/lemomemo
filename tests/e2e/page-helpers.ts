// e2e 用例共用的页面小工具（第三方审查 CI-14、CI-15）：评审截图、等换页淡入放完、等位置停稳、触摸左滑、左滑失败时的诊断
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * App 运行日志全文，在页面里跑：page.evaluate(readRunLogInPage)。11-20 起日志分段存（src/platform/run-log-store.ts：
 * 每段一个键 lemo-run-log.c<序号>），按序号拼起来；不要再直接读 localStorage 的 lemo-run-log（那个键已经不写了，
 * tests/build/run-log-readers.test.ts 拦）。函数里不引任何外面的东西，Playwright 才能原样传进页面
 */
export function readRunLogInPage(): string {
  const segs: number[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const m = /^lemo-run-log\.c(\d+)$/.exec(localStorage.key(i) ?? '');
    if (m) segs.push(Number(m[1]));
  }
  return segs
    .sort((a, b) => a - b)
    .map((n) => localStorage.getItem(`lemo-run-log.c${n}`) ?? '')
    .join('\n');
}
/** 同上，写成表达式字符串：给 waitForFunction 和别的页面函数里拼着用 */
export const RUN_LOG_EXPR = `(${readRunLogInPage.toString()})()`;

/** 设了 LEMO_SHOT_DIR 才截评审图（只在 Chromium 上截，不进仓库） */
export const SHOT_DIR = process.env['LEMO_SHOT_DIR'];

/**
 * 评审截图：Chromium、设了 LEMO_SHOT_DIR 才截（WebKit 截图会往页面插 <style>、被 CSP 记成违规），不设时不截也不等。
 * CSS 动画由 animations: 'disabled' 快进到末尾；JS 动画（列表挪位置）快进不了，先等 settleMs（默认 800ms，只为图好看，不是断言）
 */
export async function shot(page: Page, browserName: string, name: string, o: { fullPage?: boolean; settleMs?: number } = {}): Promise<void> {
  if (browserName !== 'chromium' || !SHOT_DIR) return;
  await page.waitForTimeout(o.settleMs ?? 800);
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, animations: 'disabled', fullPage: o.fullPage ?? false });
}

/**
 * 换页后 FADE_GUARD_MS（100ms）以内落在 main 里的点按按设计吞掉（src/motion/page-swap.ts 的 swap、guardTaps）。
 * 窗口在换页那一刻（新页晚到时是新页出来那一刻）起算，同一刻起播换页动画；旧页快照（[data-tab-ghost]）要等领头的动画放完才拿掉，
 * 动画（页签互切 880ms、整页推页、长成）都比窗口长：快照没了、main 里（含子孙：11-19 起淡入加在 main 的子树上，不在 main 自己身上）
 * 也没有还在跑的有限次动画（进场淡入、行的挪位），窗口就一定过了，量位置也不会量到半路。
 * 等状态，不按毫秒睡（第三方审查 CI-15、分诊表 11-14 遗留②）；冷启动（page.goto、reload）不经换页、没有窗口，这里立刻返回。
 * 减少动态效果时换页照样开窗口、但没有快照和动画，这里看不出来（那时的用例要自己另等）。
 * 前提：调之前先等到新页里的内容出来了；刚点完切页就调，换页可能还没起，会直接放行
 */
export async function afterPageFade(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    if (document.querySelector('[data-tab-ghost]')) return false;
    // 无限循环的（今天卡背景流动层、加载转圈）永远在跑，不算（同下面 animationsIdle）
    return [...document.querySelectorAll('main')].every((m) =>
      m.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
    );
  });
}

/**
 * 等整页的动画都停下：有限次的（进场、换页、弹层滑入、CSS 过渡）都不在跑。
 * 无限循环的（今天卡背景流动层 NowFlow 32 秒一圈、加载转圈）永远在跑、永远等不到，不算——只排除 iterations 为 Infinity 的这一类，别的照等
 * （ci #511：NowFlow 上线后今天页的“getAnimations() 全部不是 running”永远不成立，axe、电脑版布局等用例卡到超时）。
 * e2e 里等“动画都停”一律调这里，不在用例里各写一份 getAnimations().every(...)
 */
export async function animationsIdle(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
}

/**
 * 等弹层退场播完、卸载的超时（ci #512）。断言不变：弹层必须真的没了，这里只放宽“等多久”。
 * 量到的两个原因（CI 同款镜像限 1.5 核）：① WebKit 软件合成整页模糊，帧很稀；② page.clock 换掉了 performance.now、换不掉 document.timeline，
 * Motion 用前者定动画起点，动画要先空等两者的差（实测 0.1～2 秒）才开始走。247 ms 的退场因此 4～11 秒才卸载，真机没有这两样
 */
export const SHEET_GONE = { timeout: 25_000 };

/**
 * 把有限次的动画直接放到结尾；无限循环的跳过（对它 finish() 会抛 InvalidStateError，也没有“结尾”）。
 * within 给了选择器就只管匹配到的元素（含子孙）身上的，比如 'main'；不给就是整页
 */
export async function finishAnimations(page: Page, within?: string): Promise<void> {
  await page.evaluate((sel) => {
    const list = sel === null ? document.getAnimations() : [...document.querySelectorAll(sel)].flatMap((e) => e.getAnimations({ subtree: true }));
    for (const a of list) if (a.effect?.getTiming().iterations !== Infinity) a.finish();
  }, within ?? null);
}

/** 等 SW 就绪最多多久（ms）：只给 swReady 自己用，不占用例的超时 */
export const SW_READY_MAX_MS = 90_000;

/**
 * 等 Service Worker 装好（navigator.serviceWorker.ready），返回它的作用域。等的这段不算进用例的超时：先把超时放宽 SW_READY_MAX_MS，
 * 就绪以后改成“原来的超时 + 实际等了多久”，等于就绪以后才开始计时（分诊表 11-14 遗留④：本机全量并行时 webkit 装 SW 要预缓存整个 App，
 * 机器忙时比 30 秒的用例超时还慢，page.evaluate 等 SW 超时；单独跑、CI 上都快）。SW_READY_MAX_MS 内还没就绪照样报错
 */
export async function swReady(page: Page): Promise<string> {
  const info = test.info();
  const base = info.timeout;
  if (base > 0) info.setTimeout(base + SW_READY_MAX_MS);
  const t0 = Date.now();
  const scope = await page.evaluate(
    (ms) =>
      Promise.race([
        navigator.serviceWorker.ready.then((r) => r.scope),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Service Worker ${ms} ms 内没就绪`)), ms)),
      ]),
    SW_READY_MAX_MS,
  );
  if (base > 0) info.setTimeout(base + (Date.now() - t0));
  return scope;
}

/** 等元素位置停稳（相隔一小会儿量两次一样）再返回它的框：列表晚到的一行会把下面的行挤一下，量早了按不准 */
export async function stableBox(loc: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let last = '';
  let box: Awaited<ReturnType<Locator['boundingBox']>> = null;
  await expect
    .poll(
      async () => {
        box = await loc.boundingBox();
        const k = JSON.stringify(box);
        const same = box !== null && k === last;
        last = k;
        return same;
      },
      { message: '位置停稳', intervals: [50, 50, 100, 100, 200] },
    )
    .toBe(true);
  if (!box) throw new Error('没有框');
  return box;
}

/** jpeg() 的选项：不给就是 320×240、hsl(40 70% 55%) 一色、质量 0.9 */
export interface JpegOpts {
  hue?: number;
  w?: number;
  h?: number;
  /** 底色 hsl 的饱和度、亮度（默认 '70% 55%'） */
  tone?: string;
  /** 不给 hue 底色、改成左上到右下的渐变 */
  gradient?: readonly [string, string];
  /** 中间一块白方块（看得出是哪张图） */
  box?: boolean;
  /** 撒 n 块彩色小方块（压图用例要有细节、不是一色平铺） */
  tiles?: { n: number; w: number; h: number };
  quality?: number;
}

/** 浏览器里画一张 jpeg（插图、压图用例的素材：真的能被压图那条路解开）；e2e 只这一份 */
export async function jpeg(page: Page, o: JpegOpts = {}): Promise<Buffer> {
  const opts = { hue: 40, w: 320, h: 240, tone: '70% 55%', gradient: null, box: false, tiles: null, quality: 0.9, ...o };
  const bytes = await page.evaluate(async (p) => {
    const c = document.createElement('canvas');
    c.width = p.w;
    c.height = p.h;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no_ctx');
    if (p.gradient) {
      const g = ctx.createLinearGradient(0, 0, p.w, p.h);
      g.addColorStop(0, p.gradient[0]);
      g.addColorStop(1, p.gradient[1]);
      ctx.fillStyle = g;
    } else ctx.fillStyle = `hsl(${p.hue} ${p.tone})`;
    ctx.fillRect(0, 0, p.w, p.h);
    if (p.box) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(100, 70, 120, 100);
    }
    for (let i = 0; i < (p.tiles?.n ?? 0); i++) {
      ctx.fillStyle = `hsl(${(i * 37) % 360} 70% 50%)`;
      ctx.fillRect((i * 97) % p.w, (i * 53) % p.h, p.tiles?.w ?? 0, p.tiles?.h ?? 0);
    }
    const b = await new Promise<Blob>((res) => c.toBlob((x) => res(x as Blob), 'image/jpeg', p.quality));
    return [...new Uint8Array(await b.arrayBuffer())];
  }, opts);
  return Buffer.from(Uint8Array.from(bytes));
}

/**
 * 触摸左滑（chromium、webkit 都能跑）：在页面里对起点最上层的元素派发 pointerType=touch 的按下、10 次移动、松手。
 * 起点最上层是谁就派给谁，和真手指一样：挡在上面的层（pointer-events:none 的进场层会让点按穿到下面）照样会让左滑收不到。
 * pointerId 用 1（两种内核里一直“活着”的那个指针），左滑定方向后 setPointerCapture 才不报错
 */

export async function touchSwipe(page: Page, from: { x: number; y: number }, dx: number): Promise<void> {
  await page.evaluate(
    ([x, y, dx]) => {
      const target = document.elementFromPoint(x, y);
      if (!target) throw new Error('起点没有元素');
      const fire = (type: string, cx: number): void => {
        target.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: cx, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 }),
        );
      };
      fire('pointerdown', x);
      for (let i = 1; i <= 10; i++) fire('pointermove', x - (dx * i) / 10);
      fire('pointerup', x - dx);
    },
    [from.x, from.y, dx] as const,
  );
}

/**
 * 待办行左滑删除（负责人 11-15 去掉行尾 ×，kit SwipeRow 的 full）：在行右侧起手，触摸一口气拉过 80% 行宽，过了大半行松手直接删。
 * frac 给小一点（如 0.3）就是只露出“删除”按钮
 */
export async function swipeRow(page: Page, rowTestId: string, frac = 0.8): Promise<void> {
  const b = await swipeRowBox(page, rowTestId);
  await touchSwipe(page, { x: b.x + b.width - 30, y: b.y + Math.min(b.height / 2, 22) }, b.width * frac);
}

/**
 * 能滑的行的位置：等行面挂上（今天页的 SwipeRow 首屏画完以后才下载，下好之前是滑不开的普通一行，R-428），再等拿到框。
 * 机器忙时 webkit 的 boundingBox 会短暂返回 null，这时行还在、没被卸载（ci #516 实测：row 数 1、没有移除记录），所以重取
 */
export async function swipeRowBox(page: Page, rowTestId: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const row = page.getByTestId(rowTestId);
  await row.locator('[data-swipe-face]').first().waitFor({ state: 'attached', timeout: 15000 });
  let box: Awaited<ReturnType<Locator['boundingBox']>> = null;
  await expect
    .poll(async () => {
      box = await row.boundingBox();
      return box !== null;
    }, { message: `找不到行 ${rowTestId}`, timeout: 15000 })
    .toBe(true);
  return box as unknown as { x: number; y: number; width: number; height: number };
}

/**
 * 左滑没打开时的诊断（只在失败时调）：点按起点最上层是谁、这一行往上每一层的 data-state 和 pointer-events、
 * 列表里带 data-state 的各层（进场、离场）、左滑运行日志、运行日志最后 30 行（运行日志 300ms 防抖才落到 localStorage，先等日志里出现松手那一行或最多 2 秒）
 */
export async function swipeDiag(page: Page, at: { x: number; y: number }, rowTestId: string, listTestId: string): Promise<string> {
  await page
    .waitForFunction(`${RUN_LOG_EXPR}.includes('swipe up')`, undefined, { timeout: 2000 })
    .catch(() => undefined);
  const text = await page.evaluate(readRunLogInPage);
  return page.evaluate(
    ([px, py, rid, lid, all]) => {
      const el = document.elementFromPoint(Number(px), Number(py));
      const top = el ? `${el.tagName.toLowerCase()}#${el.closest('[data-testid]')?.getAttribute('data-testid') ?? '-'}` : 'none';
      const chain: string[] = [];
      for (let n = document.querySelector(`[data-testid="${String(rid)}"]`); n && n.getAttribute('data-testid') !== lid; n = n.parentElement) {
        chain.push(`${n.tagName.toLowerCase()}[${n.getAttribute('data-testid') ?? '-'}] state=${n.getAttribute('data-state') ?? '-'} pe=${getComputedStyle(n).pointerEvents}`);
      }
      const layers = [...(document.querySelector(`[data-testid="${String(lid)}"]`)?.querySelectorAll('[data-state]') ?? [])]
        .map((g) => `${g.getAttribute('data-testid') ?? g.tagName.toLowerCase()}=${g.getAttribute('data-state') ?? '-'} op=${getComputedStyle(g).opacity}`)
        .join(',');
      const log = String(all).split('\n');
      return [
        `列表里各层状态：${layers}`,
        `起点最上层：${top}；往上：${chain.join(' < ')}`,
        `左滑运行日志：${log.filter((l) => l.includes('swipe ')).slice(-12).join(' | ')}`,
        `运行日志最后 30 行：${log.slice(-30).join(' | ')}`,
      ].join(' | ');
    },
    [at.x, at.y, rowTestId, listTestId, text] as const,
  );
}

/**
 * 等冷启动预加载三页跑完（R-478：首屏画完、空闲以后后台下载并执行日历、待办、随手记三页，运行日志 preload <页>，随手记最后一页）。
 * 逐帧量动画的用例先等它：CI 的 WebKit 软件渲染一帧本来就要几百毫秒，再叠上三页分包的执行，第一帧拖到 1 秒、整段动画在一帧里播完
 * （ci 05ec494e：r420 翻月第一帧 1035 ms、b2-tabbar-transition 液滴没采到在跑；本机 chromium 降速 8 倍实测最长帧 233 ms 对 150 ms）
 */
export async function waitPreloaded(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(readRunLogInPage).then((text) => {
          // 运行日志存在 localStorage、重新载入后旧行还在：只看这一次载入（最后一行 boot 之后）记的
          const ls = text.split('\n');
          let i = ls.length - 1;
          while (i >= 0 && !/^t=\S+ boot /.test(ls[i] ?? '')) i--;
          return i >= 0 && ls.slice(i).some((l) => l.includes(' preload notes '));
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** 页面里的“暂停拨进度”（installScrub 挂到 window.__lemoScrub）：给 scrub 用的参数 */
export interface ScrubOpts<T> {
  /** 触发动画的那一下（同步做完，或最后一步同步做完的异步函数） */
  trigger: () => void | Promise<void>;
  /** 认哪个元素上建的 WAAPI 动画（第一个匹配的就是领头的，进度按它算） */
  match: (el: Element) => boolean;
  /** 按领头动画的进度（0～1）拨到这些点读值 */
  at: readonly number[];
  read: () => T;
  /** 最多等多久（ms）还没起动画就报错 */
  waitMs?: number;
}
export interface ScrubResult<T> {
  rows: T[];
  /** 领头动画的时长（ms） */
  total: number;
  err: string;
}
declare global {
  interface Window {
    __lemoScrub?: <T>(o: ScrubOpts<T>) => Promise<ScrubResult<T>>;
  }
}

/**
 * 逐帧量动画不靠帧率（#129：CI 的 WebKit 软件渲染一帧几百毫秒，0.2～0.9 秒的动画整段落在两帧之间、一帧都量不到）：
 * 包住 Element.prototype.animate，trigger 里领头的那个动画一建好，就在同一个任务的微任务里（还没出帧）把页面上全部动画暂停，
 * 按领头动画的进度拨到 at 各点调 read（别的动画保持和领头的相对时间差，CSS 过渡、CSS 动画也一样拨），读完拨回原处、原来在放的接着放。
 * 拨的期间不出帧，看不到拨过去的样子；动画只被往后推了读值花的那一点时间，起止值、曲线、时长都不变。
 * 用法：页面打开后 installScrub(page) 一次，再 page.evaluate(() => window.__lemoScrub!({...}))
 */
export async function installScrub(page: Page): Promise<void> {
  const define = (): void => {
    window.__lemoScrub = <T,>(o: ScrubOpts<T>): Promise<ScrubResult<T>> =>
      new Promise((done) => {
        const orig = Element.prototype.animate;
        let lead: Animation | null = null;
        // CSS 过渡、CSS 动画不走 animate()：属性、节点一变（MutationObserver 在出帧前的微任务里回调），就取 document.getAnimations()
        // （这个调用会先把样式算完，过渡当场建好），认 effect.target 匹配的那一个
        const mo = new MutationObserver(() => {
          if (lead) return;
          const a = document.getAnimations().find((x) => {
            const t = (x.effect as KeyframeEffect | null)?.target;
            return x.playState !== 'finished' && t instanceof Element && o.match(t);
          });
          if (a) begin(a);
        });
        const restore = (): void => {
          Element.prototype.animate = orig;
          mo.disconnect();
        };
        const timer = setTimeout(() => {
          restore();
          done({ rows: [], total: 0, err: `${o.waitMs ?? 3000} ms 内没起要量的动画` });
        }, o.waitMs ?? 3000);
        mo.observe(document, { subtree: true, attributes: true, childList: true });
        Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
          const a = orig.apply(this, args);
          if (lead === null && o.match(this)) begin(a);
          return a;
        };
        function begin(a: Animation): void {
          if (lead) return;
          {
            lead = a;
            queueMicrotask(() => {
              restore();
              clearTimeout(timer);
              const m = a;
              const total = Number(m.effect?.getComputedTiming().endTime ?? 0);
              const m0 = Number(m.currentTime ?? 0);
              const all = document.getAnimations().filter((x) => x.playState !== 'finished');
              const keep = all.map((x) => ({ x, t: x.currentTime, run: x.playState === 'running', d: Number(x.currentTime ?? 0) - m0 }));
              for (const k of keep) k.x.pause();
              const rows: T[] = [];
              try {
                for (const p of o.at) {
                  for (const k of keep) k.x.currentTime = Math.max(0, p * total + k.d);
                  rows.push(o.read());
                }
              } finally {
                for (const k of keep) {
                  k.x.currentTime = k.t;
                  if (k.run) k.x.play();
                }
              }
              done({ rows, total, err: '' });
            });
          }
        }
        void Promise.resolve(o.trigger()).catch((e: unknown) => {
          restore();
          clearTimeout(timer);
          done({ rows: [], total: 0, err: `trigger 出错：${String(e)}` });
        });
      });
  };
  await page.addInitScript(define);
  await page.evaluate(define);
}

/**
 * 拖动拿起那一下的放大（kit SortDrag：浮层里层 .card 先原样画一帧、再打 data-up，CSS 过渡放大到 1.04）：一打 data-up，就按过渡进度读 0、0.5 两点的放大倍数
 * （installScrub，不靠帧率；#129：原来取浮层头一帧，CI 的 webkit 两帧隔 120～170 ms，头一帧取到时已经放大完，只好在 CI webkit 不量）。
 * 先 installScrub(page)；在拿起以前调，拿起以后交给 expectLift
 */
export function watchLift(page: Page): Promise<ScrubResult<number>> {
  return page.evaluate(() =>
    window.__lemoScrub!({
      trigger: () => undefined,
      match: (e) => e.hasAttribute('data-up'),
      at: [0, 0.5],
      read: () => {
        const c = document.querySelector('[data-up]');
        const tf = c ? getComputedStyle(c).transform : '';
        return tf.startsWith('matrix(') ? Number(tf.slice(7).split(',')[0]) : 1;
      },
      waitMs: 5000,
    }),
  );
}

/** 拿起有过渡：拿起那一刻还没放大，过渡走到一半已经在放大 */
export async function expectLift(lift: Promise<ScrubResult<number>>): Promise<void> {
  const r = await lift;
  expect(r.err).toBe('');
  const [s0 = 0, s1 = 0] = r.rows;
  expect(s0, `拿起那一刻已经放大了：${r.rows.join('、')}`).toBeLessThan(1.02);
  expect(s1, `拿起的放大没有过渡：${r.rows.join('、')}`).toBeGreaterThan(s0 + 0.005);
}
