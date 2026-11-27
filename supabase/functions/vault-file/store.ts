// vault-file 的数据库查询（fn_vault，跑在 _shared/db.ts 的 withVaultUser 事务里；app.uid = 本人，RLS 只放本人的行）。
// index.ts 只管组装；store-it 的 vault-file.it.ts 拿同一份 SQL 以 fn_vault 打真库。
// 用到的授权（0004、0006 已有，20261115010000 没加新的）：public.notes（select）、public.note_files（表级 select、insert、update）、
//   private.vault_preview（select、insert、delete）、private.scan_vault_preview（select，跨用户扫描，withVaultScan）。
// • SQL 一律 tx`…${参数}`，不拼字符串；notes、note_files 的 bigint 时刻本来就是毫秒，取出时 ::float8 免得变成字符串；
// • 写行的额度判断在库里：note_files_media_quota（存储额度，raise 'quota_exceeded'）、note_files_quota（行数上限，raise 'quota'），
//   这里归成 InsertResult 的 quota，别的错误原样抛（core 回 503 try_later）。
import type { Tx } from '../_shared/db.ts';
import type { FileRow, InsertResult, NewRow } from './core.ts';

const msOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const bytesOrNull = (v: unknown): Uint8Array | null => (v ? new Uint8Array(v as ArrayLike<number>) : null);

function fileRow(r: Record<string, unknown>): FileRow {
  return {
    id: String(r.id), note_id: String(r.note_id), kind: String(r.kind), bytes: Number(r.bytes), pages: msOrNull(r.pages),
    has_thumb: r.has_thumb === true, is_vault: r.is_vault === true, check_status: String(r.check_status), deleted_at: msOrNull(r.deleted_at),
    created_at: Number(r.created_at), sha256: String(r.sha256),
    name_enc: bytesOrNull(r.name_enc), text_enc: bytesOrNull(r.text_enc), dek_enc: bytesOrNull(r.dek_enc),
  };
}

const cols = (tx: Tx) => tx`id, note_id, kind, bytes, pages, has_thumb, is_vault, check_status, deleted_at::float8 as deleted_at,
  created_at::float8 as created_at, sha256, name_enc, text_enc, dek_enc`;

export async function privateNote(tx: Tx, uid: string, noteId: string): Promise<boolean> {
  const rows = await tx`select 1 as x from public.notes where user_id = ${uid} and id = ${noteId} and is_private and deleted_at is null`;
  return rows.length === 1;
}

export async function fileOf(tx: Tx, uid: string, id: string): Promise<FileRow | null> {
  const rows = await tx`select ${cols(tx)} from public.note_files where user_id = ${uid} and id = ${id}`;
  return rows[0] ? fileRow(rows[0]) : null;
}

export async function filesOf(tx: Tx, uid: string, noteId: string): Promise<FileRow[]> {
  const rows = await tx`select ${cols(tx)} from public.note_files
    where user_id = ${uid} and note_id = ${noteId} and is_vault and deleted_at is null and check_status = 'ok' order by id`;
  return rows.map(fileRow);
}

/** 写行：挂的随手记必须是本人没删的隐私记（同一句里核对）；同 id 已有回 exists；额度、行数上限回 quota */
export async function insertFile(tx: Tx, uid: string, r: NewRow, path: string): Promise<InsertResult> {
  try {
    // 放进保存点：触发器 raise 以后事务还能接着用（下面还要查一次、提交）
    const rows = await tx.savepoint((sp) => sp`insert into public.note_files (id, user_id, note_id, kind, path, has_thumb, is_vault, name, mime, bytes, sha256, pages,
        text_excerpt, name_enc, text_enc, dek_enc, enc_key_id, check_status, ai_status, skip_reason, created_at, updated_at)
      select ${r.id}, ${uid}, ${r.note_id}, ${r.kind}, ${path}, ${r.has_thumb}, true, null, ${r.mime}, ${r.bytes}, ${r.sha256}, ${r.pages},
        null, ${r.name_enc}, ${r.text_enc}, ${r.dek_enc}, ${r.enc_key_id}, 'ok', 'skip', 'vault_off', ${r.created_at}, ${r.created_at}
      where exists (select 1 from public.notes n where n.user_id = ${uid} and n.id = ${r.note_id} and n.is_private and n.deleted_at is null)
      on conflict (id) do nothing returning 1 as x`);
    if (rows.length === 1) return 'ok';
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (msg === 'quota_exceeded' || msg === 'quota') return 'quota';
    throw e;
  }
  const had = await tx`select 1 as x from public.note_files where id = ${r.id}`;
  return had.length === 1 ? 'exists' : 'no_note';
}

export async function setDeleted(tx: Tx, uid: string, id: string, at: number | null): Promise<boolean> {
  const rows = at === null
    ? await tx`update public.note_files set deleted_at = null where user_id = ${uid} and id = ${id} and is_vault and deleted_at is not null returning 1 as x`
    : await tx`update public.note_files set deleted_at = ${at} where user_id = ${uid} and id = ${id} and is_vault and deleted_at is null returning 1 as x`;
  return rows.length === 1;
}

export async function previewsOf(tx: Tx, uid: string): Promise<string[]> {
  const rows = await tx`select path from private.vault_preview where user_id = ${uid} order by path`;
  return rows.map((r) => String(r.path));
}

export async function registerPreview(tx: Tx, uid: string, path: string, fileId: string, expiresAt: number): Promise<void> {
  await tx`insert into private.vault_preview (path, user_id, file_id, expires_at) values (${path}, ${uid}, ${fileId}, ${new Date(expiresAt)})`;
}

export async function unregisterPreviews(tx: Tx, uid: string, paths: readonly string[]): Promise<void> {
  await tx`delete from private.vault_preview where user_id = ${uid}
    and path in (select jsonb_array_elements_text(${tx.json(paths as string[])}::jsonb))`;
}

/** 跨用户扫描（withVaultScan，不设 app.uid）：只经 private.scan_vault_preview（自带 expires_at <= now()） */
export async function expiredPreviews(tx: Tx): Promise<{ path: string; user_id: string }[]> {
  const rows = await tx`select path, user_id from private.scan_vault_preview order by expires_at limit 500`;
  return rows.map((r) => ({ path: String(r.path), user_id: String(r.user_id) }));
}
