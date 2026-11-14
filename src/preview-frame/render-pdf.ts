// PDF 预览（架构 5.13 第 3 点：pdf.js ≥ 4.2.67、不 eval、不启用 PDF 里的脚本和表单）。
// • pdf.js 6.x 已经整个去掉了按 eval 编译字体、函数的路径（isEvalSupported 选项也没了，build 里搜不到 new Function / eval(）；沙箱 CSP 的 script-src 'self' 本来也不放行 eval
// • 只画到 canvas，不建文字层、注释层：PDF 里的链接、表单、脚本一律不出现，也就没有可点的外链
// • 不起 Worker：沙箱没有来源，起不了同源 Worker；先 import pdf.worker.mjs（挂上 globalThis.pdfjsWorker），pdf.js 就在本页跑（代定，交回报告写明）
// • 页按需画：先按每页尺寸占位，滚到附近（IntersectionObserver）才画；缩放时清掉重画
// • 左边一列页缩略图（线框 sPrev 电脑浮层）：预览区宽 ≥ 720 px 才显示（frame.css 的容器查询；手机不显示，display:none 的缩略图不会进视野，也就不画）；
//   缩略图同样进入视野才画；当前页加粗边框（aria-current），点了滚到那一页
// • 当前页：视口正中那条线落在哪一页就是哪一页（页比视口高时，按“露出一半”判断会一直判不出来）
// • connect-src 'none'：CMap、标准字体、wasm 都取不到，pdf.js 用内嵌字体和系统字体（没嵌字体的中日韩 PDF 可能缺字，交回报告写明）
// • prep：页数、逐页 getTextContent 的纯文本、第一页缩略图（PNG，长边 ≤ 384）
import { getDocument, type PDFDocumentLoadingTask, type PDFPageProxy } from 'pdfjs-dist';
import 'pdfjs-dist/build/pdf.worker.mjs';
import type { Post, View } from './main.ts';
import { pngOf, TextSink, thumbScale, type Prep } from './prep-kit.ts';

/** 100% 时一页的显示宽度（CSS px，A4 竖版约 1:1.414） */
const BASE_W = 720;
/** 左侧缩略图的显示宽度（CSS px；整列约 120 px，见 frame.css .pv-rail） */
const THUMB_W = 96;

const load = (bytes: ArrayBuffer): PDFDocumentLoadingTask =>
  getDocument({ data: new Uint8Array(bytes), enableXfa: false, useSystemFonts: true, stopAtErrors: false });

/**
 * 按显示宽度 w（CSS px）把一页画进新 canvas（按屏幕像素比画清楚）。
 * hidden = true（prep 用）：按 intent 'print' 画，pdf.js 就不靠 requestAnimationFrame 分段——App 用隐藏的沙箱 iframe 调 prep，
 * Chromium 里 display:none 的 iframe 不跑 requestAnimationFrame，按默认的 'display' 画会一直画不完（e2e 实测卡住）
 */
async function paint(page: PDFPageProxy, w: number, dpr: number, hidden = false): Promise<HTMLCanvasElement> {
  const vp = page.getViewport({ scale: (w / page.getViewport({ scale: 1 }).width) * dpr });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width);
  c.height = Math.floor(vp.height);
  c.style.width = `${w}px`;
  await page.render({ canvas: c, viewport: vp, intent: hidden ? 'print' : 'display' }).promise;
  return c;
}

