// 预览沙箱（架构 5.13 第 3 点、架构约定 9.7；Vite 的第三个入口 /app/preview.html，网页版 iframe 的 src 写 /app/preview）。
// • 只收 window.parent 发来、过了 shared/logic/files/preview-protocol.ts 核对的消息；回消息一律发给 window.parent（targetOrigin '*'：本页没有来源，
//   App 那边按 event.source 认）。页面自己的 CSP 在 _headers：connect-src 'none'，取不到任何网络资源，只能看 App 交进来的字节
// • open：docx、xlsx、pptx 先按真实解压字节数查 ZIP 炸弹（zipBombCheck，每台设备、每次预览前都查）；再按需加载对应的渲染（各自一个 chunk）
// • 第三方库（pdf.js、docx-preview、SheetJS、DOMPurify）只在这个目录里用；这里允许写 DOM（A22 唯一例外）
import { zipBombCheck } from '../../shared/logic/files/file-sniff.ts';
import { inflateRaw } from '../../shared/logic/files/inflate.ts';
import { parseToFrame, type FromFrame, type ToFrame } from '../../shared/logic/files/preview-protocol.ts';
import './frame.css';

export interface View {
  page(n: number): void;
  zoom(z: number): void;
  sheet(i: number): void;
}
// 不另写收尾：App 的 SandboxFrame 按阶段换 key，每换一次就是一个新的 iframe，一个沙箱只 open 一次；
// 观察器、pdf.js 文档、blob: 地址随 iframe 一起释放（第二轮复查新发现 1）
export type Post = (m: FromFrame) => void;

const root = document.getElementById('preview');
const post: Post = (m) => window.parent.postMessage(m, '*');
let view: View | null = null;

async function open(m: Extract<ToFrame, { t: 'open' }>): Promise<void> {
  if (!root) return;
  root.replaceChildren();
  view = null;
  document.documentElement.lang = m.lang === 'ko' ? 'ko' : 'zh-CN';
  try {
    if (m.way !== 'pdf') {
      const bomb = await zipBombCheck(new Uint8Array(m.bytes), inflateRaw);
      if (!bomb.ok) return post({ t: 'error', why: 'bad_archive' });
    }
    const mod =
      m.way === 'pdf' ? await import('./render-pdf.ts')
      : m.way === 'docx' ? await import('./render-docx.ts')
      : m.way === 'xlsx' ? await import('./render-xlsx.ts')
      : await import('./render-pptx.ts');
    view = await mod.render(root, m.bytes, post);
  } catch {
    root.replaceChildren();
    post({ t: 'error', why: 'render' });
  }
}

window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const m = parseToFrame(e.data);
  if (!m) return;
  if (m.t === 'open') void open(m);
  else if (m.t === 'page') view?.page(m.n);
  else if (m.t === 'zoom') view?.zoom(m.z);
  else view?.sheet(m.i);
});

if (root) root.dataset['ready'] = '1';
post({ t: 'ready' });
