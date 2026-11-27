// 测试用：造一段 JPEG 的 APP1 EXIF（拍摄时间 DateTimeOriginal + 可选的 GPS 定位），再拼进一张 JPEG（插图 TC-B4-02、image-exif 单测共用）
// 不依赖 DOM，Node 和浏览器都能跑（e2e 在 Node 侧造好字节交给页面；b4-image-encode.spec.ts 把它一起打进页面里用）。
// 另有 webp 的文件头、RIFF 块检查（image-encode-wasm.test.ts、r402-webp-wasm.spec.ts、b4-image-encode.spec.ts 共用，R-402 评审 14）

export const GPS_MARK = 'N\0';

/** APP1 段（FF E1 + 长度 + "Exif\0\0" + TIFF）；le = 小端（Intel，II），否则大端（Motorola，MM） */
export function exifApp1(o: { date: string; gps?: boolean; le?: boolean }): Uint8Array {
  const le = o.le ?? true;
  const ifd0Count = o.gps ? 2 : 1;
  const ifd0 = 8;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifIfd = ifd0 + ifd0Size;
  const exifSize = 2 + 12 + 4;
  const dateAt = exifIfd + exifSize;
  const dateLen = 20;
  const gpsIfd = dateAt + dateLen;
  const gpsSize = 2 + 2 * 12 + 4;
  const latAt = gpsIfd + gpsSize;
  const total = o.gps ? latAt + 24 : gpsIfd;
  const tiff = new DataView(new ArrayBuffer(total));
  tiff.setUint16(0, le ? 0x4949 : 0x4d4d);
  tiff.setUint16(2, 42, le);
  tiff.setUint32(4, ifd0, le);
  const entry = (at: number, tag: number, type: number, count: number, value: number): void => {
    tiff.setUint16(at, tag, le);
    tiff.setUint16(at + 2, type, le);
    tiff.setUint32(at + 4, count, le);
    tiff.setUint32(at + 8, value, le);
  };
  tiff.setUint16(ifd0, ifd0Count, le);
  entry(ifd0 + 2, 0x8769, 4, 1, exifIfd);
  if (o.gps) entry(ifd0 + 14, 0x8825, 4, 1, gpsIfd);
  tiff.setUint32(ifd0 + 2 + ifd0Count * 12, 0, le);
  tiff.setUint16(exifIfd, 1, le);
  entry(exifIfd + 2, 0x9003, 2, dateLen, dateAt);
  tiff.setUint32(exifIfd + 14, 0, le);
  for (let i = 0; i < 19; i++) tiff.setUint8(dateAt + i, o.date.charCodeAt(i) || 0);
  if (o.gps) {
    tiff.setUint16(gpsIfd, 2, le);
    // GPSLatitudeRef 'N'（两字节，放在条目里）
    tiff.setUint16(gpsIfd + 2, 1, le);
    tiff.setUint16(gpsIfd + 4, 2, le);
    tiff.setUint32(gpsIfd + 6, 2, le);
    tiff.setUint8(gpsIfd + 10, GPS_MARK.charCodeAt(0));
    // GPSLatitude 37°33'59"（首尔），三个 RATIONAL
    entry(gpsIfd + 14, 0x0002, 5, 3, latAt);
    tiff.setUint32(gpsIfd + 26, 0, le);
    [37, 1, 33, 1, 59, 1].forEach((v, i) => tiff.setUint32(latAt + i * 4, v, le));
  }
  const body = new Uint8Array(tiff.buffer);
  const seg = new Uint8Array(4 + 6 + body.length);
  seg.set([0xff, 0xe1, ((seg.length - 2) >> 8) & 0xff, (seg.length - 2) & 0xff]);
  seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  seg.set(body, 10);
  return seg;
}

/** 把 APP1 插在 JPEG 的 SOI（FF D8）后面 */
export function withExif(jpeg: Uint8Array, app1: Uint8Array): Uint8Array {
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, 2));
  out.set(app1, 2);
  out.set(jpeg.subarray(2), 2 + app1.length);
  return out;
}

/** 最小的“JPEG”外壳：SOI + 一个 APP0 + EOI（只给 EXIF 解析用，不是能解码的图） */
export function bareJpeg(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);
}

/** 文件头是不是 RIFF....WEBP */
export function isWebpFile(b: Uint8Array): boolean {
  return String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP';
}

/** webp 里的 RIFF 块名（VP8 、VP8L、VP8X、ALPH、EXIF、XMP …）：从第 12 字节起，每块 4 字节名 + 4 字节小端长度 + 内容（奇数补 1） */
export function riffChunks(b: Uint8Array): string[] {
  const out: string[] = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 12; i + 8 <= b.length; ) {
    const size = dv.getUint32(i + 4, true);
    out.push(String.fromCharCode(...b.subarray(i, i + 4)));
    i += 8 + size + (size % 2);
  }
  return out;
}

/** 重新编码后的 webp 只许有这些块（没有 EXIF、XMP：定位、机型带不过去，R-108） */
export const WEBP_IMAGE_CHUNKS: readonly string[] = ['VP8X', 'ICCP', 'VP8 ', 'VP8L', 'ALPH'];

/** 字节里有没有某段 ASCII（查产物里还有没有 "Exif"、GPS 标记） */
export function hasAscii(bytes: Uint8Array, s: string): boolean {
  const n = [...s].map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i + n.length <= bytes.length; i++) {
    for (let j = 0; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}
