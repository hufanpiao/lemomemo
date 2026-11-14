// ai-media 的数据库查询（fn_ai，跑在 _shared/db.ts 的 withAiUser / withAiScan 事务里；真库用例 supabase/tests/store-it/ai-media-store.it.ts）。
// 只用 fn_ai 已有的授权（0003、0007，不新加）：
//   private.scan_note_images（跨用户只有 id、user_id、ai_status、ai_next_at，只含 pending、没删的）；
//   public.note_images 读 (id, user_id, note_id, bucket, has_thumb, deleted_at, ai_status, ai_tries, ai_next_at)、
//     写 (ai_status, skip_reason, ai_desc, ai_tags, ai_tries, ai_next_at)；public.notes 读 (id, user_id, is_private, deleted_at)；
//   private.heartbeat（策略 fn_ai_own 只放 ai-embed、ai-media、file-check）。
// 写一律带条件 ai_status = 'pending'：处理中被移进隐私记（vault 函数改成 skip / vault_off）、被重新识别改过的，不覆盖。
import type { Tx } from '../_shared/db.ts';
import type { Heartbeat, MediaItem } from './core.ts';

/** 有到期 pending 图片的人，随机挑 */
export async function dueUsers(tx: Tx, limit: number, nowMs: number): Promise<string[]> {
  const rows = await tx`select user_id from private.scan_note_images
    where ai_next_at is null or ai_next_at <= ${nowMs} group by user_id order by random() limit ${limit}`;
  return rows.map((r) => String(r['user_id']));
}

/** 这个人最早的到期 pending 图片（id 是 uuidv7，按 id 排就是按插入先后） */
export async function dueItems(tx: Tx, uid: string, limit: number, nowMs: number): Promise<MediaItem[]> {
  const rows = await tx`select i.id, i.note_id, i.bucket, i.has_thumb, i.ai_tries, n.is_private, n.deleted_at as note_deleted, n.id as nid
      from public.note_images i left join public.notes n on n.user_id = i.user_id and n.id = i.note_id
     where i.user_id = ${uid} and i.ai_status = 'pending' and i.deleted_at is null and (i.ai_next_at is null or i.ai_next_at <= ${nowMs})
     order by i.id limit ${limit}`;
  return rows.map((r) => ({
    id: String(r['id']), note_id: String(r['note_id']), bucket: String(r['bucket']), has_thumb: r['has_thumb'] === true,
    tries: Number(r['ai_tries']), note_private: r['is_private'] === true, note_gone: r['nid'] === null || r['note_deleted'] !== null,
  }));
}

export async function laterItems(tx: Tx, uid: string, ids: readonly string[], atMs: number, bump: boolean): Promise<void> {
  if (ids.length === 0) return;
  await tx`update public.note_images set ai_next_at = ${atMs}, ai_tries = least(ai_tries + ${bump ? 1 : 0}, 32000)
    where user_id = ${uid} and id = any(${ids}::uuid[]) and ai_status = 'pending'`;
}

export async function parkAll(tx: Tx, uid: string, atMs: number): Promise<void> {
  await tx`update public.note_images set ai_next_at = ${atMs}
    where user_id = ${uid} and ai_status = 'pending' and deleted_at is null and (ai_next_at is null or ai_next_at < ${atMs})`;
}

/** 没同意 / 关了 AI：这个人全部 pending 的普通图片（隐私记的不动，ai.vault 另管）写 skip / consent */
export async function skipConsent(tx: Tx, uid: string): Promise<string[]> {
  const rows = await tx`update public.note_images set ai_status = 'skip', skip_reason = 'consent', ai_next_at = null
    where user_id = ${uid} and ai_status = 'pending' and bucket = 'images' and deleted_at is null returning id`;
  return rows.map((r) => String(r['id']));
}

/** 刚写的 skip / consent 改回 pending（写完再查发现已经同意了：查和写之间触发器 ai_consent_resume 已经跑过） */
export async function unskip(tx: Tx, uid: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx`update public.note_images set ai_status = 'pending', skip_reason = null
    where user_id = ${uid} and id = any(${ids}::uuid[]) and ai_status = 'skip' and skip_reason = 'consent'`;
}

export async function skipOther(tx: Tx, uid: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx`update public.note_images set ai_status = 'skip', skip_reason = 'other', ai_next_at = null
    where user_id = ${uid} and id = any(${ids}::uuid[]) and ai_status = 'pending'`;
}

export async function failItem(tx: Tx, uid: string, id: string, tries: number): Promise<void> {
  await tx`update public.note_images set ai_status = 'failed', ai_tries = ${tries}, ai_next_at = null
    where user_id = ${uid} and id = ${id} and ai_status = 'pending'`;
}

export async function doneItem(tx: Tx, uid: string, id: string, desc: string, tags: readonly string[]): Promise<boolean> {
  const rows = await tx`update public.note_images set ai_status = 'done', ai_desc = ${desc}, ai_tags = ${tags as string[]}::text[],
      skip_reason = null, ai_next_at = null
    where user_id = ${uid} and id = ${id} and ai_status = 'pending' and bucket = 'images' and deleted_at is null returning id`;
  return rows.length === 1;
}

export async function writeHeartbeat(tx: Tx, detail: Heartbeat): Promise<void> {
  await tx`insert into private.heartbeat (name, at, detail) values ('ai-media', now(), ${tx.json(detail)})
    on conflict (name) do update set at = excluded.at, detail = excluded.detail`;
}
