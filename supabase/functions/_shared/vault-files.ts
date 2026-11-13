// 隐私记文档附件的加密和几个固定值（架构 5.13 第 11 点、ADR-014；B4b-1）：vault-file（上传、读取、预览）和 vault 的移进移出（move.ts）共用这一份。
// • 每个文件一把随机的数据密钥（DEK，32 字节）：AES-256-GCM 加密文件本体、缩略图、文件名、抽出的文字；
//   DEK 用 VAULT_KEY 按人派生的子密钥（vault-crypto.ts 的 aesKeyFor(…, 'note')，15.2 低 8 一次定好的三个用途之一）包起来，存进 note_files.dek_enc。
// • AAD 带用途标记（0.23，第五轮安全轻 3）：user_id|file_id|file、|thumb、|name、|text、|dek。两段密文互相调换时解密失败。
// • 隐私记行的 sha256 不存明文哈希：存 HMAC-SHA256(HKDF(VAULT_KEY, user_id, 'file-sha'), 明文 sha256 的小写十六进制串) 的小写十六进制。
// • 存法：nonce(12) ‖ 密文 ‖ 标签(16)（vault-crypto.ts 的 seal），对象一律 application/octet-stream（清单 vault-files 的 allowedMimeTypes）。
// 纯函数，只 import vault-crypto.ts，不 import npm 包、不碰 Deno 全局（Vitest 直接测）；不打印、不抛带内容的错误。
import { aesKeyFor, hmacKeyFor, open, seal } from './vault-crypto.ts';

type Bytes = Uint8Array<ArrayBuffer>;

/** 隐私记附件的桶（R2）；普通附件在 files */
export const VAULT_FILE_BUCKET = 'vault-files';
export const PLAIN_FILE_BUCKET = 'files';
/** 密文对象的内容类型（put 时显式写，TC-B0-75） */
export const CIPHER_TYPE = 'application/octet-stream';

export type FilePart = 'file' | 'thumb' | 'name' | 'text' | 'dek';
export const fileAad = (userId: string, fileId: string, part: FilePart): string => `${userId}|${fileId}|${part}`;

const enc = new TextEncoder();

export function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(b: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)));
}

/** 隐私记行里存的 sha256：HMAC(file-sha 子密钥, 明文 sha256 十六进制) */
export async function shaMac(master: Bytes, userId: string, plainShaHex: string): Promise<string> {
  const k = await hmacKeyFor(master, userId);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(plainShaHex))));
}

/** 一把数据密钥：raw 只在内存里（移进时并发补救要用），key 不可导出 */
export interface Dek { raw: Bytes; key: CryptoKey }

async function importDek(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function newDek(): Promise<Dek> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return { raw, key: await importDek(raw) };
}

/** 包起来存进 dek_enc */
export async function wrapDek(master: Bytes, userId: string, fileId: string, dek: Dek): Promise<Bytes> {
  return seal(await aesKeyFor(master, userId, 'note'), fileAad(userId, fileId, 'dek'), dek.raw);
}

/** 解开 dek_enc；钥匙、AAD、密文任一不对回 null */
export async function unwrapDek(master: Bytes, userId: string, fileId: string, dekEnc: Uint8Array): Promise<Dek | null> {
  const raw = await open(await aesKeyFor(master, userId, 'note'), fileAad(userId, fileId, 'dek'), dekEnc);
  if (!raw || raw.length !== 32) return null;
  return { raw, key: await importDek(raw) };
}

export function sealPart(dek: Dek, userId: string, fileId: string, part: Exclude<FilePart, 'dek'>, plain: Uint8Array): Promise<Bytes> {
  return seal(dek.key, fileAad(userId, fileId, part), plain);
}

export function openPart(dek: Dek, userId: string, fileId: string, part: Exclude<FilePart, 'dek'>, sealed: Uint8Array): Promise<Bytes | null> {
  return open(dek.key, fileAad(userId, fileId, part), sealed);
}

export const sealText = (dek: Dek, userId: string, fileId: string, part: 'name' | 'text', s: string): Promise<Bytes> =>
  sealPart(dek, userId, fileId, part, enc.encode(s));

/** 解开文件名或文字；解不开、不是 UTF-8 回 null */
export async function openText(dek: Dek, userId: string, fileId: string, part: 'name' | 'text', sealed: Uint8Array): Promise<string | null> {
  const b = await openPart(dek, userId, fileId, part, sealed);
  if (!b) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b);
  } catch {
    return null;
  }
}
