// WebAuthn 的纯校验（B5 任务单 S4、架构 5.5、0.29 续第 46、63 条；TC-B5-06、31、40）：不碰数据库，Vitest 直接测。
// • origin：正式只认 https://lemomemo.com，预览只认 https://preview.lemomemo.com，本机认 http://localhost:<端口>、http://127.0.0.1:<端口>；
//   来源是 tauri.localhost（exe，R-105）一律 webauthn_unavailable；
// • RP ID 哈希 = sha256('lemomemo.com')（本机另认 sha256('localhost')）；
// • authData：UP、UV 两位都要（Face ID / Windows Hello 一定做用户验证；只按一下的安全钥匙不算，代定见交回）；
// • 公钥只收 COSE EC2 P-256 / ES256（kty 2、alg -7、crv 1），存成 0x04‖x‖y 的 65 字节；别的算法拒；
// • attestation 的 fmt 认 none，另认 packed 自签（没有 x5c、alg -7，用凭据自己的公钥验签）；别的 fmt 拒；
// • 签名是 DER 编码的 ECDSA，转成 r‖s 的 64 字节交给 WebCrypto 验。
import type { EnvKind } from '../_shared/env-kind.ts';
import { b64uDecode, type Bytes, concatBytes } from '../_shared/b64url.ts';
import { type Cbor, CborError, decodeAll, decodeFirst, isBytes, isMap } from './cbor.ts';

export class WebauthnError extends Error {
  readonly code: 'webauthn_failed' | 'webauthn_unavailable';
  constructor(code: 'webauthn_failed' | 'webauthn_unavailable' = 'webauthn_failed') {
    super(code);
    this.code = code;
  }
}
const fail = (): never => { throw new WebauthnError(); };

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d{1,5}$/;

/** 来源是 exe（tauri.localhost，任何协议、端口） */
export function isTauriOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).hostname.toLowerCase() === 'tauri.localhost';
  } catch {
    return false;
  }
}

export function originAllowed(env: EnvKind, origin: string): boolean {
  if (env === 'prod') return origin === 'https://lemomemo.com';
  if (env === 'preview') return origin === 'https://preview.lemomemo.com';
  return LOCAL_ORIGIN.test(origin);
}

/** 这个环境发给客户端的 RP ID（本机的页面在 localhost 上，只能用 localhost） */
export function rpIdFor(env: EnvKind, rpId: string): string {
  return env === 'local' ? 'localhost' : rpId;
}

/** 认哪些 RP ID 的哈希 */
export function rpIdsAccepted(env: EnvKind, rpId: string): string[] {
  return env === 'local' ? [rpId, 'localhost'] : [rpId];
}

export async function sha256(b: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', b as Bytes));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a.at(i) ?? 0) ^ (b.at(i) ?? 0);
  return d === 0;
}

export function b64(s: string): Bytes {
  return b64uDecode(s) ?? fail();
}

export interface ClientData { type: unknown; challenge: string; origin: string; crossOrigin: unknown }

/** 解 clientDataJSON，只取出挑战（调用方先拿它删掉挑战，再 checkClientData——挑战不管验没验过都只能用一次） */
export function readClientData(raw: Uint8Array): ClientData {
  let v: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as typeof v;
  } catch {
    return fail();
  }
  if (typeof v.origin !== 'string' || typeof v.challenge !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(v.challenge)) return fail();
  return { type: v.type, challenge: v.challenge, origin: v.origin, crossOrigin: v.crossOrigin };
}

/** type、origin 要对；crossOrigin 为 true 拒；来源是 exe 回 webauthn_unavailable */
export function checkClientData(v: ClientData, type: 'webauthn.create' | 'webauthn.get', env: EnvKind): void {
  if (isTauriOrigin(v.origin)) throw new WebauthnError('webauthn_unavailable');
  if (v.type !== type || v.crossOrigin === true || !originAllowed(env, v.origin)) fail();
}

export interface AuthData { rpIdHash: Uint8Array; flags: number; signCount: number; credentialId: Uint8Array | null; publicKey: Bytes | null }

/** COSE EC2 P-256 公钥 → 0x04‖x‖y */
export function coseToRaw(v: Cbor): Bytes {
  if (!isMap(v) || v.get(1) !== 2 || v.get(3) !== -7 || v.get(-1) !== 1) return fail();
  const x = v.get(-2);
  const y = v.get(-3);
  if (!isBytes(x) || !isBytes(y) || x.length !== 32 || y.length !== 32) return fail();
  return concatBytes(new Uint8Array([4]), new Uint8Array(x), new Uint8Array(y));
}

