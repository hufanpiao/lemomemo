// /files 下载链接的 HMAC 签名（架构 14.2 第 11 点、8.4 FILES_URL_SECRET；15.4 S-B0 ④）。
// 签名 = base64url(HMAC-SHA256(FILES_URL_SECRET, "v1\nGET\n<桶>\n<路径>\n<e>\n<d>"))；核对用 crypto.subtle.verify（常数时间）。
// 换掉 FILES_URL_SECRET，所有没过期的链接立即作废。

const enc = new TextEncoder();

/** 签名串（改动要同时改架构 14.2 第 11 点） */
export function stringToSign(bucket: string, path: string, e: number, d: string): string {
  return `v1\nGET\n${bucket}\n${path}\n${e}\n${d}`;
}

/** FILES_URL_SECRET 至少 32 个字符（运维脚本生成 32 字节随机数的编码，8.4） */
export const MIN_SECRET_LENGTH = 32;

let keyCache: { secret: string; key: CryptoKey } | null = null;

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (keyCache?.secret === secret) return keyCache.key;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  keyCache = { secret, key };
  return key;
}

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 不是合法 base64url（或长度不对）返回 null */
export function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function sign(secret: string, bucket: string, path: string, e: number, d: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(stringToSign(bucket, path, e, d)));
  return b64url(new Uint8Array(mac));
}

/** 常数时间比较（crypto.subtle.verify） */
export async function verify(secret: string, bucket: string, path: string, e: number, d: string, s: string): Promise<boolean> {
  const mac = s.length === 43 ? fromB64url(s) : null;
  if (!mac || mac.length !== 32) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(secret), mac, enc.encode(stringToSign(bucket, path, e, d)));
}

export function signedUrl(origin: string, bucket: string, path: string, e: number, d: string, s: string): string {
  return `${origin}/files/v1/o/${bucket}/${path}?e=${e}&d=${encodeURIComponent(d)}&s=${s}`;
}

// ---------- 下载文件名（15.6 第 4 点、L3：去控制字符、方向控制字符、Windows 不允许的字符和保留名） ----------

// eslint-disable-next-line no-control-regex -- 就是要去掉控制字符
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const INVISIBLE_RE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const WIN_BAD_RE = /[<>:"/\\|?*]/g;
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const MAX_NAME = 150;

export function sanitizeFilename(raw: string): string {
  let s = raw.normalize('NFC').replace(CONTROL_RE, '').replace(INVISIBLE_RE, '').replace(WIN_BAD_RE, '_');
  s = s.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
  const chars = [...s];
  if (chars.length > MAX_NAME) {
    // 尽量留住扩展名
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
    s = [...s.slice(0, s.length - ext.length)].slice(0, MAX_NAME - [...ext].length).join('') + ext;
  }
  const stem = s.split('.')[0] ?? '';
  if (RESERVED_RE.test(stem.trim())) s = `_${s}`;
  return s || 'file';
}

/** RFC 5987：attr-char 以外的都编码 */
export function contentDisposition(name: string): string {
  const v = encodeURIComponent(sanitizeFilename(name)).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename*=UTF-8''${v}`;
}
