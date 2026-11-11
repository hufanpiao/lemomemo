// 插图的拍摄时间（B4 S3；R-108：只留拍摄时间、不留定位）：从 JPEG 的 EXIF 里只读 DateTimeOriginal（0x9003），别的标签一概不读
// • 只认 JPEG（FF D8 开头）的 APP1 “Exif\0\0”段；TIFF 头两种字节序都认；先找 IFD0 里的 ExifIFD 指针（0x8769），再在 Exif IFD 里找 0x9003
// • “YYYY:MM:DD HH:MM:SS”是拍摄地的墙上时间、没有时区：按用户的 current_tz 换算成毫秒（同这一条随手记的“今天 / 昨天”口径）
// • 读不出、格式不对、越界一律返回 null（不报错：拍摄时间只是附带信息）
// • 定位（GPS IFD）不读也不带走：重新编码成 webp 时整个 EXIF 段都丢了（image-encode.ts）
// 纯 TS：不准 import React（A1）
import { msAt, type DateStr } from '../../../../shared/core/date.ts';
import type { Tz } from '../../../../shared/core/tz.ts';

const EXIF_IFD = 0x8769;
const DATE_ORIGINAL = 0x9003;
/** 只看文件开头这么多字节（EXIF 必须在 64 KB 的 APP1 段里） */
export const EXIF_SCAN_BYTES = 128 * 1024;

/** 在一段 TIFF（EXIF 正文）里找某个 IFD 的某个标签，返回值的偏移和个数（相对 TIFF 开头） */
function findTag(v: DataView, tiff: number, ifd: number, tag: number, le: boolean): { type: number; count: number; at: number } | null {
  const base = tiff + ifd;
  if (base + 2 > v.byteLength) return null;
  const n = v.getUint16(base, le);
  for (let i = 0; i < n; i++) {
    const e = base + 2 + i * 12;
    if (e + 12 > v.byteLength) return null;
    if (v.getUint16(e, le) !== tag) continue;
    const type = v.getUint16(e + 2, le);
    const count = v.getUint32(e + 4, le);
    // 值不超过 4 字节就放在条目里，否则条目里是偏移
    const size = type === 2 ? count : 4;
    return { type, count, at: size <= 4 ? e + 8 : tiff + v.getUint32(e + 8, le) };
  }
  return null;
}

/** “2026:10:21 14:05:09” → 毫秒（按 tz）；不合法返回 null */
export function exifDateToMs(s: string, tz: Tz): number | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}` as DateStr;
  // 2 月 30 日这类：Date.UTC 会进位，进位了就不认
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCDate() !== d) return null;
  try {
    return msAt(date, h * 60 + mi, tz) + se * 1000;
  } catch {
    return null;
  }
}

/** JPEG 字节 → 拍摄时间（毫秒）；没有、读不出为 null */
export function jpegTakenAt(buf: ArrayBuffer, tz: Tz): number | null {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
  let p = 2;
  while (p + 4 <= v.byteLength) {
    if (v.getUint8(p) !== 0xff) return null;
    const marker = v.getUint8(p + 1);
    // SOS（图像数据开始）、EOI 之后不会再有 EXIF
    if (marker === 0xda || marker === 0xd9) return null;
    const len = v.getUint16(p + 2);
    if (len < 2) return null;
    if (marker === 0xe1 && p + 10 <= v.byteLength && v.getUint32(p + 4) === 0x45786966 && v.getUint16(p + 8) === 0) {
      return fromTiff(v, p + 10, tz);
    }
    p += 2 + len;
  }
  return null;
}

function fromTiff(v: DataView, tiff: number, tz: Tz): number | null {
  try {
    if (tiff + 8 > v.byteLength) return null;
    const order = v.getUint16(tiff);
    if (order !== 0x4949 && order !== 0x4d4d) return null;
    const le = order === 0x4949;
    if (v.getUint16(tiff + 2, le) !== 42) return null;
    const ifd0 = v.getUint32(tiff + 4, le);
    const ptr = findTag(v, tiff, ifd0, EXIF_IFD, le);
    if (!ptr) return null;
    const exif = v.getUint32(ptr.at, le);
    const d = findTag(v, tiff, exif, DATE_ORIGINAL, le);
    if (!d || d.type !== 2 || d.count < 19 || d.at + 19 > v.byteLength) return null;
    let s = '';
    for (let i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(d.at + i));
    return exifDateToMs(s, tz);
  } catch {
    return null;
  }
}