export async function render(root: HTMLElement, bytes: ArrayBuffer, post: Post): Promise<View> {
  const doc = await load(bytes).promise;
  const pages = doc.numPages;
  const dpr = window.devicePixelRatio || 1;
  const wrap = document.createElement('div');
  wrap.className = 'pv-pdf';
  const rail = document.createElement('nav');
  rail.className = 'pv-rail';
  const box = document.createElement('div');
  box.className = 'pv-pages';
  wrap.append(rail, box);
  root.append(wrap);
  let zoom = 100;
  let current = 1;
  const drawn = new Set<number>();
  // 缩放代号：缩放时 +1，画到一半的旧比例页画完发现代号变了就丢掉，不盖住新比例的页（整块评审第 10 条）
  let gen = 0;
  const slots: HTMLDivElement[] = [];
  const thumbs: HTMLButtonElement[] = [];
  const first = await doc.getPage(1);
  const ratio = first.getViewport({ scale: 1 }).height / first.getViewport({ scale: 1 }).width;

  function mark(): void {
    for (const [i, b] of thumbs.entries()) {
      if (i + 1 === current) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    // 当前页的缩略图露出缩略图列以外时，只滚缩略图列（不用 scrollIntoView：它会连带滚整页）
    const b = thumbs[current - 1];
    if (!b || rail.clientHeight === 0) return;
    const r = rail.getBoundingClientRect();
    const t = b.getBoundingClientRect();
    if (t.top < r.top || t.bottom > r.bottom) rail.scrollTop += t.top - r.top - 8;
  }
  const state = (): void => {
    mark();
    post({ t: 'state', page: current, pages, zoom, sheets: [], sheet: 0, clipped: false });
  };

  async function draw(n: number): Promise<void> {
    if (drawn.has(n)) return;
    drawn.add(n);
    const g = gen;
    const slot = slots[n - 1];
    if (!slot) return;
    const c = await paint(await doc.getPage(n), (BASE_W * zoom) / 100, dpr);
    c.className = 'pv-page';
    if (g !== gen) return;
    slot.replaceChildren(c);
  }
  const thumbDrawn = new Set<number>();
  async function drawThumb(n: number): Promise<void> {
    if (thumbDrawn.has(n)) return;
    thumbDrawn.add(n);
    const c = await paint(await doc.getPage(n), THUMB_W, dpr);
    thumbs[n - 1]?.firstElementChild?.replaceChildren(c);
  }

  // 某一页画坏了就空着那一页，不影响别的页；从“画过”里去掉，滚回来再试一次（评审 20）
  const tryDraw = (fn: (n: number) => Promise<void>, done: Set<number>, n: number): void => {
    void fn(n).catch(() => {
      done.delete(n);
    });
  };
  const near = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) tryDraw(draw, drawn, Number((e.target as HTMLElement).dataset['n']));
  }, { rootMargin: '800px 0px' });
  const nearThumb = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) tryDraw(drawThumb, thumbDrawn, Number((e.target as HTMLElement).dataset['n']));
  }, { root: rail, rootMargin: '300px 0px' });
  const seen = new IntersectionObserver((es) => {
    const hit = es.find((e) => e.isIntersecting);
    if (!hit) return;
    current = Number((hit.target as HTMLElement).dataset['n']);
    state();
  }, { rootMargin: '-50% 0px -50% 0px' });

  function layout(): void {
    const w = (BASE_W * zoom) / 100;
    for (const s of slots) s.style.width = `${w}px`;   // 高度按 aspect-ratio 跟着宽度走：窗口窄、宽度被 max-width 压小时不留空白
  }
  function goto(n: number): void {
    slots[Math.min(Math.max(n, 1), pages) - 1]?.scrollIntoView({ block: 'start' });
  }
  for (let n = 1; n <= pages; n++) {
    const s = document.createElement('div');
    s.className = 'pv-page';
    s.dataset['n'] = String(n);
    s.style.aspectRatio = String(1 / ratio);
    slots.push(s);
    box.append(s);
    near.observe(s);
    seen.observe(s);

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pv-tn';
    b.dataset['n'] = String(n);
    const img = document.createElement('div');
    img.className = 'pv-tn-img';
    img.style.aspectRatio = String(1 / ratio);
    const no = document.createElement('span');
    no.textContent = String(n);   // 只写页码数字：沙箱里没有词典（A20）
    b.append(img, no);
    b.addEventListener('click', () => {
      goto(n);
      current = n;
      state();
    });
    thumbs.push(b);
    rail.append(b);
    nearThumb.observe(b);
  }
  layout();
  state();
  return {
    page: goto,
    zoom(z) {
      zoom = z;
      gen++;
      drawn.clear();
      for (const s of slots) s.replaceChildren();
      layout();
      for (const s of slots) {
        near.unobserve(s);
        near.observe(s);
      }
      state();
    },
    sheet() {},
  };
}

/** 预览材料：页数、纯文本（逐页 getTextContent，满 20000 字就停）、第一页缩略图（画不出来就 null，不影响文字） */
export async function prep(bytes: ArrayBuffer): Promise<Prep> {
  const task = load(bytes);
  try {
    const doc = await task.promise;
    const sink = new TextSink();
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const line = tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('');
      page.cleanup();
      if (!sink.add(line)) break;
    }
    let thumb: ArrayBuffer | null = null;
    try {
      const p1 = await doc.getPage(1);
      const base = p1.getViewport({ scale: 1 });
      thumb = await pngOf(await paint(p1, base.width * thumbScale(base.width, base.height), 1, true));
    } catch {
      thumb = null;
    }
    return { pages: doc.numPages, text: sink.text, thumb };
  } finally {
    await task.destroy();   // 一个沙箱可以连着 prep 多个文件，每个做完就释放
  }
}
