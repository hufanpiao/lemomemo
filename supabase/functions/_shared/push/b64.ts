// Web Push 用的 base64url 编解码（RFC 4648 第 5 节，不带 =）。纯函数，不 import npm 包、不碰 Deno 全局；Node 和 Deno 都能跑。

/** 底层是 ArrayBuffer 的字节数组（Web Crypto 的参数要这个；Deno 的类型检查比 Node 严） */
export type Bytes = Uint8Array<ArrayBuffer>;

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function b64uEncode(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 严格解码：只认 [A-Za-z0-9_-]，末尾可带补齐的 =（个数要对）；别的字符（含标准 base64 的 + /、空白）一律回 null。
 * 不抛异常
 */
export function b64uDecode(s: string): Bytes | null {
  const m = /^([A-Za-z0-9_-]*)(=*)$/.exec(s);
  if (!m) return null;
  const body = m[1] ?? '';
  const pad = (m[2] ?? '').length;
  if (body.length % 4 === 1) return null;
  if (pad > 0 && (body.length + pad) % 4 !== 0) return null;
  for (const ch of body) if (!ALPHA.includes(ch)) return null;
  try {
    const bin = atob(body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (body.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function concatBytes(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
