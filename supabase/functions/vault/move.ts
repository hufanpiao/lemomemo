// vault 的移进、移出（架构 5.5；B5 任务单 S5 后半、代定 D13；TC-B5-42、TC-B0-75）：{import, note_id} 普通随手记 → 隐私记，{export, note_id} 反过来。
// 三步做，R2 和数据库不在一个事务里，顺序保证任何一步断了都不丢数据：
//   ① 准备（一个短事务，读完就提交）：核对这条、带文档附件的回 409 has_files（B4b-1 放开）、列出图片；
//   ② 复制对象：每张图（和缩略图）从旧桶读出、写进新桶——put 一律显式写 contentType 'image/webp'（TC-B0-75），带 If-None-Match，
//      对象已经在（上次做到一半）算成功；旧桶里本来就没有的（坏行）跳过、记一次 move_missing_src；
//   ③ 一个事务提交：重新读这条（期间被改过就用新内容；图片变了回 try_later 让客户端重试），写密文或明文、换图片行的桶、删旧向量和 vault_ai；
//      提交失败就删掉②写进新桶的对象（尽力而为）；提交成功再删旧桶的对象（失败只记日志，对象留着由每日清理收）。
//   ③ 发现这条已经是目标状态（同一条并发搬了两次，另一次先提交）：回 404，但**不删**②写的对象——另一次在②里碰到“对象已经在”算成功，
//      它提交后指着的正是这些对象（11-14 独立评审 S2）。③ 抛错时先另开短事务看一眼，已经是目标状态或看不了都不删（宁可留垃圾）。
// 令牌由 core.ts 在进来之前单独验过；这里自己开事务，不占着 core 的事务做网络请求。
import { ENC_KEY_ID, aesKeyFor, openNote, sealNote } from '../_shared/vault-crypto.ts';
import { IMAGE_TYPE, isExists, VAULT_IMAGE_BUCKET } from '../_shared/vault-images.ts';
import { type Ctx, err, type ImageRow, type NoteRow, type Obj, type Out, out, type ReqOf, type VaultTx } from './common.ts';

type Bucket = ImageRow['bucket'];
type Dir = { from: Bucket; to: Bucket; wantPrivate: boolean };
const IMPORT: Dir = { from: 'images', to: VAULT_IMAGE_BUCKET, wantPrivate: false };
const EXPORT: Dir = { from: VAULT_IMAGE_BUCKET, to: 'images', wantPrivate: true };

/** 一条随手记全部图片在某个桶里的对象键（没删的；缩略图有才算） */
function keysFor(c: Ctx, noteId: string, imgs: readonly ImageRow[]): string[] {
  const k: string[] = [];
  for (const i of imgs) {
    if (i.deleted_at !== null) continue;
    k.push(c.deps.rules.imageKey(c.userId, noteId, i.id, 'full'));
    if (i.has_thumb) k.push(c.deps.rules.imageKey(c.userId, noteId, i.id, 'thumb'));
  }
  return k;
}

async function readAll(body: unknown): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
}

/** ② 复制；回写进新桶的键（提交失败时删） */
async function copy(c: Ctx, r2: Obj, d: Dir, keys: readonly string[]): Promise<string[]> {
  const written: string[] = [];
  for (const key of keys) {
    const src = await r2.get(d.from, key);
    if (!src) {
      c.deps.log('move_missing_src');
      continue;
    }
    try {
      await r2.put(d.to, key, await readAll(src.body), { contentType: IMAGE_TYPE, ifNoneMatch: true });
      written.push(key);
    } catch (e) {
      if (!isExists(e)) throw e;
    }
  }
  return written;
}

const sameImages = (a: readonly ImageRow[], b: readonly ImageRow[]) =>
  a.length === b.length && a.every((x) => b.some((y) => y.id === x.id && y.deleted_at === x.deleted_at && y.has_thumb === x.has_thumb));

