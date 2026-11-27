// 吉祥物画布摆在角色框（.rv）里的位置和大小：舞台（mascot-stage.ts）摆画布和静态图、构建时出静态图（build/gen_mascot_stills.mjs）用同一份算法，
// 两边像素对得上。纯函数，不碰 DOM
import type { MascotDef } from '../../shared/schema/mascot.ts';

export interface StageBox {
  /** 画布（和静态图）在角色框里的 CSS 位置和大小 */
  left: number;
  top: number;
  w: number;
  h: number;
  /** 画的像素比：设备像素比，最大 3，画布最长边不超过 4096 像素 */
  dpr: number;
  /** 画布像素大小 */
  pw: number;
  ph: number;
}

/** 角色真画出来了（有的素材开头几帧是透明的）：RGBA 像素每 16 个抽一个，不透明的够 20 个（小画布按抽样数的 5%：
 *  网页版 AI 栏的光球 1 倍屏只有 33×33，固定 20 个永远凑不够） */
export function hasInk(d: ArrayLike<number>): boolean {
  const need = Math.min(20, Math.ceil(d.length / (4 * 16) / 20));
  let n = 0;
  for (let i = 3; i < d.length; i += 4 * 16) if ((d[i] ?? 0) > 230 && ++n >= need) return true;
  return false;
}

/** 角色框 W×H（CSS px）里放这一只：按 crop 缩放到框里，横向居中、底边贴框底；框是 0 时 null */
export function stageBox(o: Pick<MascotDef, 'size' | 'crop' | 'pad'>, W: number, H: number, deviceDpr: number): StageBox | null {
  if (W === 0 || H === 0) return null;
  const [cx, cy, cw, ch] = o.crop;
  const [px, py] = o.pad ?? [0, 0];
  const s = Math.min(W / cw, H / ch);
  const w = o.size[0] * s;
  const h = o.size[1] * s;
  const dpr = Math.max(1, Math.min(3, deviceDpr || 1, 4096 / Math.max(w, h)));
  return {
    left: -((cx + px) * s) + (W - cw * s) / 2,
    top: -((cy + py) * s) + (H - ch * s),
    w,
    h,
    dpr,
    pw: Math.max(1, Math.round(w * dpr)),
    ph: Math.max(1, Math.round(h * dpr)),
  };
}
