// PPT 的本机退路（架构 5.13 第 3 点“退路”；线框 sPrev“微软 20 秒没打开时：首页缩略图 + 每页文字”）。
// 只读 docProps/thumbnail.jpeg（首页缩略图，转成 blob: 地址）和 ppt/slides/slideN.xml 里 <a:t> 的文字，按页列出（前面是页码数字）：第一段当标题，后面并成一行小字。
// 不执行、不渲染 PPT 里的任何别的东西；XML 用 DOMParser 解析（不插进页面），文字一律 textContent。
// prep：页数（ppt/slides/slideN.xml 的个数）、每页 <a:t> 并成一行的纯文本、docProps/thumbnail.jpeg 缩成的 PNG（没有就 null）；和渲染共用 slideList、slideTexts
import JSZip from './zip-lite.ts';
import type { Post, View } from './main.ts';
import { imageThumb, TextSink, type Prep } from './prep-kit.ts';

const SLIDE = /^ppt\/slides\/slide(\d+)\.xml$/;
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const THUMB = 'docProps/thumbnail.jpeg';
export const MAX_SLIDES = 500;

/** 按页码排好的全部页（不截断） */
function slideList(zip: JSZip): { name: string; i: number }[] {
  return Object.keys(zip.files)
    .map((n) => ({ n, m: SLIDE.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
    .map((x) => ({ name: x.n, i: Number(x.m[1]) }))
    .sort((a, b) => a.i - b.i);
}

/** 一页里 <a:t> 的文字，去掉空段 */
async function slideTexts(zip: JSZip, name: string, parser: DOMParser): Promise<string[]> {
  const xml = parser.parseFromString((await zip.file(name)?.async('string')) ?? '', 'application/xml');
  return [...xml.getElementsByTagNameNS(A_NS, 't')].map((t) => (t.textContent ?? '').trim()).filter(Boolean);
}

/** PPT 自带的首页缩略图（JPEG），没有就 null */
async function thumbJpeg(zip: JSZip): Promise<Blob | null> {
  const f = zip.file(THUMB);
  return f ? new Blob([await f.async('arraybuffer')], { type: 'image/jpeg' }) : null;
}

export async function render(root: HTMLElement, bytes: ArrayBuffer, post: Post): Promise<View> {
  const zip = await JSZip.loadAsync(bytes);
  const box = document.createElement('div');
  box.className = 'pv-slides';
  const thumb = await thumbJpeg(zip);
  if (thumb) {
    const img = document.createElement('img');
    img.className = 'pv-thumb';
    img.alt = '';
    img.src = URL.createObjectURL(thumb);   // 不 revoke：随沙箱 iframe 一起释放（main.ts）
    box.append(img);
  }
  const slides = slideList(zip).slice(0, MAX_SLIDES);
  const parser = new DOMParser();
  for (const s of slides) {
    const texts = await slideTexts(zip, s.name, parser);
    const row = document.createElement('div');
    row.className = 'pv-slide';
    const no = document.createElement('span');
    no.textContent = String(s.i);   // 只写页码数字：沙箱里没有词典（A20），数字中韩都看得懂
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

/** 预览材料：页数、每页一行的纯文本（满 20000 字就停）、首页缩略图（缩成 PNG；没有或解不开就 null） */
export async function prep(bytes: ArrayBuffer): Promise<Prep> {
  const zip = await JSZip.loadAsync(bytes);
  const slides = slideList(zip);
  const parser = new DOMParser();
  const sink = new TextSink();
  for (const s of slides) if (!sink.add((await slideTexts(zip, s.name, parser)).join(' '))) break;
  const jpeg = await thumbJpeg(zip);
  const thumb = jpeg ? await imageThumb(jpeg).catch(() => null) : null;
  return { pages: slides.length, text: sink.text, thumb };
}
