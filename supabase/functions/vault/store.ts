// vault 的数据库实现（VaultTx，common.ts）：跑在 _shared/db.ts 的 withVaultUser 事务里（fn_vault，app.uid = 本人，RLS 只放本人的行）。
// • SQL 一律 tx`…${参数}`，不拼字符串；数组参数一律转成 jsonb 传（prepare: false 下最稳）；
// • 时刻：timestamptz 列取出时换成毫秒（float8），写入时传 Date；notes、note_images 的 bigint 列本来就是毫秒，取出时 ::float8 免得变成字符串；
// • 出错原样抛，由 core.ts 经 common.ts 的 classifyDbError 归类（22、23 类 → 数据不合格，row_quota 的 'quota' → 超行数）。
// 线上只有 index.ts 用；Vitest 用内存假库，真库由 supabase/tests/store-it/vault-store.it.ts、vault-move.it.ts 以 fn_vault 跑本文件（11-14 起；B4b-1 加附件的移进移出）。
import type { Tx } from '../_shared/db.ts';
import { VAULT_IMAGE_BUCKET as VB } from '../_shared/vault-images.ts';
import { vaultImageKey } from '../_shared/gen/schema/vault.ts';
import { type CredRow, type FileRow, type ImageAdd, type ImageRow, type NoteRow, type VaultPatch, type VaultRow, type VaultTx } from './common.ts';

const msOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const dateOrNull = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms));
const bytes = (v: unknown): Uint8Array => new Uint8Array(v as ArrayLike<number>);

function note(r: Record<string, unknown>): NoteRow {
  return {
    id: String(r.id), is_private: r.is_private === true, deleted_at: msOrNull(r.deleted_at),
    title: (r.title ?? null) as string | null, body: (r.body ?? null) as string | null,
    body_enc: r.body_enc ? bytes(r.body_enc) : null, enc_key_id: msOrNull(r.enc_key_id),
    category_id: (r.category_id ?? null) as string | null, created_at: Number(r.created_at), updated_at: Number(r.updated_at),
  };
}

function image(r: Record<string, unknown>): ImageRow {
  return {
    id: String(r.id), note_id: String(r.note_id), bucket: r.bucket === VB ? VB : 'images', has_thumb: r.has_thumb === true,
    width: msOrNull(r.width), height: msOrNull(r.height), bytes: Number(r.bytes), deleted_at: msOrNull(r.deleted_at),
  };
}

function file(r: Record<string, unknown>): FileRow {
  const b = (v: unknown) => (v ? bytes(v) : null);
  return {
    id: String(r.id), note_id: String(r.note_id), kind: String(r.kind), has_thumb: r.has_thumb === true, is_vault: r.is_vault === true,
    check_status: String(r.check_status), deleted_at: msOrNull(r.deleted_at), sha256: String(r.sha256),
    name: (r.name ?? null) as string | null, text_excerpt: (r.text_excerpt ?? null) as string | null,
    name_enc: b(r.name_enc), text_enc: b(r.text_enc), dek_enc: b(r.dek_enc), enc_key_id: msOrNull(r.enc_key_id),
  };
}

