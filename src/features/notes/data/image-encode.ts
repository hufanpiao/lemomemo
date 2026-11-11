// 插图重新编码（B4 S3；R-108、R-377；任务单第 67 行）：选的或拍的照片 → 原图 webp + 缩略图 webp，带拍摄时间
// • 解码：createImageBitmap（按 EXIF 方向转正，imageOrientation: 'from-image'）；画到 canvas 再导出 image/webp。
//   重新编码后原文件的 EXIF 整段都没了（定位、机型一概不带走，R-108），只有拍摄时间从 JPEG 原文件里另读（image-exif.ts）
// • 原图：长边不超过 FULL_EDGE（2048px），质量从 0.85 起，超过 FULL_MAX（2 MB，images 桶上限）就逐步降，降到底还超就缩小一档再来
// • 缩略图：长边不超过 THUMB_EDGE（384px），不超过 THUMB_MAX（128 KB），同样逐步降质量
// • HEIC（看 type 或扩展名）解不了：返回 heic_unsupported，界面提示“请先转成 JPG”（R-377，不加解码依赖）；别的解不了返回 decode_failed
// • 浏览器导不出 webp（toBlob 回了别的类型，老 Safari 会回 png）：返回 encode_unsupported
// • 依赖可注入（测试里 jsdom 没有 canvas）
// 纯 TS：不准 import React（A1）
import type { Tz } from '../../../../shared/core/tz.ts';
import { EXIF_SCAN_BYTES, jpegTakenAt } from './image-exif.ts';

export const FULL_EDGE = 2048;
export const FULL_MAX = 2 * 1024 * 1024;
export const THUMB_EDGE = 384;
export const THUMB_MAX = 128 * 1024;
const QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.45] as const;
const WEBP = 'image/webp';

export interface Encoded {
  ok: true;
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
  /** 拍摄时间（毫秒），读不出为 null */
  takenAt: number | null;
}
export type EncodeFail = { ok: false; code: 'heic_unsupported' | 'decode_failed' | 'encode_unsupported' | 'too_big' };
export type EncodeResult = Encoded | EncodeFail;

/** 解出来的图（ImageBitmap 的子集） */
export interface Decoded {
  width: number;
  height: number;
  close(): void;
}

export interface EncodeDeps {
  decode(file: Blob): Promise<Decoded>;
  /** 把 src 画成 w × h，导出成 type、quality；导不出回 null */
  render(src: Decoded, w: number, h: number, type: string, quality: number): Promise<Blob | null>;
}

/** 是不是 HEIC / HEIF（iPhone 默认格式） */
export function isHeic(file: { type: string; name?: string }): boolean {
  return /^image\/hei[cf](-sequence)?$/i.test(file.type) || /\.hei[cf]$/i.test(file.name ?? '');
}

/** 按长边缩到不超过 edge（不放大），取整、至少 1 */
export function fitEdge(w: number, h: number, edge: number): { w: number; h: number } {
  const k = Math.min(1, edge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

const defaultDeps: EncodeDeps = {
  decode: (file) => createImageBitmap(file, { imageOrientation: 'from-image' }),
  async render(src, w, h, type, quality) {
    if (typeof OffscreenCanvas === 'function') {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(src as unknown as CanvasImageSource, 0, 0, w, h);
      return c.convertToBlob({ type, quality }).catch(() => null);
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(src as unknown as CanvasImageSource, 0, 0, w, h);
    return new Promise((res) => c.toBlob((b) => res(b), type, quality));
  },
};

/** 在 edge 以内、按质量表逐步降，找第一份不超过 max 的 webp；长边每次再缩 0.8 倍，最多三档 */
async function shrink(deps: EncodeDeps, src: Decoded, edge: number, max: number): Promise<{ blob: Blob; w: number; h: number } | 'encode_unsupported' | 'too_big'> {
  let e = edge;
  for (let round = 0; round < 3; round++) {
    const { w, h } = fitEdge(src.width, src.height, e);
    for (const q of QUALITIES) {
      const b = await deps.render(src, w, h, WEBP, q);
      if (!b || b.type !== WEBP) return 'encode_unsupported';
      if (b.size <= max) return { blob: b, w, h };
    }
    e = Math.round(Math.max(w, h) * 0.8);
  }
  return 'too_big';
}

async function takenAtOf(file: Blob, tz: Tz): Promise<number | null> {
  if (file.type !== 'image/jpeg') return null;
  try {
    return jpegTakenAt(await file.slice(0, EXIF_SCAN_BYTES).arrayBuffer(), tz);
  } catch {
    return null;
  }
}

/** 选的或拍的一张照片 → 原图 + 缩略图（webp）+ 拍摄时间 */
export async function encodeImage(file: File, tz: Tz, deps: EncodeDeps = defaultDeps): Promise<EncodeResult> {
  let src: Decoded;
  try {
    src = await deps.decode(file);
  } catch {
    return { ok: false, code: isHeic(file) ? 'heic_unsupported' : 'decode_failed' };
  }
  try {
    if (!(src.width > 0 && src.height > 0)) return { ok: false, code: 'decode_failed' };
    const full = await shrink(deps, src, FULL_EDGE, FULL_MAX);
    if (typeof full === 'string') return { ok: false, code: full };
    const thumb = await shrink(deps, src, THUMB_EDGE, THUMB_MAX);
    if (typeof thumb === 'string') return { ok: false, code: thumb };
    return { ok: true, full: full.blob, thumb: thumb.blob, width: full.w, height: full.h, takenAt: await takenAtOf(file, tz) };
  } finally {
    src.close();
  }
}
