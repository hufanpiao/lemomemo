// 头像编码（纪念日头像 B5 S16、我的头像 R-384 共用；架构 5.4 头像一段；R-117、R-377、R-402；TC-B5-24、26、37）：纯 TS
// • 浏览器解码好的图（AvatarPicker 里 createImageBitmap，HEIC 靠浏览器，R-377；按 EXIF 方向转正）→ 正方形选区画到 256 × 256 的画布 → webp 质量 0.8；
//   超过 100 KB 依次降到 0.65、0.5，还超回 null。画布重新编码不带任何 EXIF / XMP（定位、机型都丢掉）
// • iPhone Safari 的画布导不出 webp（交回 png）时改用 App 自带的 wasm 编码器（platform/webp-wasm.ts，按需加载，R-402）
// • 运行日志：编不出、太大记一行 `<tag> avatar-encode <结果码>`（tag 是调用方的功能名 anniv / me），不记图片
// 原来写在 features/anniv/data/avatar.ts，R-384 我的头像也要用，挪到 platform 共用（行为不变）
import { rlog } from './run-log-api.ts';
import { loadWebpWasm } from './webp-wasm.ts';

export const AVATAR_EDGE = 256;
/** 头像上限（字节）：和库里 avatar_bytes 的约束、清单头像段的 maxBytes 一致 */
export const AVATAR_MAX_BYTES = 102_400;
export const QUALITIES: readonly number[] = [0.8, 0.65, 0.5];
export const AVATAR_MIME = 'image/webp';

/** 原图上的正方形选区（原图像素） */
export interface Crop {
  x: number;
  y: number;
  size: number;
}

type Ctx2d = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** 选区画成 256 × 256 的 webp；编不出、超过 100 KB 回 null。tag 只用来记日志 */
export async function encodeAvatar(src: CanvasImageSource, crop: Crop, tag = 'anniv', wasm: typeof loadWebpWasm = loadWebpWasm): Promise<Blob | null> {
  const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(AVATAR_EDGE, AVATAR_EDGE) : Object.assign(document.createElement('canvas'), { width: AVATAR_EDGE, height: AVATAR_EDGE });
  const ctx = c.getContext('2d') as Ctx2d | null;
  if (!ctx) return null;
  try {
    ctx.drawImage(src, crop.x, crop.y, crop.size, crop.size, 0, 0, AVATAR_EDGE, AVATAR_EDGE);
    for (const q of QUALITIES) {
      let b: Blob | null = null;
      try {
        b = 'convertToBlob' in c ? await c.convertToBlob({ type: AVATAR_MIME, quality: q }) : await new Promise<Blob | null>((res) => c.toBlob(res, AVATAR_MIME, q));
      } catch {
        b = null;
      }
      if (b?.type !== AVATAR_MIME) {
        const enc = await wasm();
        b = new Blob([enc(ctx.getImageData(0, 0, AVATAR_EDGE, AVATAR_EDGE), q)], { type: AVATAR_MIME });
      }
      if (b.size <= AVATAR_MAX_BYTES) return b;
    }
    rlog(`${tag} avatar-encode too_large`);
    return null;
  } catch {
    rlog(`${tag} avatar-encode failed`);
    return null;
  } finally {
    c.width = 0;
    c.height = 0;
  }
}