/** ③ 里写这条：移进写密文，移出写明文；0 行回 false */
async function writeNote(c: Ctx, t: VaultTx, n: NoteRow, d: Dir): Promise<boolean | Response> {
  const key = await aesKeyFor(c.keys.master, c.userId, 'note');
  const at = c.deps.now();
  if (!d.wantPrivate) return t.toVault(n.id, await sealNote(key, c.userId, n.id, n.title ?? '', n.body ?? '', ENC_KEY_ID), ENC_KEY_ID, at);
  const p = n.body_enc && n.enc_key_id !== null ? await openNote(key, c.userId, n.id, n.enc_key_id, n.body_enc) : null;
  if (!p) {
    c.deps.log('decrypt_failed');
    return err(503, 'try_later');
  }
  return t.toPlain(n.id, p.title === '' ? null : p.title, p.body, at);
}

async function dropQuietly(c: Ctx, r2: Obj, bucket: Bucket, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await r2.deleteMany(bucket, keys);
  } catch {
    c.deps.log('move_cleanup_failed');
  }
}

/** 这条已经在目标那一边了（另一次搬家先提交了） */
const moved = (n: NoteRow | null, d: Dir): boolean => n !== null && n.is_private !== d.wantPrivate;

/** ③ 抛错后的回滚：另开短事务确认这条不在目标那一边才删②写的对象；确认不了也不删 */
async function rollback(c: Ctx, r2: Obj, d: Dir, noteId: string, written: readonly string[]): Promise<void> {
  if (written.length === 0) return;
  try {
    if (moved(await c.deps.tx(c.userId, (t) => t.note(noteId)), d)) return;
  } catch {
    c.deps.log('move_cleanup_failed');
    return;
  }
  await dropQuietly(c, r2, d.to, written);
}

async function move(c: Ctx, noteId: string, d: Dir, epoch: number): Promise<Out | Response> {
  const { deps } = c;
  const r2 = deps.r2;
  if (!r2) throw new Error('misconfigured');
  // ① 准备
  const prep = await deps.tx(c.userId, async (t) => {
    const n = await t.note(noteId);
    if (!n || n.is_private !== d.wantPrivate || n.deleted_at !== null) return err(404, 'not_found');
    if (await t.hasFiles(noteId)) return err(409, 'has_files');
    return { imgs: await t.imagesOf(noteId) };
  });
  if (prep instanceof Response) return prep;
  const keys = keysFor(c, noteId, prep.imgs);
  // ②
  const written = await copy(c, r2, d, keys);
  // ③
  let res: Out | Response | 'moved';
  try {
    res = await deps.tx(c.userId, async (t) => {
      const n = await t.note(noteId);
      if (moved(n, d)) return 'moved' as const;
      if (!n || n.deleted_at !== null) return err(404, 'not_found');
      if (await t.hasFiles(noteId)) return err(409, 'has_files');
      if (!sameImages(prep.imgs, await t.imagesOf(noteId))) return err(503, 'try_later');
      const w = await writeNote(c, t, n, d);
      if (w instanceof Response) return w;
      if (!w) return err(404, 'not_found');
      await t.moveImages(noteId, d.to);
      await t.dropVectors(noteId);
      return out({}, epoch);
    });
  } catch (e) {
    await rollback(c, r2, d, noteId, written);
    throw e;
  }
  if (res === 'moved') return err(404, 'not_found');
  if (res instanceof Response) {
    await dropQuietly(c, r2, d.to, written);
    return res;
  }
  await dropQuietly(c, r2, d.from, keys);
  return res;
}

/** {import, note_id}：普通随手记移进隐私记 */
export const importNote = (c: Ctx, r: ReqOf<'import'>, epoch: number) => move(c, r.note_id, IMPORT, epoch);
/** {export, note_id}：隐私记移出成普通随手记（图片写回 images 桶） */
export const exportNote = (c: Ctx, r: ReqOf<'export'>, epoch: number) => move(c, r.note_id, EXPORT, epoch);
