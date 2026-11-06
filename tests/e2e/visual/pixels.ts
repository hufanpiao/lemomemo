// 视觉基准组的截图解码和像素统计（visual-helpers.ts 的说明里讲了 D = A − B 的思路）：
// 截图在一个独立的空白页里解码成灰度（Rec.709 亮度，0～255，按设备像素），统计全是纯函数。
import type { Browser, Page } from '@playwright/test';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function rectOf(page: Page, testid: string): Promise<Rect> {
  const r = await page.getByTestId(testid).boundingBox();
  if (!r) throw new Error(`量不到 ${testid}`);
  return r;
}

/** 胶囊（底栏）里面的一块：去掉两端的半圆（半径 = 高度一半），上下再缩 d。只缩矩形的话两端圆角外面的字是直接露出来的，会被当成“透过玻璃” */
export function pillCore(r: Rect, d: number): Rect {
  const rad = r.height / 2;
  return {
    x: r.x + rad,
    y: r.y + d,
    width: Math.max(1, r.width - 2 * rad),
    height: Math.max(1, r.height - 2 * d),
  };
}

/** 往里缩 d（CSS px），避开圆角和亮边 */
export function inset(r: Rect, d: number): Rect {
  return {
    x: r.x + d,
    y: r.y + d,
    width: Math.max(1, r.width - 2 * d),
    height: Math.max(1, r.height - 2 * d),
  };
}

