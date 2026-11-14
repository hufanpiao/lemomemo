// 预览沙箱（架构 5.13 第 3 点、架构约定 9.7；Vite 的第三个入口 /app/preview.html，网页版 iframe 的 src 写 /app/preview）。
// • 只收 window.parent 发来、过了 shared/logic/files/preview-protocol.ts 核对的消息；回消息一律发给 window.parent（targetOrigin '*'：本页没有来源，
//   App 那边按 event.source 认）。页面自己的 CSP 在 _headers：connect-src 'none'，取不到任何网络资源，只能看 App 交进来的字节
// • open：docx、xlsx、pptx 先按真实解压字节数查 ZIP 炸弹（zipBombCheck，每台设备、每次预览前都查）；再按需加载对应的渲染（各自一个 chunk）
// • prep（预览材料，架构 5.13 第 2 点 ④）：App 加附件时用一个隐藏的沙箱 iframe 调，回页数、纯文本、首页缩略图（PNG，转移所有权）；
//   ZIP 类同样先查炸弹；各格式的 prep 和渲染在同一个模块里（同一个库、同一套读法）；一个沙箱可以连着 prep 多个文件，按顺序一个一个做
// • 第三方库（pdf.js、docx-preview、SheetJS、DOMPurify）只在这个目录里用；这里允许写 DOM（A22 唯一例外）
import { zipBombCheck } from '../../shared/logic/files/file-sniff.ts';
import { inflateRaw } from '../../shared/logic/files/inflate.ts';
import { parseToFrame, type FrameWay, type FromFrame, type ToFrame } from '../../shared/logic/files/preview-protocol.ts';
import type { Prep } from './prep-kit.ts';
import './frame.css';

export interface View {
  page(n: number): void;
  zoom(z: number): void;
  sheet(i: number): void;
}
// 不另写收尾：App 的 SandboxFrame 按阶段换 key，每换一次就是一个新的 iframe，一个沙箱只 open 一次；
// 观察器、pdf.js 文档、blob: 地址随 iframe 一起释放（第二轮复查新发现 1）
export type Post = (m: FromFrame, transfer?: Transferable[]) => void;

const root = document.getElementById('preview');
const post: Post = (m, transfer = []) => window.parent.postMessage(m, '*', transfer);
let view: View | null = null;

interface WayModule {
  render(root: HTMLElement, bytes: ArrayBuffer, post: Post): Promise<View>;
  prep(bytes: ArrayBuffer): Promise<Prep>;
}

/** ZIP 类先按真实解压字节数查炸弹，过了再按需加载对应格式的模块（各自一个 chunk）；炸弹回 null */
async function load(way: FrameWay, bytes: ArrayBuffer): Promise<WayModule | null> {
  if (way !== 'pdf') {
    const bomb = await zipBombCheck(new Uint8Array(bytes), inflateRaw);
    if (!bomb.ok) return null;
  }
  return MODULES[way]();
}
/** 每种一个箭头函数、各自正好一个写死地址的 import（build/check_preload.mjs 按这个形状核对预加载表；写成一串三元会被并成一张表） */
const MODULES: Record<FrameWay, () => Promise<WayModule>> = {
  pdf: () => import('./render-pdf.ts'),
  docx: () => import('./render-docx.ts'),
  xlsx: () => import('./render-xlsx.ts'),
  pptx: () => import('./render-pptx.ts'),
};

async function open(m: Extract<ToFrame, { t: 'open' }>): Promise<void> {
  if (!root) return;
  root.replaceChildren();
  view = null;
  document.documentElement.lang = m.lang === 'ko' ? 'ko' : 'zh-CN';
  try {
    const mod = await load(m.way, m.bytes);
    if (!mod) return post({ t: 'error', why: 'bad_archive' });
    view = await mod.render(root, m.bytes, post);
  } catch {
    root.replaceChildren();
    post({ t: 'error', why: 'render' });
  }
}

async function prep(m: Extract<ToFrame, { t: 'prep' }>): Promise<void> {
  try {
    const mod = await load(m.way, m.bytes);
    if (!mod) return post({ t: 'prep', id: m.id, error: 'bad_archive' });
    const r = await mod.prep(m.bytes);
    post({ t: 'prep', id: m.id, pages: r.pages, text: r.text, thumb: r.thumb }, r.thumb ? [r.thumb] : []);
  } catch {
    post({ t: 'prep', id: m.id, error: 'render' });
  }
}
/** prep 排队一个一个做：同时解几个大文件会把沙箱内存顶满 */
let prepQueue: Promise<void> = Promise.resolve();

window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const m = parseToFrame(e.data);
  if (!m) return;
  if (m.t === 'open') void open(m);
  else if (m.t === 'prep') prepQueue = prepQueue.then(() => prep(m));
  else if (m.t === 'page') view?.page(m.n);
  else if (m.t === 'zoom') view?.zoom(m.z);
  else view?.sheet(m.i);
});

if (root) root.dataset['ready'] = '1';
post({ t: 'ready' });
