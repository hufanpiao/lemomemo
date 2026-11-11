// 视口几何（这类事只在这里算）：可视高度、键盘高度、键盘弹着没有、整屏高、布局视口少的那截，以及这些判断的门槛常量。
// 纯函数，不读 DOM、不记状态；监听和写根节点在 viewport.ts（用这里的结果）；冷启动高度校正 vh-gapfix-gate.ts 在首屏，只直接引 viewport-screen.ts。
// 横竖屏、整屏高和 TOL_PX、GAP_MAX_PX 写在 viewport-screen.ts、这里照样转出：冷启动高度校正在首屏只要这几样，本文件不在首屏块里，跟着 viewport.ts 的分包按需下载（11-12 首屏瘦身）。
// 不变量：iOS 主屏幕版 iPhone 弹键盘时布局视口本身被压矮（可视区算法量出 0），只有这时按“在输入 + 比整屏矮出一个键盘”判；
// iPad 不算（台前调度、分屏、接实体键盘时窗口本来就比整屏矮得多）

import { GAP_MAX_PX, TOL_PX } from './viewport-screen.ts';

export { fullHeight, GAP_MAX_PX, isLandscape, TOL_PX } from './viewport-screen.ts';

/** 高度差比这少不算键盘（地址栏伸缩只有几十 px） */
export const KB_MIN_PX = 120;
/** 可视区缩放和 1 差这么多以内算没缩放 */
const SCALE_EPS = 0.01;

/** 键盘压在布局视口上的高度（px）：布局视口高 − 可视区高 − 可视区顶端偏移，不到 KB_MIN_PX 当 0 */
export function keyboardHeight(innerHeight: number, vvHeight: number, vvOffsetTop: number): number {
  const h = Math.round(innerHeight - vvHeight - vvOffsetTop);
  return h >= KB_MIN_PX ? h : 0;
}

export interface GeomIn {
  /** innerHeight（布局视口高） */
  readonly inner: number;
  /** visualViewport；没有是 null */
  readonly vv: { readonly height: number; readonly offsetTop: number; readonly scale?: number } | null;
  /** 整屏高（fullHeight，按横竖取 screen 的长边或短边） */
  readonly full: number;
  readonly standalone: boolean;
  /** 是不是 iPhone */
  readonly phone: boolean;
  /** 有能弹键盘的东西聚焦着 */
  readonly editing: boolean;
}

export interface Geom {
  /** 可视高度（可视区高；没有 visualViewport 时是布局视口高） */
  readonly visible: number;
  /** 键盘高度（0 = 量不出）：压在布局视口上的那段，或主屏幕版 iPhone 布局视口自己被压矮的那段 */
  readonly kb: number;
  /** 键盘压在布局视口上的那段（--kb）；布局视口自己被压矮时是 0：它的下沿就是键盘上沿 */
  readonly over: number;
  /** 键盘弹着（data-kbo）：量出了键盘，或主屏幕版 iPhone 在输入、可视区比整屏矮出一个键盘（可视区被滚下去时 kb 量出 0） */
  readonly open: boolean;
  /** 布局视口比整屏少多少 */
  readonly short: number;
  /** 贴底元素要往下补的那截（--vh-gap）：主屏幕版 iPhone、键盘没弹、没在输入、少 TOL_PX～GAP_MAX_PX；否则 0 */
  readonly gap: number;
  /** 主屏幕版 iPhone、没缩放：键盘会压矮布局视口，收起后布局视口要过一会儿才回到整屏 */
  readonly squeeze: boolean;
}

export function viewportGeom(g: GeomIn): Geom {
  const { vv } = g;
  const visible = vv ? vv.height : g.inner;
  const zoomed = vv !== null && typeof vv.scale === 'number' && Math.abs(vv.scale - 1) > SCALE_EPS;
  const squeeze = g.standalone && g.phone && !zoomed;
  const short = Math.round(g.full - g.inner);
  const over = vv && !zoomed ? keyboardHeight(g.inner, vv.height, vv.offsetTop) : 0;
  const kb = over > 0 ? over : squeeze && g.editing && short >= KB_MIN_PX ? short : 0;
  const open = kb > 0 || (squeeze && g.editing && g.full - visible >= KB_MIN_PX);
  const gap = kb === 0 && squeeze && !g.editing && short > TOL_PX && short <= GAP_MAX_PX ? short : 0;
  return { visible, kb, over, open, short, gap, squeeze };
}
