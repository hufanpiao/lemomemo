// VAPID（RFC 8292）：私钥导入、启动自检、按 origin 缓存的 ES256 JWT。只用 Web Crypto。B2 安全审查第三节 C-7、C-8、C-9，D1-6。
//
// 环境变量（由运维 O-1 脚本 tools/keys/set-vapid-keys.ps1 写进函数 secrets，值不进日志、不进心跳、不进错误信息）：
//   VAPID_PRIVATE_KEY：一行 JWK JSON {"kty":"EC","crv":"P-256","d":"…","x":"…","y":"…"}（d、x、y 各 32 字节 base64url）；
//   VAPID_PUBLIC_KEY ：公钥 0x04‖x‖y 共 65 字节的 base64url（87 字符），和 GitHub 变量 PREVIEW_VAPID_PUBLIC_KEY / 前端 VITE_PUBLIC_VAPID_KEY 同一个值；
//   VAPID_SUBJECT    ：https://… 或 mailto:…（O-1 默认 https://lemomemo.com，R-283；苹果不认时改 mailto: 重跑脚本）。
// 自检（C-9）：Web Crypto 导入 JWK 私钥时不核对 d 和 x、y 是不是一对（11-03 实测：y 换成 x 照样导入成功）。所以每个实例第一次用之前：
//   ① 用 d 签一段固定的串，用 x、y 导入的公钥验签；② 0x04‖x‖y 和 VAPID_PUBLIC_KEY 解码后逐字节比对。有一项不过就不能发（函数回 500）。
// 私钥导入时 extractable: false，只存在内存（C-8）。
// JWT（C-7、D1-6）：头 {"typ":"JWT","alg":"ES256"}；aud = 本次请求的 origin（https://<主机>，不带路径和端口），按 origin 分开缓存，
//   不拿给一个 origin 签的 JWT 发另一个 origin；exp = 签发时刻 + 12 小时，剩余不到 1 小时就重签；签名是 Web Crypto 给的 64 字节 r‖s，直接用于 JWS、不转 DER。
//   Authorization: vapid t=<jwt>, k=<公钥 base64url>。
// 不 import npm 包、不碰 Deno 全局（环境变量由调用方读好传进来）。

import { b64uDecode, b64uEncode, concatBytes, type Bytes } from '../b64url.ts';

export const JWT_TTL_S = 12 * 3600;
export const JWT_RESIGN_BEFORE_S = 3600;
// BE1-S1（安全审查六之四）：和 R-283、O-1 脚本 tools/keys/set-vapid-keys.ps1 的 $SubjectRe 逐字一致（tests/build/set-vapid-keys.test.ts 钉住）——
//   https:// 后面只许小写主机（至少一个点，不带端口），路径只许字母数字和 . _ ~ / -；或者 mailto:，域名同样只许小写
const SUBJECT = /^(?:https:\/\/[a-z0-9-]+(?:[.][a-z0-9-]+)+(?:\/[A-Za-z0-9._~/-]*)?|mailto:[A-Za-z0-9._+-]+@[a-z0-9-]+(?:[.][a-z0-9-]+)+)$/;
const SELF_CHECK_MSG = new TextEncoder().encode('lemomemo-vapid-self-check');

export type VapidKeys = { key: CryptoKey; publicRaw: Bytes; publicB64: string; subject: string };
export type VapidLoad = { ok: true; keys: VapidKeys } | { ok: false; reason: 'vapid_missing' | 'vapid_bad_key' | 'vapid_bad_subject' | 'vapid_keypair_mismatch' };

function coord(s: unknown): Bytes | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(s)) return null;
  const b = b64uDecode(s);
  return b && b.length === 32 ? b : null;
}

/** 读入并自检。参数是三个环境变量的原值（没设为 undefined） */
export async function loadVapid(privateJwk: string | undefined, publicKey: string | undefined, subject: string | undefined): Promise<VapidLoad> {
  if (!privateJwk || !publicKey || !subject) return { ok: false, reason: 'vapid_missing' };
  if (!SUBJECT.test(subject)) return { ok: false, reason: 'vapid_bad_subject' };
  let jwk: { kty?: unknown; crv?: unknown; d?: unknown; x?: unknown; y?: unknown };
  try {
    jwk = JSON.parse(privateJwk) as typeof jwk;
  } catch {
    return { ok: false, reason: 'vapid_bad_key' };
  }
  if (typeof jwk !== 'object' || jwk === null || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return { ok: false, reason: 'vapid_bad_key' };
  const d = coord(jwk.d), x = coord(jwk.x), y = coord(jwk.y);
  if (!d || !x || !y) return { ok: false, reason: 'vapid_bad_key' };
  const jx = jwk.x as string, jy = jwk.y as string;
  let key: CryptoKey, pub: CryptoKey;
  try {
    key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: jwk.d as string, x: jx, y: jy, ext: false } as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    pub = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jx, y: jy } as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    return { ok: false, reason: 'vapid_bad_key' };
  }
  // ① d 和 x、y 是一对
  try {
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, SELF_CHECK_MSG);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, SELF_CHECK_MSG)) return { ok: false, reason: 'vapid_keypair_mismatch' };
  } catch {
    return { ok: false, reason: 'vapid_keypair_mismatch' };
  }
  // ② 和服务器侧 VAPID_PUBLIC_KEY 逐字节一致
  const publicRaw = concatBytes(new Uint8Array([4]), x, y);
  const want = /^[A-Za-z0-9_-]{87}$/.test(publicKey) ? b64uDecode(publicKey) : null;
  // 逐字节比：两边都按规范 base64url 重新编码后比字符串（等价于逐字节相等；不用变量下标，F7）
  if (!want || want.length !== 65 || b64uEncode(want) !== b64uEncode(publicRaw)) return { ok: false, reason: 'vapid_keypair_mismatch' };
  return { ok: true, keys: { key, publicRaw, publicB64: b64uEncode(publicRaw), subject } };
}

const te = new TextEncoder();
const JWT_HEAD = b64uEncode(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));

/** 一轮（或一个实例）里按 origin 缓存 JWT；nowMs 由调用方给（测试注入假时钟） */
export class VapidSigner {
  private readonly cache = new Map<string, { header: string; exp: number }>();
  private readonly keys: VapidKeys;
  private readonly nowMs: () => number;
  constructor(keys: VapidKeys, nowMs: () => number) {
    this.keys = keys;
    this.nowMs = nowMs;
  }

  /** origin 必须是 endpoint.ts checkEndpoint 给的 origin（https://<主机>）；返回整个 Authorization 头的值 */
  async authorization(origin: string): Promise<string> {
    const now = Math.floor(this.nowMs() / 1000);
    const hit = this.cache.get(origin);
    if (hit && hit.exp - now > JWT_RESIGN_BEFORE_S) return hit.header;
    const exp = now + JWT_TTL_S;
    const body = b64uEncode(te.encode(JSON.stringify({ aud: origin, exp, sub: this.keys.subject })));
    const signing = `${JWT_HEAD}.${body}`;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.key, te.encode(signing)));   // 64 字节 r‖s
    const header = `vapid t=${signing}.${b64uEncode(sig)}, k=${this.keys.publicB64}`;
    this.cache.set(origin, { header, exp });
    return header;
  }

  /** 缓存了几个 origin（测试用） */
  get size(): number {
    return this.cache.size;
  }
}
