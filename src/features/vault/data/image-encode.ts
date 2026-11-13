// 隐私记插图的重新编码（B5 S8）：照片 → 原图 webp（≤ 2 MB，VAULT_IMAGE_MAX_BYTES）+ 缩略图 webp
// • 和随手记的 features/notes/data/image-encode.ts 同一套思路的精简版（功能之间不能互相 import data，A1）：
//   createImageBitmap 按 EXIF 方向转正 → 画布 → 原生导出 webp；交回来的不是 webp（iPhone Safari）就改用 App 自带的 wasm 编码器
//   （platform/webp-wasm.ts）从像素编。重新编码后原文件的 EXIF 全部丢掉；隐私记不读、不存拍摄时间和定位（S8）
// • 以后随手记的编码器挪到 platform 时，这份删掉改用那一份（交回里记了这处重复）
// 纯 TS：不准 import React（A1）
import { VAULT_IMAGE_MAX_BYTES } from '../../../../shared/schema/vault.ts';
import { loadWebpWasm } from '../../../platform/webp-wasm.ts';

export const VAULT_FULL_EDGE = 2048;
export const VAULT_THUMB_EDGE = 384;
const WEBP = 'image/webp';
const QUALITIES = [0.85, 0.75, 0.6, 0.45] as const;

export type VaultEncoded = { ok: true; full: Blob; thumb: Blob; width: number; height: number } | { ok: false; code: 'decode_failed' | 'encode_failed' | 'too_big' };

function fit(w: number, h: number, edge: number): { w: number; h: number } {
  const k = Math.min(1, edge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

async function encodeAt(src: ImageBitmap, edge: number, max: number): Promise<{ blob: Blob; w: number; h: number } | null> {
  let { w, h } = fit(src.width, src.height, edge);
  for (let round = 0; round < 3; round++) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) return null;
    g.drawImage(src, 0, 0, w, h);
    for (const q of QUALITIES) {
      let b = await new Promise<Blob | null>((res) => c.toBlob(res, WEBP, q));
      if (!b || b.type !== WEBP) {
        const enc = await loadWebpWasm();
        const px = g.getImageData(0, 0, w, h);
        b = new Blob([enc({ data: px.data, width: w, height: h }, q)], { type: WEBP });
      }
      if (b.size <= max) {
        c.width = 0;
        c.height = 0;
        return { blob: b, w, h };
      }
    }
    c.width = 0;
    c.height = 0;
    w = Math.max(1, Math.round(w * 0.75));
    h = Math.max(1, Math.round(h * 0.75));
  }
  return null;
}

export async function encodeVaultImage(file: Blob): Promise<VaultEncoded> {
  let src: ImageBitmap;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return { ok: false, code: 'decode_failed' };
  }
  try {
    const full = await encodeAt(src, VAULT_FULL_EDGE, VAULT_IMAGE_MAX_BYTES);
    if (!full) return { ok: false, code: 'too_big' };
    const thumb = await encodeAt(src, VAULT_THUMB_EDGE, 128 * 1024);
    if (!thumb) return { ok: false, code: 'too_big' };
    return { ok: true, full: full.blob, thumb: thumb.blob, width: full.w, height: full.h };
  } catch {
    return { ok: false, code: 'encode_failed' };
  } finally {
    src.close();
  }
}
