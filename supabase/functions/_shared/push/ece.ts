// Web Push 正文加密：RFC 8291（Message Encryption for Web Push）+ RFC 8188（aes128gcm）。只用 Web Crypto，不引第三方库（B2 选型，11-03）。
// 逐条对应 B2 安全审查第三节：
//   C-1 每加密一次就 generateKey 一对新的 ECDH 临时密钥，不缓存、不复用；
//   C-2 salt 每条 16 字节，只用 crypto.getRandomValues（本文件不出现 Math.random）；
//   C-3 p256dh 由 endpoint.ts 的 checkKeys 严格解码（65 字节、首字节 0x04），importKey 失败（点不在曲线上）抛 PushCryptoError('bad_keys')；
//   C-4 PRK_key = HKDF-Extract(auth, ecdh)；key_info = "WebPush: info" ‖ 0x00 ‖ ua_public ‖ as_public；IKM = HKDF-Expand(PRK_key, key_info, 32)；
//       CEK = HKDF(salt, IKM, "Content-Encoding: aes128gcm" ‖ 0x00, 16)；NONCE = HKDF(salt, IKM, "Content-Encoding: nonce" ‖ 0x00, 12)
//       （Web Crypto 的 HKDF deriveBits = Extract + Expand 一步做完）；
//   C-5 RFC 8291 附录 A 的固定向量由 encryptWithFixedKeysForTest（只给测试用）逐字节核对；正式入口 encryptPush 不接受外部传入的临时密钥和 salt；
//   C-6 头部 salt(16) ‖ rs(4，大端，4096) ‖ idlen(1)=65 ‖ keyid=as_public(65) 共 86 字节；只有一条记录，末尾分隔字节 0x02；
//       AES-128-GCM、12 字节 nonce、16 字节 tag。
// 补齐（安全审查第四节）：明文后接 0x02，再补 0x00，凑到 PAD_TIERS 三档之一（取装得下的最小一档）；不往 JSON 里加空格。
//   整份密文 = 86 + 档位 + 16，最大一档 3174 字节 ≤ 4096。明文 + 1 超过 3072 抛 PushCryptoError('payload_too_large')，标题由 notify-text 截断。
// 不 import npm 包、不碰 Deno 全局；Node 和 Deno 都能跑。

import { concatBytes, type Bytes } from './b64.ts';

/** 补齐后（含 0x02 分隔字节和 0x00）的明文长度只有这三档 */
export const PAD_TIERS: readonly number[] = [1024, 2048, 3072];
export const RECORD_SIZE = 4096;
export const HEADER_BYTES = 86;
export const TAG_BYTES = 16;

export class PushCryptoError extends Error {
  readonly code: 'bad_keys' | 'payload_too_large';
  constructor(code: 'bad_keys' | 'payload_too_large') {
    super(code);
    this.code = code;
  }
}

const te = new TextEncoder();
const KEY_INFO = te.encode('WebPush: info\0');
const CEK_INFO = te.encode('Content-Encoding: aes128gcm\0');
const NONCE_INFO = te.encode('Content-Encoding: nonce\0');

/** 明文 → 补齐后的一条记录（明文 ‖ 0x02 ‖ 0x00…），长度是 PAD_TIERS 之一 */
export function padRecord(payload: Bytes): Bytes {
  const tier = PAD_TIERS.find((t) => payload.length + 1 <= t);
  if (tier === undefined) throw new PushCryptoError('payload_too_large');
  const out = new Uint8Array(tier);
  out.set(payload);
  out.set([2], payload.length);
  return out;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}

async function importUaPublic(uaPublic: Bytes): Promise<CryptoKey> {
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new PushCryptoError('bad_keys');
  try {
    return await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch {
    throw new PushCryptoError('bad_keys');
  }
}

/** 加密一条已经补齐好的记录。asPrivate、asPublic 是这一条的临时密钥，salt 16 字节 */
async function encryptRecord(record: Bytes, uaPublic: Bytes, authSecret: Bytes,
                             asPrivate: CryptoKey, asPublic: Bytes, salt: Bytes): Promise<Bytes> {
  if (authSecret.length !== 16 || salt.length !== 16 || asPublic.length !== 65) throw new PushCryptoError('bad_keys');
  const uaKey = await importUaPublic(uaPublic);
  let ecdh: Bytes;
  try {
    ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));
  } catch {
    throw new PushCryptoError('bad_keys');
  }
  const ikm = await hkdf(authSecret, ecdh, concatBytes(KEY_INFO, uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, CEK_INFO, 16);
  const nonce = await hkdf(salt, ikm, NONCE_INFO, 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, record));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE);
  return concatBytes(salt, rs, new Uint8Array([65]), asPublic, ct);
}

/**
 * 正式入口：明文 → aes128gcm 正文（补齐到三档之一）。每次都新生成 ECDH 临时密钥和 salt（C-1、C-2）。
 * uaPublic、authSecret 用 endpoint.ts 的 checkKeys 解出来的字节。
 */
export async function encryptPush(uaPublic: Bytes, authSecret: Bytes, payload: Bytes): Promise<Bytes> {
  const record = padRecord(payload);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return await encryptRecord(record, uaPublic, authSecret, as.privateKey, asPublic, salt);
}

/**
 * **只给测试用**（C-5：RFC 8291 附录 A 固定向量）：临时私钥（JWK，d、x、y）和 salt 由调用方给，record 原样加密、不再补齐。
 * push-dispatch、push-test 不准调它：tests/build/push-fixed-key-guard.test.ts 扫源码，tests/ 以外除了这里的定义一律不准出现这个名字（代码审查 S5）
 */
export async function encryptWithFixedKeysForTest(record: Bytes, uaPublic: Bytes, authSecret: Bytes,
                                                  asJwk: JsonWebKey, salt: Bytes): Promise<Bytes> {
  const asPrivate = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: asJwk.d, x: asJwk.x, y: asJwk.y } as JsonWebKey,
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: asJwk.x, y: asJwk.y } as JsonWebKey,
    { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pub));
  return await encryptRecord(record, uaPublic, authSecret, asPrivate, asPublic, salt);
}
