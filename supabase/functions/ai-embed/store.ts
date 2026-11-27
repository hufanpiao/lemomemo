// ai-embed 的数据库查询（fn_ai，跑在 _shared/db.ts 的 withAiUser / withAiScan 事务里）。真库用例：见报告（这一批只在内存假库上测过 core）。
// 只用 fn_ai 已有的授权（0007、0001～0004 的列级授权，不新加）：
//   private.scan_embed_queue（跨用户只有 kind、source_id、model、user_id、next_at）；private.embed_queue（全部）；private.note_vectors（select、insert、update）；
//   public.notes (id, user_id, title, body, is_private, deleted_at)、events (title, note, location, deleted_at)、todos (title, note, deleted_at)、
//   note_images (id, note_id, bucket, deleted_at, ai_desc, ai_tags)、note_files (id, note_id, is_vault, name, text_excerpt, deleted_at, ai_desc, ai_tags)；
//   private.heartbeat（策略只放 ai-embed 等三个名字）。
import type { Tx } from '../_shared/db.ts';
import { vecLiteral } from '../_shared/ai/embed.ts';
import { keyOf, srcText, type EmbedKind, type QItem, type Src } from './core.ts';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strs = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);

/** 有到期队列项的人，随机挑 */
export async function dueUsers(tx: Tx, limit: number): Promise<string[]> {
  const rows = await tx`select user_id from private.scan_embed_queue group by user_id order by random() limit ${limit}`;
  return rows.map((r) => String(r['user_id']));
}

/** 这个人最早的到期队列项 */
export async function dueItems(tx: Tx, uid: string, limit: number): Promise<QItem[]> {
  const rows = await tx`select kind, source_id, model, queued_at::text as queued_at, tries from private.embed_queue
    where user_id = ${uid} and (next_at is null or next_at <= now()) order by queued_at limit ${limit}`;
  return rows.map((r) => ({
    kind: String(r['kind']) as EmbedKind, source_id: String(r['source_id']), model: String(r['model']),
    queued_at: String(r['queued_at']), tries: Number(r['tries']),
  }));
}

const idsOf = (items: readonly QItem[], kind: EmbedKind): string[] => items.filter((i) => i.kind === kind).map((i) => i.source_id);

/** 源头内容（见 core.ts 的 Src）；查不到的不放进 Map（core 当 gone） */
export async function sources(tx: Tx, uid: string, items: readonly QItem[]): Promise<Map<string, Src>> {
  const out = new Map<string, Src>();
  const put = (kind: EmbedKind, id: unknown, s: Src): void => void out.set(keyOf({ kind, source_id: String(id) }), s);
  const live = (r: Record<string, unknown>): boolean => r['deleted_at'] === null;
  const ids = { note: idsOf(items, 'note'), event: idsOf(items, 'event'), todo: idsOf(items, 'todo'), image: idsOf(items, 'image'), file: idsOf(items, 'file') };
  if (ids.note.length > 0) {
    for (const r of await tx`select id, title, body, is_private, deleted_at from public.notes where user_id = ${uid} and id = any(${ids.note}::uuid[])`) {
      put('note', r['id'], !live(r) ? { state: 'gone' } : r['is_private'] === true ? { state: 'vault' } : { state: 'ok', ...srcText.note(str(r['title']), str(r['body'])) });
    }
  }
  if (ids.event.length > 0) {
    for (const r of await tx`select id, title, note, location, deleted_at from public.events where user_id = ${uid} and id = any(${ids.event}::uuid[])`) {
      put('event', r['id'], live(r) ? { state: 'ok', ...srcText.event(str(r['title']), str(r['location']), str(r['note'])) } : { state: 'gone' });
    }
  }
  if (ids.todo.length > 0) {
    for (const r of await tx`select id, title, note, deleted_at from public.todos where user_id = ${uid} and id = any(${ids.todo}::uuid[])`) {
      put('todo', r['id'], live(r) ? { state: 'ok', ...srcText.todo(str(r['title']), str(r['note'])) } : { state: 'gone' });
    }
  }
  if (ids.image.length > 0) {
    const rows = await tx`select i.id, i.bucket, i.deleted_at, i.ai_desc, i.ai_tags, n.title as note_title, n.is_private, n.deleted_at as note_deleted
      from public.note_images i left join public.notes n on n.user_id = i.user_id and n.id = i.note_id
      where i.user_id = ${uid} and i.id = any(${ids.image}::uuid[])`;
    for (const r of rows) {
      const s: Src = !live(r) || r['note_deleted'] !== null ? { state: 'gone' }
        : r['bucket'] === 'vault-images' || r['is_private'] === true ? { state: 'vault' }
        : !str(r['ai_desc']) ? { state: 'empty' }
        : { state: 'ok', ...srcText.image(str(r['ai_desc']), strs(r['ai_tags']), str(r['note_title'])) };
      put('image', r['id'], s);
    }
  }
  if (ids.file.length > 0) {
    const rows = await tx`select f.id, f.is_vault, f.name, f.text_excerpt, f.ai_desc, f.ai_tags, f.deleted_at, n.deleted_at as note_deleted
      from public.note_files f left join public.notes n on n.user_id = f.user_id and n.id = f.note_id
      where f.user_id = ${uid} and f.id = any(${ids.file}::uuid[])`;
    for (const r of rows) {
      const s: Src = !live(r) || r['note_deleted'] !== null ? { state: 'gone' }
        : r['is_vault'] === true ? { state: 'vault' }
        : { state: 'ok', ...srcText.file(str(r['name']), str(r['text_excerpt']), str(r['ai_desc']), strs(r['ai_tags'])) };
      put('file', r['id'], s);
    }
  }
  return out;
}

