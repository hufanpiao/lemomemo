// vault-image 的数据库查询（fn_ai，跑在 _shared/db.ts 的 withAiUser 事务里；app.uid = 本人，RLS 只放本人的行）。
// 从 index.ts 拆出来（11-14），store-it 的 vault-store.it.ts 拿同一份 SQL 打真库；index.ts 只管组装。
// pin_epoch 那一句在 _shared/vault-epoch.ts（和 account 共用）。只用到 fn_ai 的列级授权：private.vault (user_id, pin_epoch)、
//   public.note_images (id, user_id, note_id, bucket, has_thumb, deleted_at)，以及 bytes（迁移 20261114210000，整块评审第 3 条：上传按登记的字节数核对）。
import type { Tx } from '../_shared/db.ts';
import type { ImageMeta } from './core.ts';

/** 本人的一张没删的图（没有、已删回 null；11-14 整块评审第 9 条：已删的不能再取、再传） */
export async function imageMeta(tx: Tx, uid: string, imageId: string): Promise<ImageMeta | null> {
  const rows = await tx`select note_id, bucket, has_thumb, bytes from public.note_images where user_id = ${uid} and id = ${imageId} and deleted_at is null`;
  const r = rows[0];
  return r ? { note_id: String(r.note_id), bucket: String(r.bucket), has_thumb: r.has_thumb === true, bytes: Number(r.bytes) } : null;
}
