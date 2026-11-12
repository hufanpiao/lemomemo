// 插图重新编码（B4 S3；R-108、R-377；任务单第 67 行）：选的或拍的照片 → 原图 webp + 缩略图 webp，带拍摄时间
// • 解码：createImageBitmap（按 EXIF 方向转正，imageOrientation: 'from-image'）；画到 canvas 再导出 image/webp。
//   重新编码后原文件的 EXIF 整段都没了（定位、机型一概不带走，R-108），只有拍摄时间从 JPEG 原文件里另读（image-exif.ts）
// • 原图：长边不超过 FULL_EDGE（2048px），质量从 0.85 起，超过 FULL_MAX（2 MB，images 桶上限）就逐步降，降到底还超就缩小一档再来
// • 缩略图：长边不超过 THUMB_EDGE（384px），不超过 THUMB_MAX（128 KB），同样逐步降质量
// • HEIC（看 type 或扩展名）解不了：返回 heic_unsupported，界面提示“请先转成 JPG”（R-377，不加解码依赖）；别的解不了返回 decode_failed
// • 两条路（R-402）：先用浏览器原生导出 webp；交回来的不是 webp（iPhone Safari 现在也这样：要 image/webp 回 png），
//   这张图后面就都改走 App 自带的 wasm 编码器（platform/webp-wasm.ts），把同一张 canvas 的像素（getImageData）编成 webp。
//   质量表、长边、FULL_MAX / THUMB_MAX 的逐档降两条路共用（shrink 只要一份 webp，不管谁编的）；
//   wasm 只从像素编，原文件的 EXIF 一个字节都带不过去（R-108 照旧）
// • wasm 载不进来（离线又没缓存、浏览器不让编译）或取不到像素：返回 encode_unsupported
// • 运行日志一行：notes img enc path=native|wasm ms=…（失败另带 fail=失败码）
// • 依赖可注入（测试里 jsdom 没有 canvas）
// 纯 TS：不准 import React（A1）
import type { Tz } from '../../../../shared/core/tz.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { encodeWebpWasm, type RawPixels } from '../../../platform/webp-wasm.ts';
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
  /** wasm 那条路（R-402）：把 src 画成 w × h 取像素，取不到回 null。它和 wasmWebp 没给全时，原生导不出就是 encode_unsupported */
  pixels?(src: Decoded, w: number, h: number): Promise<RawPixels | null>;
  /** wasm 编码（quality 0～1），载不进来就抛 */
  wasmWebp?(img: RawPixels, quality: number): Promise<Uint8Array<ArrayBuffer>>;
  log?(line: string): void;
  now?(): number;
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

type Ctx2d = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** 把 src 画到 w × h 的 canvas 上（有 OffscreenCanvas 用它，没有用 DOM 的）；拿不到 2d 上下文回 null */
function draw(src: Decoded, w: number, h: number): { c: OffscreenCanvas | HTMLCanvasElement; ctx: Ctx2d } | null {
  const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d') as Ctx2d | null;
  if (!ctx) return null;
  ctx.drawImage(src as unknown as CanvasImageSource, 0, 0, w, h);
  return { c, ctx };
}

const defaultDeps: EncodeDeps = {
  decode: (file) => createImageBitmap(file, { imageOrientation: 'from-image' }),
  async render(src, w, h, type, quality) {
    const d = draw(src, w, h);
    if (!d) return null;
    const { c } = d;
    if ('convertToBlob' in c) return c.convertToBlob({ type, quality }).catch(() => null);
    return new Promise((res) => c.toBlob((b) => res(b), type, quality));
  },
  async pixels(src, w, h) {
    return draw(src, w, h)?.ctx.getImageData(0, 0, w, h) ?? null;
  },
  wasmWebp: encodeWebpWasm,
  log: rlog,
  now: () => performance.now(),
};

/**
 * 一张图的 webp 编码器：先走原生；原生交回的不是 webp，这张图后面都走 wasm（R-402），不再每档都先试一遍原生。
 * wasm 那条路同一个尺寸只取一次像素（降质量重编、不重画）。编不出（载不进来、取不到像素、编码出错）回 null
 */
function webpEncoder(deps: EncodeDeps, src: Decoded) {
  let path: 'native' | 'wasm' = 'native';
  let px: RawPixels | null = null;
  return {
    path: () => path,
    async render(w: number, h: number, q: number): Promise<Blob | null> {
      if (path === 'native') {
        const b = await deps.render(src, w, h, WEBP, q);
        if (b?.type === WEBP) return b;
        path = 'wasm';
      }
      if (!deps.pixels || !deps.wasmWebp) return null;
      try {
        if (px?.width !== w || px.height !== h) px = await deps.pixels(src, w, h);
        return px ? new Blob([await deps.wasmWebp(px, q)], { type: WEBP }) : null;
      } catch {
        return null;
      }
    },
  };
}
type WebpEncoder = ReturnType<typeof webpEncoder>;

/** 在 edge 以内、按质量表逐步降，找第一份不超过 max 的 webp；长边每次再缩 0.8 倍，最多三档 */
async function shrink(enc: WebpEncoder, src: Decoded, edge: number, max: number): Promise<{ blob: Blob; w: number; h: number } | 'encode_unsupported' | 'too_big'> {
  let e = edge;
  for (let round = 0; round < 3; round++) {
    const { w, h } = fitEdge(src.width, src.height, e);
    for (const q of QUALITIES) {
      const b = await enc.render(w, h, q);
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
  const enc = webpEncoder(deps, src);
  const t0 = deps.now?.() ?? 0;
  let fail = '';
  try {
    if (!(src.width > 0 && src.height > 0)) return { ok: false, code: (fail = 'decode_failed') };
    const full = await shrink(enc, src, FULL_EDGE, FULL_MAX);
    if (typeof full === 'string') return { ok: false, code: (fail = full) };
    const thumb = await shrink(enc, src, THUMB_EDGE, THUMB_MAX);
    if (typeof thumb === 'string') return { ok: false, code: (fail = thumb) };
    return { ok: true, full: full.blob, thumb: thumb.blob, width: full.w, height: full.h, takenAt: await takenAtOf(file, tz) };
  } finally {
    src.close();
    deps.log?.(`notes img enc path=${enc.path()} ms=${Math.round((deps.now?.() ?? 0) - t0)}${fail ? ` fail=${fail}` : ''}`);
  }
}