export async function hashes(tx: Tx, uid: string, items: readonly QItem[], model: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (items.length === 0) return out;
  const rows = await tx`select kind, source_id, content_hash from private.note_vectors
    where user_id = ${uid} and model = ${model} and source_id = any(${items.map((i) => i.source_id)}::uuid[])`;
  for (const r of rows) out.set(keyOf({ kind: String(r['kind']), source_id: String(r['source_id']) }), String(r['content_hash']));
  return out;
}

/**
 * 取锁（和撤回同意、vault_ai_off 删向量互斥，0.27）→ 锁住 queued_at 没变的那条队列行（for update），锁不到就不写 → on conflict 覆盖。
 * 比 queued_at：读完内容以后又入队过（改了内容、移进隐私记，入队触发器会更新 queued_at）就不写旧内容的向量；
 * for update：移进隐私记的事务（vault toVault，不取 embed: 锁）还没提交时等它提交再判；先锁住的，它的触发器等这里写完，随后的 dropVectors 删掉这条。
 */
export async function writeVector(tx: Tx, uid: string, it: QItem, model: string, hash: string, vec: readonly number[]): Promise<boolean> {
  await tx`select pg_advisory_xact_lock(hashtext('embed:' || ${uid}::text))`;
  const held = await tx`select 1 as x from private.embed_queue where user_id = ${uid} and kind = ${it.kind} and source_id = ${it.source_id}
    and model = ${it.model} and queued_at::text = ${it.queued_at} for update`;
  if (held.length !== 1) return false;
  const fk = (k: EmbedKind): string | null => (it.kind === k ? it.source_id : null);
  const rows = await tx`insert into private.note_vectors
      (user_id, kind, source_id, is_vault, note_id, image_id, file_id, event_id, todo_id, model, content_hash, embedding, updated_at)
    select ${uid}, ${it.kind}, ${it.source_id}, false, ${fk('note')}, ${fk('image')}, ${fk('file')}, ${fk('event')}, ${fk('todo')},
           ${model}, ${hash}, ${vecLiteral(vec)}::extensions.halfvec, now()
    on conflict (kind, source_id, model) do update set content_hash = excluded.content_hash, embedding = excluded.embedding, updated_at = now()
    returning source_id`;
  return rows.length === 1;
}

/** 删队列行：只删 queued_at 没变的（处理中又改过的留着下一轮） */
export async function settleItems(tx: Tx, uid: string, items: readonly QItem[]): Promise<void> {
  for (const it of items) {
    await tx`delete from private.embed_queue where user_id = ${uid} and kind = ${it.kind} and source_id = ${it.source_id}
      and model = ${it.model} and queued_at::text = ${it.queued_at}`;
  }
}

export async function laterItems(tx: Tx, uid: string, items: readonly QItem[], atMs: number, bump: boolean): Promise<void> {
  for (const it of items) {
    await tx`update private.embed_queue set next_at = ${new Date(atMs).toISOString()}::timestamptz,
        tries = least(tries + ${bump ? 1 : 0}, 32000)
      where user_id = ${uid} and kind = ${it.kind} and source_id = ${it.source_id} and model = ${it.model}`;
  }
}

export async function writeHeartbeat(tx: Tx, detail: Record<string, number>): Promise<void> {
  await tx`insert into private.heartbeat (name, at, detail) values ('ai-embed', now(), ${tx.json(detail)})
    on conflict (name) do update set at = excluded.at, detail = excluded.detail`;
}
