// 本机推送替身（push-service.ts）的“浏览器 / 推送服务一侧”密码学：只用 Web Crypto，Node（vitest）和 Deno（deno test）都能跑。
// 改自后端 BE-1 第 1 天评估 Web Push 库时写的假推送服务，去掉了它的 /stats 和独立进程入口。
//   ① checkVapid：按推送服务的做法核 Authorization: vapid t=<JWT>, k=<公钥>（RFC 8292）——JWT 头 typ = JWT、alg = ES256，
//      签名正好 64 字节并用 k 验过，aud 由调用方判断（替身按本次请求的源判，代码审查 M1），exp 没过期且离现在不超过上限（≤ 12 小时），
//      sub 是 mailto: 或 https://
//   ② parseAes128gcm + decryptRecord：订阅方（浏览器）解 aes128gcm（RFC 8291 + RFC 8188），先查头（idlen = 65、rs ≥ 18、只有一条记录），
//      再用自己的私钥和 auth 解出明文
//   ③ HKDF 手写（HMAC-SHA-256 的 extract + expand，RFC 5869），不用 Web Crypto 的 HKDF——后端用的是后者，两种写法交叉核对才有意义
//      （代码审查 M2；安全审查 C-11：加密、解密各写一份）。RFC 5869、RFC 8291 附录 A 的固定向量在 push-service-fake-crypto.test.ts 里核
//   ④ newPushSubscriber / subscriberFromKeys：造假订阅方，带上它的真实端点（替身按端点的源核 aud、按订阅方配回复）
// 发送方（加密、签 JWT）由后端写在 supabase/functions 里，不在这里

const te = new TextEncoder();
const td = new TextDecoder();

export function b64u(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** RFC 5869 HKDF-SHA-256，手写 extract + expand（len ≤ 32 时只要 T(1)，这里按通式写） */
export async function hkdfHmac(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, len: number) {
  const prk = await hmac(salt.length > 0 ? salt : new Uint8Array(32), ikm); // RFC 5869 第 2.2 节：没有 salt 时用 HashLen 个 0
  let t: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let okm: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  for (let i = 1; okm.length < len; i++) {
    t = await hmac(prk, concat(t, info, new Uint8Array([i])));
    okm = concat(okm, t);
  }
  return okm.slice(0, len);
}

/** 假订阅方：p256dh、auth 交给发送方（写进 devices），私钥留在测试里解密用；endpoint 是它在真实推送服务上的地址 */
export interface PushSubscriber {
  p256dh: string;
  auth: string;
  priv: CryptoKey;
  pubRaw: Uint8Array<ArrayBuffer>;
  authRaw: Uint8Array<ArrayBuffer>;
  endpoint: string | null;
}

export async function newPushSubscriber(endpoint: string | null = null): Promise<PushSubscriber> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const authRaw = crypto.getRandomValues(new Uint8Array(16));
  return { p256dh: b64u(pubRaw), auth: b64u(authRaw), priv: kp.privateKey, pubRaw, authRaw, endpoint };
}

/** 用固定的密钥造订阅方（RFC 8291 附录 A 那种）：d 是私钥 32 字节，p256dh 是公钥 65 字节，都是 base64url */
export async function subscriberFromKeys(d: string, p256dh: string, auth: string, endpoint: string | null = null): Promise<PushSubscriber> {
  const pubRaw = unb64u(p256dh);
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', d, x: b64u(pubRaw.slice(1, 33)), y: b64u(pubRaw.slice(33, 65)), ext: false };
  const priv = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { p256dh, auth, priv, pubRaw, authRaw: unb64u(auth), endpoint };
}

export interface Aes128gcmBody {
  salt: Uint8Array<ArrayBuffer>;
  rs: number;
  keyid: Uint8Array<ArrayBuffer>;
  ct: Uint8Array<ArrayBuffer>;
}

/** 拆 RFC 8188 的头；不合规回原因码：bad_body（太短）、bad_keyid（idlen 不是 65 或不是 0x04 开头）、bad_rs（rs < 18）、multi_record（多于一条记录） */
export function parseAes128gcm(body: Uint8Array<ArrayBuffer>): Aes128gcmBody | string {
  if (body.length < 21) return 'bad_body';
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20] ?? 0;
  if (idlen !== 65) return 'bad_keyid';
  const keyid = body.slice(21, 21 + idlen);
  if (keyid.length !== 65 || keyid[0] !== 4) return 'bad_keyid';
  if (rs < 18) return 'bad_rs';
  const ct = body.slice(21 + idlen);
  if (ct.length < 17) return 'bad_body'; // 16 字节 tag + 至少 1 字节分隔符
  if (ct.length > rs) return 'multi_record'; // Web Push 只发一条记录（RFC 8291 第 4 节）
  return { salt: body.slice(0, 16), rs, keyid, ct };
}

