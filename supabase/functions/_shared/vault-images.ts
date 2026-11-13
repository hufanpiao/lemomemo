// 隐私记插图在 R2 上的几个固定值（架构 0.32、5.5；B5）：vault（save 核对、移进移出）、vault-image（上传、读取）共用这一份。
// 11-14 独立评审：桶名、内容类型、“对象已经在”的判断原来在 vault/notes.ts、vault/move.ts、vault/store.ts、vault-image/core.ts 各写一份。
// 对象键用 shared/schema/vault.ts 的 vaultImageKey（经 Deps.rules.imageKey / Deps.imageKey 注入），这里不另写。
// 纯常量和纯函数，不 import 任何东西，Vitest 直接测的 core.ts 可以引。

/** 隐私记插图的桶（清单里 vault-images；普通插图在 images） */
export const VAULT_IMAGE_BUCKET = 'vault-images';
/** 隐私记插图一律 webp，put 时显式写（TC-B0-75） */
export const IMAGE_TYPE = 'image/webp';

/** 隐私记用到的 R2 操作（_shared/gen/objstore.ts 的子集；vault 全用，vault-image 只用 get、put；测试用内存假 store） */
export interface VaultObj {
  get(bucket: string, key: string): Promise<{ body: unknown; contentLength: number | null } | null>;
  put(bucket: string, key: string, body: Uint8Array, opts: { contentType: string; ifNoneMatch?: boolean }): Promise<unknown>;
  head(bucket: string, key: string): Promise<{ contentLength: number | null } | null>;
  deleteMany(bucket: string, keys: readonly string[]): Promise<number>;
}

/** 隐私记插图缩略图的上限（和 private.media_row_bytes 预留的 128 KB、普通插图的 thumbSizeLimit 一致） */
export const VAULT_THUMB_MAX_BYTES = 131072;

/** objstore 的 put 带 If-None-Match、对象已经在时抛的错（code = 'exists'）：上次做到一半、客户端重试，都算成功 */
export const isExists = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'exists';