/** 皮肤令牌 --bg 的亮度（simple 皮肤是 #RRGGBB） */
export async function bgLuma(page: Page): Promise<number> {
  const hex = (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg'))).trim();
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`--bg 不是 #RRGGBB：${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x ?? '0', 16));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** 一张灰度图（亮度 0～255，按设备像素） */
export interface Luma {
  w: number;
  h: number;
  d: Float32Array;
}

const decoders = new WeakMap<Browser, Promise<Page>>();

/** 截图解码：开一个空白页（独立上下文，不带 App 的脚本），用 createImageBitmap + canvas 读像素（webkit 的空白页没有 OffscreenCanvas），算 Rec.709 亮度 */
export async function decode(browser: Browser, png: Buffer): Promise<Luma> {
  let p = decoders.get(browser);
  if (!p) {
    p = browser.newPage();
    decoders.set(browser, p);
  }
  const dec = await p;
  const out = await dec.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const g = c.getContext('2d');
    if (!g) throw new Error('没有 2d 上下文');
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const l = new Uint8Array(bmp.width * bmp.height);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 1) l[j] = Math.round(0.2126 * (px[i] ?? 0) + 0.7152 * (px[i + 1] ?? 0) + 0.0722 * (px[i + 2] ?? 0));
    let s = '';
    for (let i = 0; i < l.length; i += 0x8000) s += String.fromCharCode(...l.subarray(i, i + 0x8000));
    return { w: bmp.width, h: bmp.height, b64: btoa(s) };
  }, png.toString('base64'));
  const raw = Buffer.from(out.b64, 'base64');
  return { w: out.w, h: out.h, d: Float32Array.from(raw) };
}

/** 截一块区域（CSS px）并解码；scale: 'css' 按 1 倍截（大块区域做整体拟合用，省时间） */
export async function grab(page: Page, clip: Rect, scale: 'device' | 'css' = 'device'): Promise<{ png: Buffer; luma: Luma }> {
  // animations: 'allow'、caret: 'initial'：Playwright 关动画、藏光标是往页面里插 <style>，会触发 CSP style-src-elem 违规（csp-fixture 判失败）；
  // 光标用 freeze() 的构造样式表藏，动画用 still() 自己结束
  const png = await page.screenshot({
    clip,
    scale,
    animations: 'allow',
    caret: 'initial',
  });
  const browser = page.context().browser();
  if (!browser) throw new Error('拿不到 browser');
  return { png, luma: await decode(browser, png) };
}

/**
 * 这个浏览器画不画 backdrop-filter 的模糊：空白页里 2px 黑白竖条，上面盖一块 blur(8px)，看盖住的地方还有没有黑白条。
 * 本机 Windows 的 Playwright WebKit 实测：CSS.supports 说支持，但根本不画（条纹原样），判“糊不糊”的断言在那里没有意义；
 * CI 的 Linux WebKit 画（软件合成，慢；第七轮 CI 探针关掉模糊后帧率回升，说明确实在画）。
 */
export async function backdropBlurWorks(browser: Browser): Promise<boolean> {
  const p = await browser.newPage({
    viewport: { width: 200, height: 60 },
    deviceScaleFactor: 1,
  });
  try {
    await p.setContent(
      '<style>body{margin:0}.s{position:absolute;inset:0;background:repeating-linear-gradient(90deg,#000 0 2px,#fff 2px 4px)}' +
        '.f{position:fixed;left:0;top:0;width:100px;height:60px;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}</style><div class=s></div><div class=f></div>',
    );
    const png = await p.screenshot({
      clip: { x: 20, y: 20, width: 60, height: 20 },
    });
    const l = await decode(browser, png);
    return Math.sqrt(meanVar(l.d).variance) < 30; // 不模糊时黑白条标准差约 127，模糊后接近 0
  } finally {
    await p.close();
  }
}

// ── 像素统计（纯函数） ───────────────────────────────────────────

export function sub(a: Luma, b: Luma): Luma {
  if (a.w !== b.w || a.h !== b.h) throw new Error(`尺寸不一样 ${a.w}×${a.h} / ${b.w}×${b.h}`);
  const d = new Float32Array(a.d.length);
  for (let i = 0; i < d.length; i += 1) d[i] = (a.d[i] ?? 0) - (b.d[i] ?? 0);
  return { w: a.w, h: a.h, d };
}

export function meanVar(xs: ArrayLike<number>): {
  mean: number;
  variance: number;
} {
  let s = 0;
  for (let i = 0; i < xs.length; i += 1) s += xs[i] ?? 0;
  const mean = s / Math.max(1, xs.length);
  let v = 0;
  for (let i = 0; i < xs.length; i += 1) v += ((xs[i] ?? 0) - mean) ** 2;
  return { mean, variance: v / Math.max(1, xs.length) };
}

/** 平均绝对值 */
export function meanAbs(img: Luma): number {
  let s = 0;
  for (const x of img.d) s += Math.abs(x);
  return s / Math.max(1, img.d.length);
}

/** 逐行：每一行（设备像素）横向的亮度均值和方差 */
export function rows(img: Luma): { mean: number; variance: number }[] {
  const out: { mean: number; variance: number }[] = [];
  for (let y = 0; y < img.h; y += 1) out.push(meanVar(img.d.subarray(y * img.w, (y + 1) * img.w)));
  return out;
}

/** 边缘强度：相邻像素（横、竖）亮度差的绝对值的平均。字清楚时大，糊了小 */
export function edge(img: Luma): number {
  let s = 0;
  let n = 0;
  for (let y = 0; y < img.h - 1; y += 1) {
    for (let x = 0; x < img.w - 1; x += 1) {
      const i = y * img.w + x;
      const c = img.d[i] ?? 0;
      s += Math.abs((img.d[i + 1] ?? 0) - c) + Math.abs((img.d[i + img.w] ?? 0) - c);
      n += 1;
    }
  }
  return s / Math.max(1, n);
}

/**
 * 叠字拟合：f ≈ a·o + b·n（最小二乘），o、n、f 都是“减去只有底色那一张”以后的图。
 * a 是旧页在这一帧里还剩多少，b 是新页出来了多少；两个都明显大于 0 就是新旧两页的字叠在一起
 */
export function mix(f: Luma, o: Luma, n: Luma): { a: number; b: number } {
  let soo = 0;
  let snn = 0;
  let son = 0;
  let sof = 0;
  let snf = 0;
  for (let i = 0; i < f.d.length; i += 1) {
    const x = o.d[i] ?? 0;
    const y = n.d[i] ?? 0;
    const z = f.d[i] ?? 0;
    soo += x * x;
    snn += y * y;
    son += x * y;
    sof += x * z;
    snf += y * z;
  }
  const det = soo * snn - son * son;
  if (det === 0) return { a: 0, b: 0 };
  return { a: (sof * snn - snf * son) / det, b: (snf * soo - sof * son) / det };
}

export const r2 = (x: number): number => Math.round(x * 100) / 100;