/** 用订阅方的私钥解一条记录；不是发给这个订阅方的（密钥对不上）会抛错 */
export async function decryptRecord(sub: PushSubscriber, b: Aes128gcmBody): Promise<string> {
  const asKey = await crypto.subtle.importKey('raw', b.keyid, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, sub.priv, 256));
  const ikm = await hkdfHmac(sub.authRaw, ecdh, concat(te.encode('WebPush: info\0'), sub.pubRaw, b.keyid), 32);
  const cek = await hkdfHmac(b.salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfHmac(b.salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, b.ct));
  let end = pt.length - 1;
  while (end >= 0 && pt[end] === 0) end--; // 去掉补齐的 0
  if (pt[end] !== 2) throw new Error('bad_padding'); // 单条记录（也是最后一条）的分隔符是 0x02
  return td.decode(pt.slice(0, end));
}

/** 拆头 + 解密，一步到位；头不合规或解不开都抛错 */
export async function decryptPayload(sub: PushSubscriber, body: Uint8Array<ArrayBuffer>): Promise<string> {
  const b = parseAes128gcm(body);
  if (typeof b === 'string') throw new Error(b);
  return decryptRecord(sub, b);
}

export interface VapidClaims {
  aud?: unknown;
  exp?: unknown;
  sub?: unknown;
}

export type VapidResult = { ok: true; claims: VapidClaims; publicKey: string } | { ok: false; why: string };

export interface VapidCheck {
  /** 这个 aud 认不认；不认回 bad_aud */
  audienceOk: (aud: string) => boolean;
  /** exp 最多比现在晚多少秒（默认 12 小时，架构审 D1 第 4 点；RFC 8292 的上限是 24 小时） */
  maxExpiresInSec?: number;
  /** 写了就要求 k 等于这把公钥（base64url 的 65 字节 raw），测“用的是不是 seed 里那把假钥匙” */
  publicKey?: string;
  /** 秒级的“现在”，测试可注入 */
  nowSec: number;
}

/** 核一个 Authorization 头；不抛错，失败回原因码 */
export async function checkVapid(header: string, opt: VapidCheck): Promise<VapidResult> {
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+),\s*k=([\w-]+)$/.exec(header.trim());
  if (!m) return { ok: false, why: 'bad_authorization' };
  const [, h = '', p = '', s = '', k = ''] = m;
  if (opt.publicKey !== undefined && k !== opt.publicKey) return { ok: false, why: 'unknown_key' };
  try {
    const head = JSON.parse(td.decode(unb64u(h))) as { alg?: unknown; typ?: unknown };
    if (head.typ !== 'JWT') return { ok: false, why: 'bad_typ' };
    if (head.alg !== 'ES256') return { ok: false, why: 'bad_alg' };
    const sig = unb64u(s);
    if (sig.length !== 64) return { ok: false, why: 'bad_signature' }; // ES256 的 JWS 签名是 r‖s 各 32 字节，不是 DER
    const pub = await crypto.subtle.importKey('raw', unb64u(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const good = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, te.encode(`${h}.${p}`));
    if (!good) return { ok: false, why: 'bad_signature' };
    const claims = JSON.parse(td.decode(unb64u(p))) as VapidClaims;
    if (typeof claims.aud !== 'string' || !opt.audienceOk(claims.aud)) return { ok: false, why: 'bad_aud' };
    const maxIn = opt.maxExpiresInSec ?? 12 * 3600;
    if (typeof claims.exp !== 'number' || claims.exp <= opt.nowSec) return { ok: false, why: 'expired' };
    if (claims.exp > opt.nowSec + maxIn) return { ok: false, why: 'exp_too_far' };
    if (typeof claims.sub !== 'string' || !/^(mailto:|https:\/\/)/.test(claims.sub)) return { ok: false, why: 'bad_sub' };
    return { ok: true, claims, publicKey: k };
  } catch {
    return { ok: false, why: 'bad_jwt' };
  }
}
