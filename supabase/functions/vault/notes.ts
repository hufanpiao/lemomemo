// vault 的隐私记读写（架构 5.5、0.29 续第 121 条；B5 任务单 S5；TC-B5-08、17）：list、save、delete、undelete、purge。
// 都要有效令牌，跑在 core.ts 验令牌的同一个 fn_vault 事务里。
// • 正文：{v: 1, title, body} 用 VAULT_KEY 派生的 note 钥匙 AES-GCM 加密，AAD = user_id|note_id|enc_key_id（_shared/vault-crypto.ts，代定 D7）；
//   notes 的 title、body 列为空，category_id 照旧明文。
// • save：没有这条就新建，有就改（只改本人没删的隐私记；同 id 是普通随手记回 not_found，不让覆盖）；
//   add_images：图已经经 vault-image 传到 R2，这里 HEAD 一下核对存在和大小，再写 note_images 行（bucket vault-images、ai_status skip、skip_reason vault_off）；
//   remove_images：软删（deleted_at = 现在），对象由每日清理收。
// • delete / undelete：软删和恢复；purge：private.purge_vault_impl，只删已软删的，回删了几条。
// • 解不开的密文（钥匙换了、数据坏了）不回这一条，记一次 decrypt_failed，不让整张列表失败。
import { ENC_KEY_ID, aesKeyFor, openNote, sealNote } from '../_shared/vault-crypto.ts';
import { type Ctx, err, keysOf, type Out, out, type ReqOf, type VaultTx } from './common.ts';

export const VAULT_BUCKET = 'vault-images';

async function noteKey(c: Ctx): Promise<CryptoKey> {
  const k = keysOf(c);
  if (!k) throw new Error('misconfigured');
  return aesKeyFor(k.master, c.userId, 'note');
}

/** {list}：本人全部隐私记（含已删，回收站要用）和它们的图片行 */
export async function list(c: Ctx, t: VaultTx): Promise<Out> {
  const key = await noteKey(c);
  const [notes, imgs] = await Promise.all([t.privateNotes(), t.vaultImages()]);
  const items: Record<string, unknown>[] = [];
  let bad = 0;
  for (const n of notes) {
    const p = n.body_enc && n.enc_key_id !== null ? await openNote(key, c.userId, n.id, n.enc_key_id, n.body_enc) : null;
    if (!p) {
      bad++;
      continue;
    }
    items.push({
      id: n.id, title: p.title, body: p.body, category_id: n.category_id, created_at: n.created_at, updated_at: n.updated_at,
      deleted_at: n.deleted_at,
      images: imgs.filter((i) => i.note_id === n.id).map((i) => ({
        id: i.id, has_thumb: i.has_thumb, width: i.width, height: i.height, bytes: i.bytes, deleted_at: i.deleted_at,
      })),
    });
  }
  if (bad > 0) c.deps.log('decrypt_failed');
  return out({ notes: items }, null);
}

/** add_images 的每一张都核对 R2 里真有（缩略图也核），大小不超；回实际大小。没配 R2 抛 misconfigured */
async function checkUploaded(c: Ctx, noteId: string, add: NonNullable<ReqOf<'save'>['add_images']>): Promise<Map<string, number> | Response> {
  const { r2, rules } = c.deps;
  if (!r2) throw new Error('misconfigured');
  const sizes = new Map<string, number>();
  for (const img of add) {
    const full = await r2.head(VAULT_BUCKET, rules.imageKey(c.userId, noteId, img.id, 'full'));
    if (!full) return err(404, 'not_found');
    const n = full.contentLength ?? img.bytes;
    if (n > rules.imageMaxBytes) return err(413, 'too_large');
    if (img.has_thumb && !(await r2.head(VAULT_BUCKET, rules.imageKey(c.userId, noteId, img.id, 'thumb')))) return err(404, 'not_found');
    sizes.set(img.id, n);
  }
  return sizes;
}

/** {save, id, title, body, category_id, created_at, updated_at, add_images?, remove_images?} */
export async function save(c: Ctx, t: VaultTx, r: ReqOf<'save'>): Promise<Out | Response> {
  const cur = await t.note(r.id);
  if (cur && (!cur.is_private || cur.deleted_at !== null)) return err(404, 'not_found');
  const add = r.add_images ?? [];
  const sizes = add.length > 0 ? await checkUploaded(c, r.id, add) : new Map<string, number>();
  if (sizes instanceof Response) return sizes;
  const body_enc = await sealNote(await noteKey(c), c.userId, r.id, r.title, r.body, ENC_KEY_ID);
  if (cur) {
    if (!(await t.updatePrivateNote(r.id, { body_enc, enc_key_id: ENC_KEY_ID, category_id: r.category_id, updated_at: r.updated_at }))) return err(404, 'not_found');
  } else {
    await t.insertPrivateNote({ id: r.id, body_enc, enc_key_id: ENC_KEY_ID, category_id: r.category_id, created_at: r.created_at, updated_at: r.updated_at });
  }
  for (const img of add) await t.insertVaultImage(r.id, { ...img, bytes: sizes.get(img.id) ?? img.bytes });
  if (r.remove_images && r.remove_images.length > 0) await t.removeVaultImages(r.id, r.remove_images, c.deps.now());
  return out({}, null);
}

/** {delete, id}：软删 */
export async function remove(c: Ctx, t: VaultTx, r: ReqOf<'delete'>): Promise<Out | Response> {
  return (await t.setPrivateDeleted(r.id, c.deps.now())) ? out({}, null) : err(404, 'not_found');
}

/** {undelete, id}：从回收站恢复 */
export async function undelete(t: VaultTx, r: ReqOf<'undelete'>): Promise<Out | Response> {
  return (await t.setPrivateDeleted(r.id, null)) ? out({}, null) : err(404, 'not_found');
}

/** {purge, items}：永久删除（只删本人已软删的隐私记；图片行随外键级联，R2 对象由每日清理收） */
export async function purge(t: VaultTx, r: ReqOf<'purge'>): Promise<Out> {
  return out({ purged: await t.purge(r.items) }, null);
}
