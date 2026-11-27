// file-check 的数据库查询（fn_ai，跑在 _shared/db.ts 的 withAiUser / withAiScan 事务里；store-it 拿同一份 SQL 打真库）。
// 只用到 fn_ai 的列级授权：public.note_files 的 id、user_id、note_id、kind、bytes、sha256、has_thumb、is_vault、deleted_at、check_status、created_at
//   （sha256、created_at 由迁移 20261115000000 补授权）；写只写 check_status、etag；
//   private.scan_note_files（跨用户只有定位列，20261115000000 加了 is_vault、created_at）；private.heartbeat（策略只放 file-check 等三个名字）。
// retry_ai（B4b-2 识图）：public.note_images 读 (id, user_id, bucket, deleted_at, ai_status)、写 (ai_status, skip_reason, ai_tries, ai_next_at)（0003 已给 fn_ai）。
import type { Tx } from '../_shared/db.ts';
import type { AiStatus, FileRow } from './core.ts';

function rowOf(r: Record<string, unknown>): FileRow {
  return {
    id: String(r['id']), user_id: String(r['user_id']), note_id: String(r['note_id']), kind: String(r['kind']) as FileRow['kind'],
    bytes: Number(r['bytes']), sha256: String(r['sha256']), has_thumb: r['has_thumb'] === true, is_vault: r['is_vault'] === true,
    deleted_at: r['deleted_at'] === null ? null : Number(r['deleted_at']), check_status: String(r['check_status']) as FileRow['check_status'],
    created_at: Number(r['created_at']),
  };
}

/** 本人的一行（app.uid = 本人，RLS 只放本人的） */
export async function fileRow(tx: Tx, uid: string, id: string): Promise<FileRow | null> {
  const rows = await tx`select id, user_id, note_id, kind, bytes, sha256, has_thumb, is_vault, deleted_at, check_status, created_at
    from public.note_files where user_id = ${uid} and id = ${id}`;
  const r = rows[0];
  return r ? rowOf(r) : null;
}

/** 补扫的定位：pending、普通、没删、created_at 早于 before 的 (user_id, id) */
export async function staleIds(tx: Tx, before: number, limit: number): Promise<{ user_id: string; id: string }[]> {
  // 随机挑（整块评审第 1 条）：按 created_at 取最早的 50 行时，原文件还不在（24 小时内只回 incomplete、状态不变）、账号停用（跳过）的行
  //   每轮都占着名额，攒够 50 行后更新的 pending 永远轮不到；随机挑每轮换一批，不用另记游标或重试次数
  const rows = await tx`select user_id, id from private.scan_note_files
    where check_status = 'pending' and not is_vault and created_at < ${before} order by random() limit ${limit}`;
  return rows.map((r) => ({ user_id: String(r.user_id), id: String(r.id) }));
}

/** 带条件写回（只在还是 pending 时写）；回写成没有 */
export async function settleRow(tx: Tx, row: FileRow, status: 'ok' | 'rejected', etag: string | null): Promise<boolean> {
  const rows = await tx`update public.note_files set check_status = ${status}, etag = ${etag}
    where user_id = ${row.user_id} and id = ${row.id} and check_status = 'pending' returning id`;
  return rows.length === 1;
}

export async function writeHeartbeat(tx: Tx, detail: Record<string, number>): Promise<void> {
  await tx`insert into private.heartbeat (name, at, detail) values ('file-check', now(), ${tx.json(detail)})
    on conflict (name) do update set at = excluded.at, detail = excluded.detail`;
}

/** 重新识别：本人普通插图（images 桶、没删）failed → pending、ai_tries 清零；回改完以后的状态，没有这张回 null */
export async function retryAi(tx: Tx, uid: string, id: string): Promise<AiStatus | null> {
  const rows = await tx`with r as (
      update public.note_images set ai_status = 'pending', skip_reason = null, ai_tries = 0, ai_next_at = null
       where user_id = ${uid} and id = ${id} and bucket = 'images' and deleted_at is null and ai_status = 'failed' returning ai_status)
    select ai_status from r
    union all
    select ai_status from public.note_images
     where user_id = ${uid} and id = ${id} and bucket = 'images' and deleted_at is null and not exists (select 1 from r)`;
  const s = rows[0]?.['ai_status'];
  return s === 'pending' || s === 'done' || s === 'skip' || s === 'failed' ? s : null;
}
