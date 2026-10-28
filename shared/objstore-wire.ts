// shared/objstore.ts 用的底层小工具（架构 0.32 第 4 条、8.6）：UTF-8、base64、MD5（DeleteObjects 要 Content-MD5）、S3 的 XML。
// shared 的 lib 里没有 DOM（没有 TextEncoder、btoa、DOMParser），这里用纯 TS 写；Pages Function、Deno、Node 三边一样。
// 报错的 message 用英文错误码（A20）。

/** 字符串 → UTF-8 字节 */
export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 标准 base64（带 =） */
export function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += b === undefined ? '=' : B64[(n >> 6) & 63];
    out += c === undefined ? '=' : B64[n & 63];
  }
  return out;
}

// ---------- MD5（RFC 1321）：只给 DeleteObjects 的 Content-MD5 用，不用于任何安全判断 ----------

const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

function rotl(x: number, n: number): number {
  return (x << n) | (x >>> (32 - n));
}

export function md5(data: Uint8Array): Uint8Array {
  const len = data.length;
  const nBlocks = ((len + 8) >>> 6) + 1;
  const words = new Uint32Array(nBlocks * 16);
  for (let i = 0; i < len; i++) words[i >> 2] = (words[i >> 2] ?? 0) | ((data[i] ?? 0) << ((i % 4) * 8));
  words[len >> 2] = (words[len >> 2] ?? 0) | (0x80 << ((len % 4) * 8));
  const bitLen = len * 8;
  words[nBlocks * 16 - 2] = bitLen >>> 0;
  words[nBlocks * 16 - 1] = Math.floor(bitLen / 2 ** 32);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let blk = 0; blk < nBlocks; blk++) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + (K[i] ?? 0) + (words[blk * 16 + g] ?? 0)) | 0;
      b = (b + rotl(x, S[(i >> 4) * 4 + (i % 4)] ?? 0)) | 0;
      a = tmp;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((w, j) => {
    for (let k = 0; k < 4; k++) out[j * 4 + k] = (w >>> (k * 8)) & 0xff;
  });
  return out;
}

// ---------- XML（只认 S3 回的这几种，不是通用解析器） ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function xmlUnescape(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_all, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? '';
  });
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', [String.fromCharCode(34)]: '&quot;', [String.fromCharCode(39)]: '&apos;' };

// 两种引号用字符码写：check_arch 的字符串扫描不认正则字面量，裸引号会让它把后面的注释当成字符串
export function xmlEscape(s: string): string {
  return s.replace(/[&<>\x22\x27]/g, (c) => ESCAPES[c] ?? c);
}

function blocks(xml: string, name: string): string[] {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1] ?? '');
}

function first(xml: string, name: string): string | null {
  const all = blocks(xml, name);
  return all.length ? xmlUnescape(all[0] ?? '') : null;
}

export interface ListedObject {
  key: string;
  size: number;
  etag: string;
}

export interface ListPage {
  objects: ListedObject[];
  /** 下一页的 continuation-token；没有下一页为 null */
  nextToken: string | null;
}

/** ListObjectsV2 的响应 */
export function parseListV2(xml: string): ListPage {
  if (!/<ListBucketResult[\s>]/.test(xml)) throw new Error('objstore_bad_list_xml');
  const objects = blocks(xml, 'Contents').map((c) => {
    const key = first(c, 'Key');
    const size = Number(first(c, 'Size') ?? 'NaN');
    if (key === null || !Number.isFinite(size)) throw new Error('objstore_bad_list_xml');
    return { key, size, etag: first(c, 'ETag') ?? '' };
  });
  const truncated = (first(xml, 'IsTruncated') ?? 'false').trim() === 'true';
  const next = first(xml, 'NextContinuationToken');
  if (truncated && !next) throw new Error('objstore_bad_list_xml');
  return { objects, nextToken: truncated ? next : null };
}

export interface DeleteFailure {
  key: string;
  code: string;
}

/** DeleteObjects 的响应：Quiet 模式下只列出删失败的 */
export function parseDeleteResult(xml: string): DeleteFailure[] {
  if (!/<DeleteResult[\s>]/.test(xml)) throw new Error('objstore_bad_delete_xml');
  return blocks(xml, 'Error').map((e) => ({ key: first(e, 'Key') ?? '', code: first(e, 'Code') ?? '' }));
}

/** DeleteObjects 的请求体 */
export function deleteBody(keys: readonly string[]): string {
  const objs = keys.map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>${objs}</Delete>`;
}
