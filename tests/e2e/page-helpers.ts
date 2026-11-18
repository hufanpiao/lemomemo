// e2e 用例共用的页面小工具（第三方审查 CI-14、CI-15）：评审截图、等换页淡入放完、等位置停稳、触摸左滑、左滑失败时的诊断
import { expect, type Locator, type Page } from '@playwright/test';

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
 * 换页（或分包晚到）后 FADE_GUARD_MS（100ms）以内落在 main 里的点按按设计吞掉（src/motion/index.ts 的 fadeSwap、guardTaps）。
 * 吞点按的窗口和 main 的淡入同一刻开始，淡入（--dur-ui 220ms 减去跳过的一帧）比窗口长：等到页面上没有还在跑的 main 淡入，窗口就一定过了。
 * 等状态，不按毫秒睡（第三方审查 CI-15）；减少动态效果时没有淡入，这里立刻返回（那时的用例要自己另等）。
 * 前提：调之前先等到新页里的内容出来了（淡入和新 main 是同一刻挂上的）；刚点完切页就调，淡入可能还没起，会直接放行
 */
export async function afterPageFade(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const main = document.querySelector('main');
    return !main || main.getAnimations().every((a) => a.playState !== 'running');
  });
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
  // 行面挂上了才滑（今天页的 SwipeRow 首屏画完以后才下载，下好之前是滑不开的普通一行，R-428）
  await page.getByTestId(rowTestId).locator('[data-swipe-face]').first().waitFor({ state: 'attached', timeout: 15000 });
  const b = await page.getByTestId(rowTestId).boundingBox();
  if (!b) throw new Error(`找不到行 ${rowTestId}`);
  await touchSwipe(page, { x: b.x + b.width - 30, y: b.y + Math.min(b.height / 2, 22) }, b.width * frac);
}

/**
 * 左滑没打开时的诊断（只在失败时调）：点按起点最上层是谁、这一行往上每一层的 data-state 和 pointer-events、
 * 列表里带 data-state 的各层（进场、离场）、左滑运行日志、运行日志最后 30 行（运行日志 300ms 防抖才落到 localStorage，先等日志里出现松手那一行或最多 2 秒）
 */
export async function swipeDiag(page: Page, at: { x: number; y: number }, rowTestId: string, listTestId: string): Promise<string> {
  await page
    .waitForFunction(() => (localStorage.getItem('lemo-run-log') ?? '').includes('swipe up'), undefined, { timeout: 2000 })
    .catch(() => undefined);
  return page.evaluate(
    ([px, py, rid, lid]) => {
      const el = document.elementFromPoint(Number(px), Number(py));
      const top = el ? `${el.tagName.toLowerCase()}#${el.closest('[data-testid]')?.getAttribute('data-testid') ?? '-'}` : 'none';
      const chain: string[] = [];
      for (let n = document.querySelector(`[data-testid="${String(rid)}"]`); n && n.getAttribute('data-testid') !== lid; n = n.parentElement) {
        chain.push(`${n.tagName.toLowerCase()}[${n.getAttribute('data-testid') ?? '-'}] state=${n.getAttribute('data-state') ?? '-'} pe=${getComputedStyle(n).pointerEvents}`);
      }
      const layers = [...(document.querySelector(`[data-testid="${String(lid)}"]`)?.querySelectorAll('[data-state]') ?? [])]
        .map((g) => `${g.getAttribute('data-testid') ?? g.tagName.toLowerCase()}=${g.getAttribute('data-state') ?? '-'} op=${getComputedStyle(g).opacity}`)
        .join(',');
      const log = (localStorage.getItem('lemo-run-log') ?? '').split('\n');
      return [
        `列表里各层状态：${layers}`,
        `起点最上层：${top}；往上：${chain.join(' < ')}`,
        `左滑运行日志：${log.filter((l) => l.includes('swipe ')).slice(-12).join(' | ')}`,
        `运行日志最后 30 行：${log.slice(-30).join(' | ')}`,
      ].join(' | ');
    },
    [at.x, at.y, rowTestId, listTestId] as const,
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
        page.evaluate(() => {
          // 运行日志存在 localStorage、重新载入后旧行还在：只看这一次载入（最后一行 boot 之后）记的
          const ls = (localStorage.getItem('lemo-run-log') ?? '').split('\n');
          let i = ls.length - 1;
          while (i >= 0 && !/^t=\S+ boot /.test(ls[i] ?? '')) i--;
          return i >= 0 && ls.slice(i).some((l) => l.includes(' preload notes '));
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
}
