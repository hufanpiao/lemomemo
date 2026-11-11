// file-sniff 测试用的样本：按 ZIP（APPNOTE 6.3）和复合文档（MS-CFB）的格式用字节拼出最小文件，不放真实文档
// 返回各记录的偏移，畸形用例在拼好的字节上改字段

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const put16 = (b: Uint8Array, at: number, x: number): void => new DataView(b.buffer, b.byteOffset).setUint16(at, x, true);
export const put32 = (b: Uint8Array, at: number, x: number): void => new DataView(b.buffer, b.byteOffset).setUint32(at, x, true);
export const get16 = (b: Uint8Array, at: number): number => new DataView(b.buffer, b.byteOffset).getUint16(at, true);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = (CRC_TABLE[(c ^ x) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ───────── ZIP ─────────

export interface ZipEntry {
  name: string;
  /** 存进去的字节（method 8 时就是“压缩后”的那一段，由假解压函数认） */
  body: Uint8Array;
  method?: number;
  /** 目录里声明的解压后大小，默认 body 长度 */
  size?: number;
  flags?: number;
  /** 本地头里大小记 0、数据后跟数据描述符（通用标志位 3） */
  descriptor?: boolean;
  /** 只写本地条目，不进中央目录 */
  hidden?: boolean;
}
export interface Zip {
  bytes: Uint8Array;
  /** 每个条目本地头、中央目录头的偏移（hidden 的没有目录头，记 -1） */
  local: number[];
  central: number[];
  cd: number;
  eocd: number;
}

export function buildZip(entries: ZipEntry[], opt: { comment?: Uint8Array; tail?: Uint8Array } = {}): Zip {
  const parts: Uint8Array[] = [];
  const local: number[] = [];
  let at = 0;
  const push = (b: Uint8Array): void => {
    parts.push(b);
    at += b.length;
  };
  for (const e of entries) {
    const name = enc(e.name);
    const flags = (e.flags ?? 0) | (e.descriptor ? 8 : 0);
    const h = new Uint8Array(30);
    put32(h, 0, 0x04034b50);
    put16(h, 4, 20);
    put16(h, 6, flags);
    put16(h, 8, e.method ?? 0);
    if (!e.descriptor) {
      put32(h, 14, crc32(e.body));
      put32(h, 18, e.body.length);
      put32(h, 22, e.size ?? e.body.length);
    }
    put16(h, 26, name.length);
    local.push(at);
    push(concat(h, name, e.body));
    if (e.descriptor) {
      const d = new Uint8Array(16);
      put32(d, 0, 0x08074b50);
      put32(d, 4, crc32(e.body));
      put32(d, 8, e.body.length);
      put32(d, 12, e.size ?? e.body.length);
      push(d);
    }
  }
  const cd = at;
  const central: number[] = [];
  entries.forEach((e, i) => {
    if (e.hidden) {
      central.push(-1);
      return;
    }
    const name = enc(e.name);
    const h = new Uint8Array(46);
    put32(h, 0, 0x02014b50);
    put16(h, 4, 20);
    put16(h, 6, 20);
    put16(h, 8, (e.flags ?? 0) | (e.descriptor ? 8 : 0));
    put16(h, 10, e.method ?? 0);
    put32(h, 16, crc32(e.body));
    put32(h, 20, e.body.length);
    put32(h, 24, e.size ?? e.body.length);
    put16(h, 28, name.length);
    put32(h, 42, local.at(i) ?? 0);
    central.push(at);
    push(concat(h, name));
  });
  const count = central.filter((c) => c >= 0).length;
  const comment = opt.comment ?? new Uint8Array(0);
  const end = new Uint8Array(22);
  put32(end, 0, 0x06054b50);
  put16(end, 8, count);
  put16(end, 10, count);
  put32(end, 12, at - cd);
  put32(end, 16, cd);
  put16(end, 20, comment.length);
  const eocd = at;
  push(concat(end, comment, opt.tail ?? new Uint8Array(0)));
  return { bytes: concat(...parts), local, central, cd, eocd };
}

export const MAIN = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  docm: 'application/vnd.ms-word.document.macroEnabled.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
} as const;

/** [Content_Types].xml：一条 Default 加若干 Override */
export const ctXml = (...types: string[]): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  types.map((t, i) => `<Override PartName="/part${i}.xml" ContentType="${t}"/>`).join('') +
  '</Types>';

export const CT = '[Content_Types].xml';

/** 最小 OOXML 包：[Content_Types].xml（不压缩）加一个主部件，extra 追加在后面 */
export const ooxml = (xml: string, extra: ZipEntry[] = []): Zip =>
  buildZip([{ name: CT, body: enc(xml) }, { name: 'word/document.xml', body: enc('<w:document/>') }, ...extra]);

// ───────── OLE2 复合文档 ─────────

export const NOSTREAM = 0xffffffff;
export interface DirEntry {
  name: string;
  /** 1 存储、2 流、5 根 */
  type: number;
  left?: number;
  right?: number;
  child?: number;
}
export interface Ole {
  bytes: Uint8Array;
  size: number;
  dirSectors: number[];
  /** 第 k 个目录条目的字节偏移 */
  entry: (k: number) => number;
}

/** 根下的直接子项排成一条右兄弟链：条目 1..n */
export const rootWith = (...kids: Array<[string, number]>): DirEntry[] => [
  { name: 'Root Entry', type: 5, child: kids.length > 0 ? 1 : NOSTREAM },
  ...kids.map(([name, type], i): DirEntry => ({ name, type, right: i + 1 < kids.length ? i + 2 : NOSTREAM })),
];

/** 布局：FAT 前 109 个、DIFAT、其余 FAT、pad 个空扇区、目录扇区。pad 大时目录扇区的 FAT 项落进第 110 个以后的 FAT 扇区 */
export function buildOle(entries: DirEntry[], opt: { shift?: 9 | 12; pad?: number } = {}): Ole {
  const shift = opt.shift ?? 9;
  const size = 1 << shift;
  const perFat = size / 4;
  const perDir = size / 128;
  const nDir = Math.ceil(entries.length / perDir);
  const pad = opt.pad ?? 0;
  let nFat = 1;
  let nDifat = 0;
  for (;;) {
    nDifat = nFat > 109 ? Math.ceil((nFat - 109) / (perFat - 1)) : 0;
    const need = Math.ceil((nFat + nDifat + pad + nDir) / perFat);
    if (need <= nFat) break;
    nFat = need;
  }
  const head = Math.min(nFat, 109);
  const fatSectors = [...Array.from({ length: head }, (_, i) => i), ...Array.from({ length: nFat - head }, (_, i) => head + nDifat + i)];
  const difatSectors = Array.from({ length: nDifat }, (_, i) => head + i);
  const dirSectors = Array.from({ length: nDir }, (_, i) => nFat + nDifat + pad + i);
  const total = nFat + nDifat + pad + nDir;
  const b = new Uint8Array((total + 1) * size);
  const sec = (n: number): number => (n + 1) * size;

  b.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  put16(b, 24, 0x3e);
  put16(b, 26, shift === 9 ? 3 : 4);
  put16(b, 28, 0xfffe);
  put16(b, 30, shift);
  put16(b, 32, 6);
  if (shift === 12) put32(b, 40, nDir);
  put32(b, 44, nFat);
  put32(b, 48, dirSectors.at(0) ?? 0xfffffffe);
  put32(b, 56, 4096);
  put32(b, 60, 0xfffffffe);
  put32(b, 68, difatSectors.at(0) ?? 0xfffffffe);
  put32(b, 72, nDifat);
  for (let i = 0; i < 109; i += 1) put32(b, 76 + i * 4, fatSectors.at(i) ?? NOSTREAM);

  difatSectors.forEach((s, d) => {
    for (let i = 0; i < perFat - 1; i += 1) put32(b, sec(s) + i * 4, fatSectors.at(109 + d * (perFat - 1) + i) ?? NOSTREAM);
    put32(b, sec(s) + (perFat - 1) * 4, difatSectors.at(d + 1) ?? 0xfffffffe);
  });
  const fat = new Array<number>(nFat * perFat).fill(NOSTREAM);
  for (const s of fatSectors) fat[s] = 0xfffffffd;
  for (const s of difatSectors) fat[s] = 0xfffffffc;
  dirSectors.forEach((s, i) => (fat[s] = dirSectors.at(i + 1) ?? 0xfffffffe));
  fat.forEach((x, n) => put32(b, sec(fatSectors.at(Math.floor(n / perFat)) ?? 0) + (n % perFat) * 4, x));

  const entry = (k: number): number => sec(dirSectors.at(Math.floor(k / perDir)) ?? 0) + (k % perDir) * 128;
  for (let k = 0; k < nDir * perDir; k += 1) {
    const at = entry(k);
    const e = entries.at(k);
    for (const f of [68, 72, 76]) put32(b, at + f, NOSTREAM);
    if (!e) continue;
    [...e.name].forEach((ch, j) => put16(b, at + j * 2, ch.charCodeAt(0)));
    put16(b, at + 64, (e.name.length + 1) * 2);
    b[at + 66] = e.type;
    b[at + 67] = 1;
    put32(b, at + 68, e.left ?? NOSTREAM);
    put32(b, at + 72, e.right ?? NOSTREAM);
    put32(b, at + 76, e.child ?? NOSTREAM);
    put32(b, at + 116, 0xfffffffe);
  }
  return { bytes: b, size, dirSectors, entry };
}
