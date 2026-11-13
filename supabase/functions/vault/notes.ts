// vault 的隐私记读写（架构 5.5、0.29 续第 121 条；B5 任务单 S5；TC-B5-08、17）：list、save、delete、undelete、purge。
// 都要有效令牌，跑在 core.ts 验令牌的同一个 fn_vault 事务里。
// • 正文：{v: 1, title, body} 用 VAULT_KEY 派生的 note 钥匙 AES-GCM 加密，AAD = user_id|note_id|enc_key_id（_shared/vault-crypto.ts，代定 D7）；
//   notes 的 title、body 列为空，category_id 照旧明文。
// • save：没有这条就新建，有就改（只改本人没删的隐私记；同 id 是普通随手记回 not_found，不让覆盖）；
//   add_images：**预登记**图片行（bucket vault-images、ai_status skip、skip_reason vault_off；行数上限和存储额度由 row_quota、media_quota_guard 触发器管），
//   客户端随后经 vault-image 上传对象——vault-image 只收已登记、没删的 image_id，原图字节数必须等于登记的 bytes（11-14 整块评审第 3 条，
//   和普通插图“先写行、/files 再按行核 content_length”同一口径；这里不再 HEAD R2，整块评审第 10 条随之没有了）；
//   同 id 已经有行：是这条、没删、字节数和有无缩略图都一样的算重发成功；对不上，或行在别的随手记、别人名下，一律 400 bad_request、什么都不写（整块评审第 12 条）；
//   remove_images：软删，事务提交后尽力删对象（整块评审第 2 条）。
// • delete / undelete：软删和恢复；purge：private.purge_vault_impl，只删已软删的，回删了几条；图片行随外键级联，提交后尽力删对象。
// • 解不开的密文（钥匙换了、数据坏了）不回这一条，记一次 decrypt_failed，不让整张列表失败。
import { ENC_KEY_ID, openNote, sealNote } from '../_shared/vault-crypto.ts';
import { type Ctx, err, type ImageAdd, imageKeys, noteKey, type Out, out, type ReqOf, StoreDataError, type VaultTx } from './common.ts';

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

/**
 * add_images 里哪几张要新登记：这条已有同 id 的行时，没删、字节数和有无缩略图都一样的算重发（跳过），对不上回 400。
 * 在写正文之前判，回 400 时什么都没写
 */
async function toRegister(t: VaultTx, noteId: string, exists: boolean, add: readonly ImageAdd[]): Promise<ImageAdd[] | Response> {
  const mine = exists ? await t.imagesOf(noteId) : [];
  const fresh: ImageAdd[] = [];
  for (const img of add) {
    const cur = mine.find((x) => x.id === img.id);
    if (!cur) fresh.push(img);
    else if (cur.bucket !== 'vault-images' || cur.deleted_at !== null || cur.bytes !== img.bytes || cur.has_thumb !== img.has_thumb) return err(400, 'bad_request');
  }
  return fresh;
}

/** {save, id, title, body, category_id, created_at, updated_at, add_images?, remove_images?} */
export async function save(c: Ctx, t: VaultTx, r: ReqOf<'save'>): Promise<Out | Response> {
  const cur = await t.note(r.id);
  if (cur && (!cur.is_private || cur.deleted_at !== null)) return err(404, 'not_found');
  const add = r.add_images?.length ? await toRegister(t, r.id, cur !== null, r.add_images) : [];
  if (add instanceof Response) return add;
  const body_enc = await sealNote(await noteKey(c), c.userId, r.id, r.title, r.body, ENC_KEY_ID);
  if (cur) {
    if (!(await t.updatePrivateNote(r.id, { body_enc, enc_key_id: ENC_KEY_ID, category_id: r.category_id, updated_at: r.updated_at }))) return err(404, 'not_found');
  } else {
    await t.insertPrivateNote({ id: r.id, body_enc, enc_key_id: ENC_KEY_ID, category_id: r.category_id, created_at: r.created_at, updated_at: r.updated_at });
  }
  // 同 id 的行在别的随手记或别人名下（RLS 看不见）：插不进就抛数据错误，整个事务回滚、回 400（不静默成功）
  for (const img of add) if (!(await t.insertVaultImage(r.id, img))) throw new StoreDataError('data');
  if (r.remove_images?.length) {
    for (const img of await t.removeVaultImages(r.id, r.remove_images, c.deps.now())) c.drop.push(...imageKeys(c, r.id, img));
  }
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

/** {purge, items}：永久删除（只删本人已软删的隐私记；图片行随外键级联，提交后尽力删 R2 对象，删不掉的留给 storage-sweep） */
export async function purge(c: Ctx, t: VaultTx, r: ReqOf<'purge'>): Promise<Out> {
  const ids = new Set(r.items);
  const before = (await t.vaultImages()).filter((i) => ids.has(i.note_id));
  const purged = await t.purge(r.items);
  if (purged > 0 && before.length > 0) {
    const left = new Set((await t.vaultImages()).map((i) => i.id));
    for (const img of before) if (!left.has(img.id)) c.drop.push(...imageKeys(c, img.note_id, img));
  }
  return out({ purged }, null);
}
