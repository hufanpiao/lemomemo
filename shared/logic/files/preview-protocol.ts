// 预览沙箱和 App 之间的 postMessage 消息（架构 5.13 第 3 点、架构约定 9.7）：App（features/attachments）和沙箱（src/preview-frame/）共用这一份。
// 沙箱是“没有来源”的页面（iframe sandbox="allow-scripts"，不给 allow-same-origin），App 发消息只能用 targetOrigin '*'，
//   所以两边一律先核对 event.source（App 认 iframe.contentWindow，沙箱认 window.parent），再用这里的 parse 核对形状，不合格的丢掉。
// 文件字节经 open、prep 消息转移所有权（transfer），不复制；prep 回的缩略图同样转移回来。纯 TS，不碰运行环境的 API。
// prep（架构 5.13 第 2 点 ④ 预览材料）：App 加附件时用一个隐藏的沙箱 iframe 调，pdf.js 等库只在沙箱里跑；
//   回页数、纯文本（最多 PREP_TEXT_MAX 字）、首页缩略图（PNG，长边 ≤ PREP_THUMB_MAX；WebKit 的 canvas 导不出 webp，App 再转 webp）

/** 本机预览的四种：pdf、docx、xlsx，以及 pptx 的退路（微软打不开时：首页缩略图 + 每页文字） */
export type FrameWay = 'pdf' | 'docx' | 'xlsx' | 'pptx';

export type ToFrame =
  | { t: 'open'; way: FrameWay; bytes: ArrayBuffer; lang: 'zh' | 'ko' }
  | { t: 'page'; n: number }
  | { t: 'zoom'; z: number }
  | { t: 'sheet'; i: number }
  | { t: 'prep'; id: string; way: FrameWay; bytes: ArrayBuffer };

/** prep 成功：pages 是 PDF 页数、PPT 页数、Excel 工作表数，Word 为 null；thumb 是 PNG（PDF 第一页、PPT 自带的 docProps/thumbnail.jpeg），没有为 null */
export type PrepDone = { t: 'prep'; id: string; pages: number | null; text: string; thumb: ArrayBuffer | null };
/** prep 失败：bad_archive 压缩包异常（ZIP 炸弹等）、render 其他（文件坏了、库报错） */
export type PrepFail = { t: 'prep'; id: string; error: 'bad_archive' | 'render' };

/** 沙箱回的：ready 页面加载好了可以发 open；state 当前页、缩放、工作表；error 渲染不了（bad_archive 压缩包异常、render 其他） */
export type FromFrame =
  | { t: 'ready' }
  | { t: 'state'; page: number; pages: number; zoom: number; sheets: string[]; sheet: number; clipped: boolean }
  | { t: 'error'; why: 'bad_archive' | 'render' }
  | PrepDone
  | PrepFail;

const WAYS = new Set<string>(['pdf', 'docx', 'xlsx', 'pptx']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** 缩放档：50%～300%（PDF 用；docx、xlsx 按 CSS zoom） */
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 300;

/** 预览材料：纯文本最多 20000 字（按 UTF-16 计，不切断代理对）、缩略图长边最多 384 px（架构 5.13 第 2 点 ④） */
export const PREP_TEXT_MAX = 20_000;
export const PREP_THUMB_MAX = 384;
/** 缩略图字节上限：384 × 384 的 PNG 远小于这个数，超了按坏消息丢掉 */
export const PREP_THUMB_BYTES = 2 * 1024 * 1024;
/** 请求号：App 生成，原样带回 */
const PREP_ID = /^[\w-]{1,64}$/;

/** 截到 PREP_TEXT_MAX 字；末尾正好是代理对的前一半就一起去掉 */
export function clipPrepText(s: string): string {
  if (s.length <= PREP_TEXT_MAX) return s;
  const cut = s.slice(0, PREP_TEXT_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function parseToFrame(v: unknown): ToFrame | null {
  if (!isObj(v)) return null;
  switch (v['t']) {
    case 'open':
      return typeof v['way'] === 'string' && WAYS.has(v['way']) && v['bytes'] instanceof ArrayBuffer && (v['lang'] === 'zh' || v['lang'] === 'ko')
        ? { t: 'open', way: v['way'] as FrameWay, bytes: v['bytes'], lang: v['lang'] }
        : null;
    case 'page':
      return isInt(v['n'], 1, 100_000) ? { t: 'page', n: v['n'] } : null;
    case 'zoom':
      return isInt(v['z'], ZOOM_MIN, ZOOM_MAX) ? { t: 'zoom', z: v['z'] } : null;
    case 'sheet':
      return isInt(v['i'], 0, 10_000) ? { t: 'sheet', i: v['i'] } : null;
    case 'prep':
      return typeof v['id'] === 'string' && PREP_ID.test(v['id']) && typeof v['way'] === 'string' && WAYS.has(v['way']) && v['bytes'] instanceof ArrayBuffer
        ? { t: 'prep', id: v['id'], way: v['way'] as FrameWay, bytes: v['bytes'] }
        : null;
    default:
      return null;
  }
}

export function parseFromFrame(v: unknown): FromFrame | null {
  if (!isObj(v)) return null;
  if (v['t'] === 'ready') return { t: 'ready' };
  if (v['t'] === 'error') return v['why'] === 'bad_archive' || v['why'] === 'render' ? { t: 'error', why: v['why'] } : null;
  if (v['t'] === 'prep') return parsePrep(v);
  if (v['t'] !== 'state') return null;
  const sheets = v['sheets'];
  if (!Array.isArray(sheets) || sheets.length > 10_000 || !sheets.every((s) => typeof s === 'string' && s.length <= 64)) return null;
  if (!isInt(v['page'], 0, 100_000) || !isInt(v['pages'], 0, 100_000) || !isInt(v['zoom'], ZOOM_MIN, ZOOM_MAX) || !isInt(v['sheet'], 0, 10_000) || typeof v['clipped'] !== 'boolean') return null;
  return { t: 'state', page: v['page'], pages: v['pages'], zoom: v['zoom'], sheets: sheets as string[], sheet: v['sheet'], clipped: v['clipped'] };
}

function parsePrep(v: Record<string, unknown>): PrepDone | PrepFail | null {
  const id = v['id'];
  if (typeof id !== 'string' || !PREP_ID.test(id)) return null;
  if ('error' in v) return v['error'] === 'bad_archive' || v['error'] === 'render' ? { t: 'prep', id, error: v['error'] } : null;
  const { pages, text, thumb } = v;
  if (pages !== null && !isInt(pages, 0, 100_000)) return null;
  if (typeof text !== 'string' || text.length > PREP_TEXT_MAX) return null;
  if (thumb !== null && !(thumb instanceof ArrayBuffer && thumb.byteLength > 0 && thumb.byteLength <= PREP_THUMB_BYTES)) return null;
  return { t: 'prep', id, pages, text, thumb };
}
