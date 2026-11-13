// 预览沙箱和 App 之间的 postMessage 消息（架构 5.13 第 3 点、架构约定 9.7）：App（features/attachments）和沙箱（src/preview-frame/）共用这一份。
// 沙箱是“没有来源”的页面（iframe sandbox="allow-scripts"，不给 allow-same-origin），App 发消息只能用 targetOrigin '*'，
//   所以两边一律先核对 event.source（App 认 iframe.contentWindow，沙箱认 window.parent），再用这里的 parse 核对形状，不合格的丢掉。
// 文件字节经 open 消息转移所有权（transfer），不复制。纯 TS，不碰运行环境的 API。

/** 本机预览的四种：pdf、docx、xlsx，以及 pptx 的退路（微软打不开时：首页缩略图 + 每页文字） */
export type FrameWay = 'pdf' | 'docx' | 'xlsx' | 'pptx';

export type ToFrame =
  | { t: 'open'; way: FrameWay; bytes: ArrayBuffer; lang: 'zh' | 'ko' }
  | { t: 'page'; n: number }
  | { t: 'zoom'; z: number }
  | { t: 'sheet'; i: number };

/** 沙箱回的：ready 页面加载好了可以发 open；state 当前页、缩放、工作表；error 渲染不了（bad_archive 压缩包异常、render 其他） */
export type FromFrame =
  | { t: 'ready' }
  | { t: 'state'; page: number; pages: number; zoom: number; sheets: string[]; sheet: number; clipped: boolean }
  | { t: 'error'; why: 'bad_archive' | 'render' };

const WAYS = new Set<string>(['pdf', 'docx', 'xlsx', 'pptx']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** 缩放档：50%～300%（PDF 用；docx、xlsx 按 CSS zoom） */
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 300;

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
    default:
      return null;
  }
}

export function parseFromFrame(v: unknown): FromFrame | null {
  if (!isObj(v)) return null;
  if (v['t'] === 'ready') return { t: 'ready' };
  if (v['t'] === 'error') return v['why'] === 'bad_archive' || v['why'] === 'render' ? { t: 'error', why: v['why'] } : null;
  if (v['t'] !== 'state') return null;
  const sheets = v['sheets'];
  if (!Array.isArray(sheets) || sheets.length > 10_000 || !sheets.every((s) => typeof s === 'string' && s.length <= 64)) return null;
  if (!isInt(v['page'], 0, 100_000) || !isInt(v['pages'], 0, 100_000) || !isInt(v['zoom'], ZOOM_MIN, ZOOM_MAX) || !isInt(v['sheet'], 0, 10_000) || typeof v['clipped'] !== 'boolean') return null;
  return { t: 'state', page: v['page'], pages: v['pages'], zoom: v['zoom'], sheets: sheets as string[], sheet: v['sheet'], clipped: v['clipped'] };
}
