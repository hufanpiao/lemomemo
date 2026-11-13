// PDF 预览（架构 5.13 第 3 点：pdf.js ≥ 4.2.67、不 eval、不启用 PDF 里的脚本和表单）。
// • pdf.js 6.x 已经整个去掉了按 eval 编译字体、函数的路径（isEvalSupported 选项也没了，build 里搜不到 new Function / eval(）；沙箱 CSP 的 script-src 'self' 本来也不放行 eval
// • 只画到 canvas，不建文字层、注释层：PDF 里的链接、表单、脚本一律不出现，也就没有可点的外链
// • 不起 Worker：沙箱没有来源，起不了同源 Worker；先 import pdf.worker.mjs（挂上 globalThis.pdfjsWorker），pdf.js 就在本页跑（代定，交回报告写明）
// • 页按需画：先按每页尺寸占位，滚到附近（IntersectionObserver）才画；缩放时清掉重画
// • connect-src 'none'：CMap、标准字体、wasm 都取不到，pdf.js 用内嵌字体和系统字体（没嵌字体的中日韩 PDF 可能缺字，交回报告写明）
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import 'pdfjs-dist/build/pdf.worker.mjs';
import type { Post, View } from './main.ts';

/** 100% 时一页的显示宽度（CSS px，A4 竖版约 1:1.414） */
const BASE_W = 720;

export async function render(root: HTMLElement, bytes: ArrayBuffer, post: Post): Promise<View> {
  const doc: PDFDocumentProxy = await getDocument({ data: new Uint8Array(bytes), enableXfa: false, useSystemFonts: true, stopAtErrors: false }).promise;
  const pages = doc.numPages;
  const box = document.createElement('div');
  box.className = 'pv-pages';
  root.append(box);
  let zoom = 100;
  let current = 1;
  const drawn = new Set<number>();
  // 缩放代号：缩放时 +1，画到一半的旧比例页画完发现代号变了就丢掉，不盖住新比例的页（整块评审第 10 条）
  let gen = 0;
  const slots: HTMLDivElement[] = [];
  const first = await doc.getPage(1);
  const ratio = first.getViewport({ scale: 1 }).height / first.getViewport({ scale: 1 }).width;
  const state = (): void => post({ t: 'state', page: current, pages, zoom, sheets: [], sheet: 0, clipped: false });

  async function draw(n: number): Promise<void> {
    if (drawn.has(n)) return;
    drawn.add(n);
    const g = gen;
    const slot = slots[n - 1];
    if (!slot) return;
    const page = await doc.getPage(n);
    const w = (BASE_W * zoom) / 100;
    const vp = page.getViewport({ scale: (w / page.getViewport({ scale: 1 }).width) * (window.devicePixelRatio || 1) });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    c.className = 'pv-page';
    c.style.width = `${w}px`;
    await page.render({ canvas: c, viewport: vp }).promise;
    if (g !== gen) return;
    slot.replaceChildren(c);
  }

  const near = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) void draw(Number((e.target as HTMLElement).dataset['n'])).catch(() => undefined);   // 某一页画坏了就空着那一页，不影响别的页
  }, { rootMargin: '800px 0px' });
  const seen = new IntersectionObserver((es) => {
    const top = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!top) return;
    current = Number((top.target as HTMLElement).dataset['n']);
    state();
  }, { threshold: 0.5 });

  function layout(): void {
    const w = (BASE_W * zoom) / 100;
    for (const s of slots) {
      s.style.width = `${w}px`;
      s.style.height = `${Math.round(w * ratio)}px`;
    }
  }
  for (let n = 1; n <= pages; n++) {
    const s = document.createElement('div');
    s.className = 'pv-page';
    s.dataset['n'] = String(n);
    slots.push(s);
    box.append(s);
    near.observe(s);
    seen.observe(s);
  }
  layout();
  state();
  return {
    page(n) {
      slots[Math.min(Math.max(n, 1), pages) - 1]?.scrollIntoView({ block: 'start' });
    },
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
