// vault-image 的数据库查询（fn_ai，跑在 _shared/db.ts 的 withAiUser 事务里；app.uid = 本人，RLS 只放本人的行）。
// 从 index.ts 拆出来（11-14），store-it 的 vault-store.it.ts 拿同一份 SQL 打真库；index.ts 只管组装。
// 只用到 fn_ai 的列级授权：private.vault (user_id, pin_epoch)、public.notes (id, user_id, is_private, deleted_at)、
//   public.note_images (id, user_id, note_id, bucket, has_thumb)。
import type { Tx } from '../_shared/db.ts';
import type { ImageMeta } from './core.ts';

/** 本人的 pin_epoch（没设过隐私记回 null）：vaultTokenChecker 比对令牌用 */
export async function pinEpoch(tx: Tx, uid: string): Promise<number | null> {
  const rows = await tx`select pin_epoch from private.vault where user_id = ${uid}`;
  return rows[0] ? Number(rows[0].pin_epoch) : null;
}

/** 这条是本人没删的隐私记 */
export async function ownsPrivateNote(tx: Tx, uid: string, noteId: string): Promise<boolean> {
  const rows = await tx`select 1 as x from public.notes where user_id = ${uid} and id = ${noteId} and is_private and deleted_at is null`;
  return rows.length === 1;
}

/** 本人的一张图（没有回 null） */
export async function imageMeta(tx: Tx, uid: string, imageId: string): Promise<ImageMeta | null> {
  const rows = await tx`select note_id, bucket, has_thumb from public.note_images where user_id = ${uid} and id = ${imageId}`;
  const r = rows[0];
  return r ? { note_id: String(r.note_id), bucket: String(r.bucket), has_thumb: r.has_thumb === true } : null;
}
