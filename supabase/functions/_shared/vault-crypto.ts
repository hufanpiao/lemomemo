// 隐私记的加密底座（架构 5.5、15.2 低 8、S-B5b；B5 任务单 S1、代定 D7、D8）：vault、ai-embed 等解密方共用这一份。
// • 总钥匙 VAULT_KEY、密码胡椒 VAULT_PIN_PEPPER 都是 32 字节随机数的标准 base64（tools/keys/gen-vault-keys.ps1 生成，负责人本人运行，AI 不经手值）；
//   解不出正好 32 字节一律当没配好，不降级。
// • 子密钥按人、按用途派生：HKDF-SHA256(VAULT_KEY, salt = user_id, info = 'lemo-vault/v1/<用途>')。用途一次定好三个（15.2 低 8）：
//   note（正文 body_enc、vault_ai 描述）、plus-draft（隐私记草稿，B4b-3 用）、file-sha（附件哈希的 HMAC，B4b-1 用）。
//   子密钥互相解不开（TC-B5-17），一个人的子密钥解不开别人的密文。
// • 加密：AES-256-GCM，每次随机 96 位 nonce；存成 nonce(12) ‖ 密文 ‖ 标签(16)；AAD 由调用方给（正文是 user_id|note_id|enc_key_id）。
// • enc_key_id：总钥匙的版本号（现在只有 1；以后换钥匙时新旧并存按它选）。
// • pin_hash = HMAC-SHA256(VAULT_PIN_PEPPER, user_id || ':' || pin) 的十六进制，比较用常数时间（5.5）。
// 不打印、不抛带内容的错误；不 import npm 包、不碰 Deno 全局（Vitest 直接测）。

export const ENC_KEY_ID = 1;
export const NONCE_BYTES = 12;
export type VaultPurpose = 'note' | 'plus-draft' | 'file-sha';
type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();
const utf8 = (s: string): Bytes => enc.encode(s) as Bytes;

/** 解开一把 32 字节的钥匙（标准 base64，允许首尾空白）；格式不对、长度不对回 null */
export function decodeKey32(v: string | undefined | null): Bytes | null {
  if (!v) return null;
  const s = v.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(s)) return null;
  try {
    const bin = atob(s);
    if (bin.length !== 32) return null;
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hkdfBits(master: Bytes, userId: string, purpose: VaultPurpose): Promise<Bytes> {
  const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(userId), info: utf8(`lemo-vault/v1/${purpose}`) }, base, 256);
  return new Uint8Array(bits);
}

/** 这个人、这个用途的 AES-256-GCM 子密钥（不可导出） */
export async function aesKeyFor(master: Bytes, userId: string, purpose: Exclude<VaultPurpose, 'file-sha'>): Promise<CryptoKey> {
  const raw = await hkdfBits(master, userId, purpose);
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}

/** 附件哈希用的 HMAC 子密钥（B4b-1） */
export async function hmacKeyFor(master: Bytes, userId: string): Promise<CryptoKey> {
  const raw = await hkdfBits(master, userId, 'file-sha');
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  } finally {
    raw.fill(0);
  }
}

/** 加密：nonce ‖ 密文 ‖ 标签 */
export async function seal(key: CryptoKey, aad: string, plain: Uint8Array): Promise<Bytes> {
  const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad), tagLength: 128 }, key, plain as Bytes));
  const out = new Uint8Array(NONCE_BYTES + ct.length);
  out.set(iv, 0);
  out.set(ct, NONCE_BYTES);
  return out;
}

/** 解密；钥匙、AAD、密文任一不对回 null（不抛、不说原因） */
export async function open(key: CryptoKey, aad: string, sealed: Uint8Array): Promise<Bytes | null> {
  if (sealed.length < NONCE_BYTES + 16) return null;
  try {
    const iv = sealed.slice(0, NONCE_BYTES);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad), tagLength: 128 }, key, sealed.slice(NONCE_BYTES) as Bytes);
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

/** 正文的 AAD（5.5） */
export function noteAad(userId: string, noteId: string, encKeyId: number): string {
  return `${userId}|${noteId}|${encKeyId}`;
}

/** 隐私记正文密文里的东西（代定 D7） */
export type NotePlain = { v: 1; title: string; body: string };

export async function sealNote(key: CryptoKey, userId: string, noteId: string, title: string, body: string, encKeyId = ENC_KEY_ID): Promise<Bytes> {
  const plain: NotePlain = { v: 1, title, body };
  return seal(key, noteAad(userId, noteId, encKeyId), utf8(JSON.stringify(plain)));
}

/** 解不开或内容不合格回 null */
export async function openNote(key: CryptoKey, userId: string, noteId: string, encKeyId: number, sealed: Uint8Array): Promise<NotePlain | null> {
  const pt = await open(key, noteAad(userId, noteId, encKeyId), sealed);
  if (!pt) return null;
  try {
    const v = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(pt)) as Partial<NotePlain>;
    if (v.v !== 1 || typeof v.title !== 'string' || typeof v.body !== 'string') return null;
    return { v: 1, title: v.title, body: v.body };
  } catch {
    return null;
  } finally {
    pt.fill(0);
  }
}

/** pin_hash：HMAC-SHA256(VAULT_PIN_PEPPER, user_id:pin) 的十六进制 */
export async function pinHash(pepper: Bytes, userId: string, pin: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', pepper, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, utf8(`${userId}:${pin}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 常数时间比较两个十六进制串（长度不同也跑完整个循环） */
export function hexEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