export function vaultStore(tx: Tx, uid: string): VaultTx {
  const imgPath = (noteId: string, id: string) => vaultImageKey(uid, noteId, id, 'full');   // note_images.path 记原图的对象键
  const noteCols = () => tx`id, is_private, deleted_at::float8 as deleted_at, title, body, body_enc, enc_key_id, category_id,
    created_at::float8 as created_at, updated_at::float8 as updated_at`;
  const imgCols = () => tx`id, note_id, bucket, has_thumb, width, height, bytes, deleted_at::float8 as deleted_at`;
  const s: VaultTx = {
    async vault(lock) {
      const rows = lock
        ? await tx`select pin_hash, pin_epoch, fail_count, lock_level, (extract(epoch from locked_until) * 1000)::float8 as locked_until,
            (extract(epoch from last_reset_at) * 1000)::float8 as last_reset_at from private.vault where user_id = ${uid} for update`
        : await tx`select pin_hash, pin_epoch, fail_count, lock_level, (extract(epoch from locked_until) * 1000)::float8 as locked_until,
            (extract(epoch from last_reset_at) * 1000)::float8 as last_reset_at from private.vault where user_id = ${uid}`;
      const r = rows[0];
      if (!r) return null;
      return {
        pin_hash: String(r.pin_hash), pin_epoch: Number(r.pin_epoch), fail_count: Number(r.fail_count ?? 0), lock_level: Number(r.lock_level ?? 0),
        locked_until: msOrNull(r.locked_until), last_reset_at: msOrNull(r.last_reset_at),
      } satisfies VaultRow;
    },
    async insertVault(pinHash) {
      const rows = await tx`insert into private.vault (user_id, pin_hash) values (${uid}, ${pinHash}) on conflict (user_id) do nothing returning 1 as x`;
      return rows.length === 1;
    },
    async updateVault(p: VaultPatch) {
      const v: Record<string, unknown> = {};
      if (p.pin_hash !== undefined) v.pin_hash = p.pin_hash;
      if (p.pin_epoch !== undefined) v.pin_epoch = p.pin_epoch;
      if (p.fail_count !== undefined) v.fail_count = p.fail_count;
      if (p.lock_level !== undefined) v.lock_level = p.lock_level;
      if (p.locked_until !== undefined) v.locked_until = dateOrNull(p.locked_until);
      if (p.last_reset_at !== undefined) v.last_reset_at = dateOrNull(p.last_reset_at);
      const cols = Object.keys(v);
      if (cols.length === 0) return;
      await tx`update private.vault set ${tx(v, ...cols)} where user_id = ${uid}`;
    },
    async dropCredentialsAndSecrets() {
      await tx`delete from private.vault_credentials where user_id = ${uid}`;
      await tx`delete from private.device_secrets where user_id = ${uid}`;
    },
    async credentials() {
      const rows = await tx`select credential_id, public_key, sign_count::float8 as sign_count, device_label from private.vault_credentials
        where user_id = ${uid} order by credential_id`;
      return rows.map((r): CredRow => ({ id: String(r.credential_id), public_key: bytes(r.public_key), sign_count: Number(r.sign_count), label: (r.device_label ?? null) as string | null }));
    },
    async credential(id) {
      const rows = await tx`select credential_id, public_key, sign_count::float8 as sign_count, device_label from private.vault_credentials
        where user_id = ${uid} and credential_id = ${id}`;
      const r = rows[0];
      return r ? { id: String(r.credential_id), public_key: bytes(r.public_key), sign_count: Number(r.sign_count), label: (r.device_label ?? null) as string | null } : null;
    },
    async insertCredential(c) {
      const rows = await tx`insert into private.vault_credentials (credential_id, user_id, public_key, sign_count, device_label)
        values (${c.id}, ${uid}, ${c.public_key}, ${c.sign_count}, ${c.label}) on conflict (credential_id) do nothing returning 1 as x`;
      return rows.length === 1;
    },
    async setSignCount(id, n) {
      await tx`update private.vault_credentials set sign_count = ${n} where user_id = ${uid} and credential_id = ${id}`;
    },
    async deleteCredential(id) {
      const rows = await tx`delete from private.vault_credentials where user_id = ${uid} and credential_id = ${id} returning 1 as x`;
      return rows.length === 1;
    },
    async putChallenge(challenge, expiresAt) {
      await tx`insert into private.webauthn_challenges (challenge, user_id, expires_at) values (${challenge}, ${uid}, ${new Date(expiresAt)})`;
    },
    async takeChallenge(challenge) {
      const rows = await tx`delete from private.webauthn_challenges where user_id = ${uid} and challenge = ${challenge}
        returning (extract(epoch from expires_at) * 1000)::float8 as exp`;
      return rows[0] ? Number(rows[0].exp) : null;
    },
    async privateNotes() {
      const rows = await tx`select ${noteCols()} from public.notes where user_id = ${uid} and is_private order by created_at, id`;
      return rows.map(note);
    },
    async note(id) {
      const rows = await tx`select ${noteCols()} from public.notes where user_id = ${uid} and id = ${id}`;
      return rows[0] ? note(rows[0]) : null;
    },
    async vaultImages() {
      const rows = await tx`select ${imgCols()} from public.note_images where user_id = ${uid} and bucket = ${VB} order by id`;
      return rows.map(image);
    },
    async imagesOf(noteId) {
      const rows = await tx`select ${imgCols()} from public.note_images where user_id = ${uid} and note_id = ${noteId} order by id`;
      return rows.map(image);
    },
    async insertPrivateNote(n) {
      await tx`insert into public.notes (id, user_id, is_private, body_enc, enc_key_id, category_id, category_source, created_at, updated_at)
        values (${n.id}, ${uid}, true, ${n.body_enc}, ${n.enc_key_id}, ${n.category_id}, ${n.category_id ? 'manual' : 'none'}, ${n.created_at}, ${n.updated_at})`;
    },
    async updatePrivateNote(id, p) {
      const rows = await tx`update public.notes set body_enc = ${p.body_enc}, enc_key_id = ${p.enc_key_id}, category_id = ${p.category_id},
          updated_at = ${p.updated_at}
        where user_id = ${uid} and id = ${id} and is_private and deleted_at is null returning 1 as x`;
      return rows.length === 1;
    },
    async setPrivateDeleted(id, at) {
      const rows = await tx`update public.notes set deleted_at = ${at} where user_id = ${uid} and id = ${id} and is_private returning 1 as x`;
      return rows.length === 1;
    },
    async insertVaultImage(noteId, img: ImageAdd) {
      const rows = await tx`insert into public.note_images (id, user_id, note_id, bucket, path, bytes, width, height, has_thumb, ai_status, skip_reason)
        values (${img.id}, ${uid}, ${noteId}, ${VB}, ${imgPath(noteId, img.id)}, ${img.bytes}, ${img.width}, ${img.height}, ${img.has_thumb}, 'skip', 'vault_off')
        on conflict (id) do nothing returning 1 as x`;
      return rows.length === 1;
    },
    async removeVaultImages(noteId, ids, at) {
      const rows = await tx`update public.note_images set deleted_at = ${at}
        where user_id = ${uid} and note_id = ${noteId} and bucket = ${VB} and deleted_at is null
          and id in (select (jsonb_array_elements_text(${tx.json(ids as string[])}::jsonb))::uuid)
        returning ${imgCols()}`;
      return rows.map(image);
    },
    async purge(ids) {
      const rows = await tx`select private.purge_vault_impl(${uid}::uuid, ${tx.json(ids.map((id) => ({ id })))}::jsonb) as n`;
      return Number(rows[0]?.n ?? 0);
    },
    async filesOf(noteId) {
      const rows = await tx`select id, note_id, kind, has_thumb, is_vault, check_status, deleted_at::float8 as deleted_at, sha256, name, text_excerpt,
          name_enc, text_enc, dek_enc, enc_key_id
        from public.note_files where user_id = ${uid} and note_id = ${noteId} order by id`;
      return rows.map(file);
    },
    async fileToVault(id, p, updatedAt) {
      const rows = await tx`update public.note_files set is_vault = true, name = null, text_excerpt = null, ai_desc = null, ai_tags = '{}',
          ai_status = 'skip', skip_reason = 'vault_off', ai_next_at = null,
          name_enc = ${p.name_enc}, text_enc = ${p.text_enc}, dek_enc = ${p.dek_enc}, enc_key_id = ${p.enc_key_id}, sha256 = ${p.sha256},
          updated_at = ${updatedAt}
        where user_id = ${uid} and id = ${id} and not is_vault returning 1 as x`;
      return rows.length === 1;
    },
    async fileToPlain(id, p, updatedAt) {
      const rows = await tx`update public.note_files set is_vault = false, name = ${p.name}, text_excerpt = ${p.text_excerpt},
          name_enc = null, text_enc = null, dek_enc = null, enc_key_id = null, sha256 = ${p.sha256},
          ai_status = 'pending', skip_reason = null, ai_tries = 0, ai_next_at = null, updated_at = ${updatedAt}
        where user_id = ${uid} and id = ${id} and is_vault returning 1 as x`;
      return rows.length === 1;
    },
    async toVault(id, bodyEnc, encKeyId, updatedAt) {
      const rows = await tx`update public.notes set is_private = true, body_enc = ${bodyEnc}, enc_key_id = ${encKeyId}, title = null, body = null,
          raw_text = '', tags = '{}', ai_meta = null, converted_to = null, updated_at = ${updatedAt}
        where user_id = ${uid} and id = ${id} and not is_private and deleted_at is null returning 1 as x`;
      return rows.length === 1;
    },
    async toPlain(id, title, body, updatedAt) {
      const rows = await tx`update public.notes set is_private = false, body_enc = null, enc_key_id = null, title = ${title}, body = ${body},
          updated_at = ${updatedAt}
        where user_id = ${uid} and id = ${id} and is_private and deleted_at is null returning 1 as x`;
      return rows.length === 1;
    },
    async moveImages(noteId, to) {
      if (to === VB) {
        await tx`update public.note_images set bucket = ${VB}, taken_at = null, ai_desc = null, ai_tags = '{}', ai_status = 'skip', skip_reason = 'vault_off',
            ai_next_at = null where user_id = ${uid} and note_id = ${noteId}`;
      } else {
        await tx`update public.note_images set bucket = 'images', ai_status = 'pending', skip_reason = null, ai_tries = 0, ai_next_at = null
          where user_id = ${uid} and note_id = ${noteId}`;
      }
    },
    async dropVectors(noteId) {
      // file_id 要 fn_vault 的列级 select（迁移 20261115010000，B4b-1）
      await tx`delete from private.note_vectors where user_id = ${uid}
        and (note_id = ${noteId} or image_id in (select id from public.note_images where user_id = ${uid} and note_id = ${noteId})
          or file_id in (select id from public.note_files where user_id = ${uid} and note_id = ${noteId}))`;
      await tx`delete from private.vault_ai where user_id = ${uid}
        and (image_id in (select id from public.note_images where user_id = ${uid} and note_id = ${noteId})
          or file_id in (select id from public.note_files where user_id = ${uid} and note_id = ${noteId}))`;
    },
  };
  return s;
}