/** authenticatorData：rpIdHash(32) flags(1) signCount(4) [aaguid(16) idLen(2) id 公钥(COSE)] [扩展] */
export function parseAuthData(ad: Uint8Array, withCredential: boolean): AuthData {
  if (ad.length < 37) return fail();
  const flags = ad.at(32) ?? 0;
  const dv = new DataView(ad.buffer, ad.byteOffset, ad.byteLength);
  const signCount = dv.getUint32(33);
  if (!withCredential) return { rpIdHash: ad.slice(0, 32), flags, signCount, credentialId: null, publicKey: null };
  if ((flags & FLAG_AT) === 0 || ad.length < 55) return fail();
  const idLen = dv.getUint16(53);
  if (idLen < 16 || idLen > 1023 || ad.length < 55 + idLen + 1) return fail();
  const credentialId = ad.slice(55, 55 + idLen);
  let pk: Cbor;
  try {
    pk = decodeFirst(ad, 55 + idLen).value;
  } catch (e) {
    if (e instanceof CborError) return fail();
    throw e;
  }
  return { rpIdHash: ad.slice(0, 32), flags, signCount, credentialId, publicKey: coseToRaw(pk) };
}

/** DER 的 SEQUENCE { INTEGER r, INTEGER s } → r‖s（各 32 字节） */
export function derToRaw(der: Uint8Array): Bytes {
  const at = (i: number) => der.at(i) ?? fail();
  if (der.length < 8 || der.length > 72 || at(0) !== 0x30 || at(1) !== der.length - 2) return fail();
  const out = new Uint8Array(64);
  let p = 2;
  for (let k = 0; k < 2; k++) {
    if (at(p) !== 0x02) return fail();
    const len = at(p + 1);
    if (len < 1 || len > 33 || p + 2 + len > der.length) return fail();
    let v = der.slice(p + 2, p + 2 + len);
    while (v.length > 32 && v.at(0) === 0) v = v.slice(1);
    if (v.length > 32) return fail();
    out.set(v, k * 32 + (32 - v.length));
    p += 2 + len;
  }
  if (p !== der.length) return fail();
  return out;
}

export async function verifyEs256(publicRaw: Uint8Array, derSig: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', publicRaw as Bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(derSig), data as Bytes);
  } catch (e) {
    if (e instanceof WebauthnError) return false;
    return false;
  }
}

/** rpIdHash 是认的那几个之一；UP、UV 都要 */
export async function checkRpAndFlags(a: AuthData, env: EnvKind, rpId: string): Promise<void> {
  let ok = false;
  for (const id of rpIdsAccepted(env, rpId)) if (sameBytes(a.rpIdHash, await sha256(new TextEncoder().encode(id)))) ok = true;
  if (!ok || (a.flags & FLAG_UP) === 0 || (a.flags & FLAG_UV) === 0) fail();
}

/** 登记：解 attestationObject、核 fmt 和 attStmt，回凭据 id 和公钥（clientData 由调用方先核） */
export async function readAttestation(attObj: Uint8Array, clientDataRaw: Uint8Array, env: EnvKind, rpId: string): Promise<AuthData & { credentialId: Uint8Array; publicKey: Bytes }> {
  let v: Cbor;
  try {
    v = decodeAll(attObj);
  } catch (e) {
    if (e instanceof CborError) return fail();
    throw e;
  }
  if (!isMap(v)) return fail();
  const fmt = v.get('fmt');
  const stmt = v.get('attStmt');
  const ad = v.get('authData');
  if (typeof fmt !== 'string' || !isMap(stmt) || !isBytes(ad)) return fail();
  const a = parseAuthData(ad, true);
  await checkRpAndFlags(a, env, rpId);
  if (!a.credentialId || !a.publicKey) return fail();
  if (fmt === 'none') {
    if (stmt.size !== 0) fail();
  } else if (fmt === 'packed') {
    const sig = stmt.get('sig');
    if (stmt.get('alg') !== -7 || !isBytes(sig) || stmt.has('x5c') || stmt.size !== 2) fail();
    if (!(await verifyEs256(a.publicKey, sig as Uint8Array, concatBytes(new Uint8Array(ad), await sha256(clientDataRaw))))) fail();
  } else {
    fail();
  }
  return { ...a, credentialId: a.credentialId, publicKey: a.publicKey };
}
