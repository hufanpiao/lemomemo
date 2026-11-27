// base64url 编解码（RFC 4648 第 5 节）：前端只用这一份（推送订阅的钥匙、推送认领的摘要、录音上传的 X-Projects）。
// 服务器函数那边不能直接 import shared（单测不跑 copy:shared，_shared 下给 Vitest 测的模块不准引 _shared/gen/），
// 用的是 supabase/functions/_shared/b64url.ts；两份逐字节一样，由 tests/shared/core/b64url.test.ts 拿同一批输入对照钉住。
// shared 的 lib 里没有 btoa、atob（tsconfig.shared.json 不带 DOM），这里用纯 TS 写。
// 不变量：编码不带 =；解码严格——只认 [A-Za-z0-9_-]，末尾可带补齐的 =（个数要对，补到 4 的整数倍），别的字符（含标准 base64 的 + /、空白）
//   一律回 null；最后一组多出来的位不管（同浏览器 atob）。纯函数，不抛异常。

/** 底层是 ArrayBuffer 的字节数组（Web Crypto 的参数要这个；Deno 的类型检查比 Node 严） */
export type Bytes = Uint8Array<ArrayBuffer>;

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64U_RE = /^([A-Za-z0-9_-]*)(=*)$/;

/** 字节 → base64url，不补 = */
export function b64uEncode(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const c of b) {
    acc = (acc << 8) | c;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ALPHA.charAt((acc >> bits) & 63);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHA.charAt((acc << (6 - bits)) & 63);
  return out;
}

/** 严格解码（规则见文件头）；不合格回 null */
export function b64uDecode(s: string): Bytes | null {
  const m = B64U_RE.exec(s);
  if (!m) return null;
  const body = m[1] ?? '';
  const pad = (m[2] ?? '').length;
  if (body.length % 4 === 1) return null;
  if (pad > 0 && (body.length + pad) % 4 !== 0) return null;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of body) {
    acc = (acc << 6) | ALPHA.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}
