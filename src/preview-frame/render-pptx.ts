// PPT 的本机退路（架构 5.13 第 3 点“退路”；线框 sPrev“微软 20 秒没打开时：首页缩略图 + 每页文字”）。
// 只读 docProps/thumbnail.jpeg（首页缩略图，转成 blob: 地址）和 ppt/slides/slideN.xml 里 <a:t> 的文字，按页列出：第一段当标题，后面并成一行小字。
// 不执行、不渲染 PPT 里的任何别的东西；XML 用 DOMParser 解析（不插进页面），文字一律 textContent。
import JSZip from './zip-lite.ts';
import type { Post, View } from './main.ts';

const SLIDE = /^ppt\/slides\/slide(\d+)\.xml$/;
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const MAX_SLIDES = 500;

export async function render(root: HTMLElement, bytes: ArrayBuffer, post: Post, lang: 'zh' | 'ko'): Promise<View> {
  const zip = await JSZip.loadAsync(bytes);
  const box = document.createElement('div');
  box.className = 'pv-slides';
  const thumb = zip.file('docProps/thumbnail.jpeg');
  if (thumb) {
    const img = document.createElement('img');
    img.className = 'pv-thumb';
    img.alt = '';
    img.src = URL.createObjectURL(new Blob([await thumb.async('arraybuffer')], { type: 'image/jpeg' }));
    box.append(img);
  }
  const slides = Object.keys(zip.files)
    .map((n) => ({ n, m: SLIDE.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
    .map((x) => ({ name: x.n, i: Number(x.m[1]) }))
    .sort((a, b) => a.i - b.i)
    .slice(0, MAX_SLIDES);
  const parser = new DOMParser();
  for (const s of slides) {
    const xml = parser.parseFromString(await zip.file(s.name)!.async('string'), 'application/xml');
    const texts = [...xml.getElementsByTagNameNS(A_NS, 't')].map((t) => (t.textContent ?? '').trim()).filter(Boolean);
    const row = document.createElement('div');
    row.className = 'pv-slide';
    const no = document.createElement('span');
    no.textContent = lang === 'ko' ? `${s.i}쪽` : `第 ${s.i} 页`;
    const tx = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = texts[0] ?? '';
    tx.append(b);
    if (texts.length > 1) {
      const p = document.createElement('p');
      p.textContent = texts.slice(1).join(' · ').slice(0, 300);
      tx.append(p);
    }
    row.append(no, tx);
    box.append(row);
  }
  root.append(box);
  post({ t: 'state', page: 1, pages: slides.length, zoom: 100, sheets: [], sheet: 0, clipped: false });
  return { page() {}, zoom() {}, sheet() {} };
}
