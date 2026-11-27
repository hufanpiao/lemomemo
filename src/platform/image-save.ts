// 看图页“存到相册”：普通随手记、隐私记共用这一份
// • 字节：看图页的大图本来就是 blob: 地址（普通随手记 features/notes/data/image-view.ts 取的、隐私记解密后的），经 blob-url.ts 拿回造地址时的原 Blob，
//   不联网、不重新编码（CSP connect-src 不放行 blob:，不能 fetch 自己的地址）
// • 类型：只看字节头（JPEG、PNG、WebP、GIF、HEIC / HEIF），认不出的按 webp（插图上传时一律重编码成 webp，features/notes/data/note-images.ts）
// • 文件名：拍摄时间（note_images.taken_at，只有普通随手记的 JPEG 原图读得到）优先，没有就用图 id（uuidv7）里的插入时间；
//   按调用方给的时区（用户的 currentTz）的墙上时间写成 IMG_20261122_153012.webp
// • 存：手机交给系统分享面板（platform/save-file.ts 的 shareFile，面板里有“存储图像”）；分享不了的（电脑、浏览器不支持分享文件）退回下载
// • 不记运行日志：调用方（notes/hooks/useImageSave.ts）只记“img save 结果”，文件名、内容一概不进日志（隐私记的图是解密后的明文）
// • 放在 platform：和 save-file.ts、blob-url.ts 挨着；不碰 React
import { wallTime, type Tz } from '../../shared/core/tz.ts';
import { blobOfUrl } from './blob-url.ts';
import { browserSaveEnv, shareFile, type SaveEnv, type SaveOutcome } from './save-file.ts';

export interface ImageType {
  mime: string;
  ext: string;
}

export const WEBP: ImageType = { mime: 'image/webp', ext: 'webp' };

/** 下载用的 blob: 地址多久回收（隐私记的明文也走这里，短一些） */
const REVOKE_MS = 10_000;

const at = (b: Uint8Array, off: number, sig: readonly number[]): boolean => sig.every((x, i) => b[off + i] === x);
const ascii = (b: Uint8Array, off: number, n: number): string => String.fromCharCode(...b.subarray(off, off + n));

/** 看字节头认图片类型；认不出回 webp */
export function sniffImage(head: Uint8Array): ImageType {
  if (at(head, 0, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg' };
  if (at(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', ext: 'png' };
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return WEBP;
  if (ascii(head, 0, 4) === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
  if (ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4);
    if (['heic', 'heix', 'heim', 'heis'].includes(brand)) return { mime: 'image/heic', ext: 'heic' };
    if (['mif1', 'msf1'].includes(brand)) return { mime: 'image/heif', ext: 'heif' };
  }
  return WEBP;
}

/** uuidv7 前 48 位是毫秒时间；不是 v7 回 null */
export function idTime(id: string): number | null {
  const h = id.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(h) || h[12] !== '7') return null;
  return parseInt(h.slice(0, 12), 16);
}

const p2 = (n: number): string => String(n).padStart(2, '0');

/** IMG_年月日_时分秒.后缀（墙上时间按 tz）；时间不明时只写 IMG */
export function imageFileName(ms: number | null, ext: string, tz: Tz): string {
  if (ms === null || !Number.isFinite(ms)) return `IMG.${ext}`;
  try {
    const w = wallTime(ms, tz);
    return `IMG_${w.y}${p2(w.m)}${p2(w.d)}_${p2(w.hh)}${p2(w.mm)}${p2(w.ss)}.${ext}`;
  } catch {
    return `IMG.${ext}`;
  }
}

export interface PreparedImage {
  blob: Blob;
  name: string;
  type: string;
}

/** 从看图页已有的 blob: 地址备好要存的文件；地址已撤、不是 blob-url.ts 造的，回 null */
export async function prepareImage(
  url: string,
  img: { id: string; takenAt?: number | null },
  tz: Tz,
  get: (u: string) => Blob | null = blobOfUrl,
): Promise<PreparedImage | null> {
  const raw = get(url);
  if (!raw) return null;
  try {
    const t = sniffImage(new Uint8Array(await raw.slice(0, 16).arrayBuffer()));
    return { blob: raw.type === t.mime ? raw : new Blob([raw], { type: t.mime }), name: imageFileName(img.takenAt ?? idTime(img.id), t.ext, tz), type: t.mime };
  } catch {
    return null;
  }
}

/**
 * 存一张图。phone：交给系统分享面板（用户在面板里点“存储图像”）；分享不了就下载。电脑直接下载。
 * 下载本身抛错时往外抛（调用方记 fail）
 */
export async function saveImage(p: PreparedImage, phone: boolean, env: SaveEnv = browserSaveEnv()): Promise<SaveOutcome> {
  if (phone) {
    const r = await shareFile(p.blob, p.name, p.type, env);
    if (r !== 'unsupported') return r;
  }
  env.download(p.blob, p.name, REVOKE_MS);
  return 'downloaded';
}
