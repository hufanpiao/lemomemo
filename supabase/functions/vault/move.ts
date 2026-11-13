// vault 的移进、移出（架构 5.5、5.13 第 11 点；B5 任务单 S5 后半、代定 D13；B4b-1 带文档附件；TC-B5-42、TC-B0-75）：
//   {import, note_id} 普通随手记 → 隐私记，{export, note_id} 反过来。
// 三步做，R2 和数据库不在一个事务里，顺序保证任何一步断了都不丢数据：
//   ① 准备（一个短事务，读完就提交）：核对这条、列出图片和文档附件；有没删、还在检查（check_status pending）的附件回 503 try_later
//      （file-check 还没做完，等它定了再搬；B4b-1 起不再回 409 has_files）；
//   ② 复制对象：
//      • 图片（和缩略图）从旧桶读出、写进新桶——put 一律显式写 contentType 'image/webp'（TC-B0-75），带 If-None-Match，
//        对象已经在（上次做到一半）算成功；
//      • 附件移进：每个文件一把新的数据密钥（_shared/vault-files.ts），原文件和缩略图加密写进 vault-files（application/octet-stream，
//        **不带** If-None-Match：密钥每次都是新的，旧的半截对象必须盖掉；和 vault-file 上传同一做法），文件名、抽出的文字也加密，
//        sha256 换成 HMAC（明文哈希行里本来就有，不用读对象）；
//      • 附件移出：解开数据密钥，解密原文件、核对 HMAC(sha256(明文)) 和行里的一致（不一致记 move_integrity、回 try_later，不写坏数据），
//        写回 files（contentType 用 kind 对应的 MIME，带 If-None-Match，已经在算成功），sha256 换回明文哈希；
//      旧桶里本来就没有的对象（坏行、已清理）跳过、记一次 move_missing_src（移出时原文件不在，sha256 只能写 64 个 0）；
//   ③ 一个事务提交：重新读这条（期间被改过就用新内容；图片或附件变了回 try_later 让客户端重试），写密文或明文、换图片行的桶、
//      改附件行（is_vault、明文列和密文列、sha256、AI 状态）、删旧向量和 vault_ai（图片和附件的都删）；
//      提交失败就删掉②写进新桶的对象（尽力而为）；提交成功再删旧桶的对象（失败只记日志，对象留着由每日清理收）。
//   ③ 发现这条已经是目标状态（同一条并发搬了两次，另一次先提交）：回 404，但**不删**②写的对象——另一次在②里碰到“对象已经在”算成功，
//      它提交后指着的正是这些对象（11-14 独立评审 S2）。附件移进不带 If-None-Match，我们这次可能把另一次已经提交的对象盖成了
//      我们自己的密钥：按已提交行的数据密钥把我们写过的对象重封一遍（repair，同 vault-file 上传撞 id 的做法）。
//   ③ 抛错时先另开短事务看一眼，已经是目标状态就照上面补救、不删；看不了都不删（宁可留垃圾）。
// 令牌由 core.ts 在进来之前单独验过；这里自己开事务，不占着 core 的事务做网络请求。
// 日志只记结果码（move_missing_src、move_integrity、move_cleanup_failed、move_repair_failed、decrypt_failed），不记文件名、路径、内容。
import { ENC_KEY_ID, openNote, sealNote } from '../_shared/vault-crypto.ts';
import { IMAGE_TYPE, isExists, VAULT_IMAGE_BUCKET } from '../_shared/vault-images.ts';
import {
  CIPHER_TYPE, type Dek, newDek, openPart, openText, PLAIN_FILE_BUCKET, sealPart, sealText, sha256Hex, shaMac, unwrapDek, VAULT_FILE_BUCKET,
  wrapDek,
} from '../_shared/vault-files.ts';
import {
  type Ctx, err, type FileRow, type FileToPlain, type FileToVault, imageKeys, type ImageRow, noteKey, type NoteRow, type Obj, type Out, out,
  type ReqOf, type VaultTx,
} from './common.ts';

type Bucket = ImageRow['bucket'];
type Dir = { from: Bucket; to: Bucket; fileFrom: string; fileTo: string; wantPrivate: boolean };
const IMPORT: Dir = { from: 'images', to: VAULT_IMAGE_BUCKET, fileFrom: PLAIN_FILE_BUCKET, fileTo: VAULT_FILE_BUCKET, wantPrivate: false };
const EXPORT: Dir = { from: VAULT_IMAGE_BUCKET, to: 'images', fileFrom: VAULT_FILE_BUCKET, fileTo: PLAIN_FILE_BUCKET, wantPrivate: true };
const ZERO_SHA = '0'.repeat(64);

/** 一个桶里的一个对象 */
interface Loc { bucket: string; key: string }
/** ③ 前算好的附件改法；移进的还带这次的数据密钥和写过的对象（并发补救用） */
interface FilePlan { id: string; vault?: FileToVault; plain?: FileToPlain; dek?: Dek; wrote: { key: string; part: 'file' | 'thumb' }[] }

class Retry extends Error {}
class Integrity extends Error {}

/**
 * 一条随手记全部图片在某个桶里的对象键（缩略图有才算）。已软删的行也算：③ 换桶时这条的图片行一律换（含已删的），
 * 对象也得跟着搬，否则行指新桶、对象留在旧桶（11-14 整块评审第 7 条）；对象已经不在（已清理、隐私记删图时已删）的，② 记 move_missing_src 跳过
 */
const keysFor = (c: Ctx, noteId: string, imgs: readonly ImageRow[]): string[] => imgs.flatMap((i) => imageKeys(c, noteId, i));

/** 一个附件的对象键：原文件，有缩略图再加缩略图（files、vault-files 同一个拼法） */
function fileKeys(c: Ctx, f: FileRow): { key: string; part: 'file' | 'thumb' }[] {
  const k: { key: string; part: 'file' | 'thumb' }[] = [{ key: c.deps.rules.fileKey(c.userId, f.note_id, f.id, f.kind), part: 'file' }];
  if (f.has_thumb) k.push({ key: c.deps.rules.fileThumbKey(c.userId, f.note_id, f.id), part: 'thumb' });
  return k;
}

async function readAll(body: unknown): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
}

/** 写一个对象；带 If-None-Match 时对象已经在算成功、不记进 written */
async function putTracked(r2: Obj, written: Loc[], loc: Loc, body: Uint8Array, contentType: string, ifNoneMatch: boolean): Promise<void> {
  try {
    await r2.put(loc.bucket, loc.key, body, ifNoneMatch ? { contentType, ifNoneMatch: true } : { contentType });
    written.push(loc);
  } catch (e) {
    if (!ifNoneMatch || !isExists(e)) throw e;
  }
}

/** ② 复制图片 */
async function copyImages(c: Ctx, r2: Obj, d: Dir, keys: readonly string[], written: Loc[]): Promise<void> {
  for (const key of keys) {
    const src = await r2.get(d.from, key);
    if (!src) {
      c.deps.log('move_missing_src');
      continue;
    }
    await putTracked(r2, written, { bucket: d.to, key }, await readAll(src.body), IMAGE_TYPE, true);
  }
}

/** ② 移进一个附件：新数据密钥加密对象、文件名、文字 */
async function fileIn(c: Ctx, r2: Obj, f: FileRow, written: Loc[]): Promise<FilePlan> {
  const { master } = c.keys;
  const dek = await newDek();
  const plan: FilePlan = { id: f.id, dek, wrote: [] };
  for (const k of fileKeys(c, f)) {
    const src = await r2.get(PLAIN_FILE_BUCKET, k.key);
    if (!src) {
      c.deps.log('move_missing_src');
      continue;
    }
    await putTracked(r2, written, { bucket: VAULT_FILE_BUCKET, key: k.key }, await sealPart(dek, c.userId, f.id, k.part, await readAll(src.body)), CIPHER_TYPE, false);
    plan.wrote.push(k);
  }
  plan.vault = {
    sha256: await shaMac(master, c.userId, f.sha256),
    name_enc: await sealText(dek, c.userId, f.id, 'name', f.name ?? ''),
    text_enc: f.text_excerpt === null || f.text_excerpt === '' ? null : await sealText(dek, c.userId, f.id, 'text', f.text_excerpt),
    dek_enc: await wrapDek(master, c.userId, f.id, dek),
    enc_key_id: ENC_KEY_ID,
  };
  return plan;
}

/** ② 移出一个附件：解密对象、核对 HMAC、写回 files；文件名、文字解出来 */
async function fileOut(c: Ctx, r2: Obj, f: FileRow, written: Loc[]): Promise<FilePlan> {
  const { master } = c.keys;
  const dek = f.dek_enc ? await unwrapDek(master, c.userId, f.id, f.dek_enc) : null;
  const name = dek && f.name_enc ? await openText(dek, c.userId, f.id, 'name', f.name_enc) : null;
  const text = dek && f.text_enc ? await openText(dek, c.userId, f.id, 'text', f.text_enc) : null;
  if (!dek || !name || (f.text_enc && text === null)) throw new Integrity('decrypt_failed');
  let sha = ZERO_SHA;
  for (const k of fileKeys(c, f)) {
    const src = await r2.get(VAULT_FILE_BUCKET, k.key);
    if (!src) {
      c.deps.log('move_missing_src');
      continue;
    }
    const plain = await openPart(dek, c.userId, f.id, k.part, await readAll(src.body));
    if (!plain) throw new Integrity('decrypt_failed');
    if (k.part === 'file') {
      sha = await sha256Hex(plain);
      if ((await shaMac(master, c.userId, sha)) !== f.sha256) throw new Integrity('move_integrity');
    }
    await putTracked(r2, written, { bucket: PLAIN_FILE_BUCKET, key: k.key }, plain, k.part === 'file' ? c.deps.rules.docMime(f.kind) : IMAGE_TYPE, true);
  }
  return { id: f.id, plain: { sha256: sha, name, text_excerpt: text }, wrote: [] };
}

const sameImages = (a: readonly ImageRow[], b: readonly ImageRow[]) =>
  a.length === b.length && a.every((x) => b.some((y) => y.id === x.id && y.deleted_at === x.deleted_at && y.has_thumb === x.has_thumb));

const sameFiles = (a: readonly FileRow[], b: readonly FileRow[]) =>
  a.length === b.length && a.every((x) => b.some((y) =>
    y.id === x.id && y.deleted_at === x.deleted_at && y.has_thumb === x.has_thumb && y.is_vault === x.is_vault && y.check_status === x.check_status));

/** 没删、还在检查的附件：等 file-check 定了再搬 */
const pending = (fs: readonly FileRow[]) => fs.some((f) => f.deleted_at === null && f.check_status === 'pending');

/** ③ 里写这条：移进写密文，移出写明文；0 行回 false */
async function writeNote(c: Ctx, t: VaultTx, n: NoteRow, d: Dir): Promise<boolean | Response> {
  const key = await noteKey(c);
  const at = c.deps.now();
  if (!d.wantPrivate) return t.toVault(n.id, await sealNote(key, c.userId, n.id, n.title ?? '', n.body ?? '', ENC_KEY_ID), ENC_KEY_ID, at);
  const p = n.body_enc && n.enc_key_id !== null ? await openNote(key, c.userId, n.id, n.enc_key_id, n.body_enc) : null;
  if (!p) {
    c.deps.log('decrypt_failed');
    return err(503, 'try_later');
  }
  return t.toPlain(n.id, p.title === '' ? null : p.title, p.body, at);
}

/** 按桶分组删；失败只记日志 */
async function dropQuietly(c: Ctx, r2: Obj, locs: readonly Loc[]): Promise<void> {
  const byBucket = new Map<string, string[]>();
  for (const l of locs) byBucket.set(l.bucket, [...(byBucket.get(l.bucket) ?? []), l.key]);
  for (const [bucket, keys] of byBucket) {
    try {
      await r2.deleteMany(bucket, keys);
    } catch {
      c.deps.log('move_cleanup_failed');
    }
  }
}

/** 这条已经在目标那一边了（另一次搬家先提交了） */
const moved = (n: NoteRow | null, d: Dir): boolean => n !== null && n.is_private !== d.wantPrivate;

/**
 * 移进时另一次先提交了：我们写过的 vault-files 对象可能把它的盖掉了。按已提交行的数据密钥检查一遍，
 * 用它的密钥解不开、用我们的解得开的，重封成它的密钥写回去。出错只记日志
 */
async function repair(c: Ctx, r2: Obj, noteId: string, plans: readonly FilePlan[]): Promise<void> {
  const mine = plans.filter((p) => p.dek && p.wrote.length > 0);
  if (mine.length === 0) return;
  try {
    const rows = await c.deps.tx(c.userId, (t) => t.filesOf(noteId));
    for (const p of mine) {
      const r = rows.find((x) => x.id === p.id);
      const theirs = r && r.is_vault && r.dek_enc ? await unwrapDek(c.keys.master, c.userId, p.id, r.dek_enc) : null;
      if (!theirs || !p.dek) continue;
      for (const k of p.wrote) {
        const obj = await r2.get(VAULT_FILE_BUCKET, k.key);
        if (!obj) continue;
        const sealed = await readAll(obj.body);
        if (await openPart(theirs, c.userId, p.id, k.part, sealed)) continue;
        const plain = await openPart(p.dek, c.userId, p.id, k.part, sealed);
        if (plain) await r2.put(VAULT_FILE_BUCKET, k.key, await sealPart(theirs, c.userId, p.id, k.part, plain), { contentType: CIPHER_TYPE });
      }
    }
  } catch {
    c.deps.log('move_repair_failed');
  }
}

/** ③ 抛错后的回滚：另开短事务确认这条不在目标那一边才删②写的对象；已经在目标那一边就补救；确认不了也不删 */
async function rollback(c: Ctx, r2: Obj, d: Dir, noteId: string, written: readonly Loc[], plans: readonly FilePlan[]): Promise<void> {
  if (written.length === 0) return;
  let done: boolean;
  try {
    done = moved(await c.deps.tx(c.userId, (t) => t.note(noteId)), d);
  } catch {
    c.deps.log('move_cleanup_failed');
    return;
  }
  if (done) return repair(c, r2, noteId, plans);
  await dropQuietly(c, r2, written);
}

async function move(c: Ctx, noteId: string, d: Dir, epoch: number): Promise<Out | Response> {
  const { deps } = c;
  const r2 = deps.r2;
  if (!r2) throw new Error('misconfigured');
  // ① 准备
  const prep = await deps.tx(c.userId, async (t) => {
    const n = await t.note(noteId);
    if (!n || n.is_private !== d.wantPrivate || n.deleted_at !== null) return err(404, 'not_found');
    const files = await t.filesOf(noteId);
    if (pending(files)) return err(503, 'try_later');
    return { imgs: await t.imagesOf(noteId), files };
  });
  if (prep instanceof Response) return prep;
  const keys = keysFor(c, noteId, prep.imgs);
  // ②
  const written: Loc[] = [];
  const plans: FilePlan[] = [];
  try {
    await copyImages(c, r2, d, keys, written);
    for (const f of prep.files) plans.push(await (d.wantPrivate ? fileOut : fileIn)(c, r2, f, written));
  } catch (e) {
    await dropQuietly(c, r2, written);   // 还没碰库：我们写的只有我们自己用（移出带 If-None-Match，已经在的没记进来）
    if (e instanceof Integrity) {
      deps.log(e.message);
      return err(503, 'try_later');
    }
    throw e;
  }
  // ③
  let res: Out | Response | 'moved';
  try {
    res = await deps.tx(c.userId, async (t) => {
      const n = await t.note(noteId);
      if (moved(n, d)) return 'moved' as const;
      if (!n || n.deleted_at !== null) return err(404, 'not_found');
      if (!sameImages(prep.imgs, await t.imagesOf(noteId))) return err(503, 'try_later');
      if (!sameFiles(prep.files, await t.filesOf(noteId))) return err(503, 'try_later');
      const at = deps.now();
      for (const p of plans) {
        const ok = p.vault ? await t.fileToVault(p.id, p.vault, at) : p.plain ? await t.fileToPlain(p.id, p.plain, at) : false;
        if (!ok) throw new Retry();   // 已经改了的几行要跟着回滚：抛错，不能 return（return 会提交）
      }
      const w = await writeNote(c, t, n, d);
      if (w instanceof Response) {
        if (plans.length > 0) throw new Retry();
        return w;
      }
      if (!w) {
        if (plans.length > 0) throw new Retry();
        return err(404, 'not_found');
      }
      await t.moveImages(noteId, d.to);
      await t.dropVectors(noteId);
      return out({}, epoch);
    });
  } catch (e) {
    await rollback(c, r2, d, noteId, written, plans);
    if (e instanceof Retry) return err(503, 'try_later');
    throw e;
  }
  if (res === 'moved') {
    await repair(c, r2, noteId, plans);
    return err(404, 'not_found');
  }
  if (res instanceof Response) {
    await dropQuietly(c, r2, written);
    return res;
  }
  const old: Loc[] = keys.map((key) => ({ bucket: d.from, key }));
  for (const f of prep.files) for (const k of fileKeys(c, f)) old.push({ bucket: d.fileFrom, key: k.key });
  await dropQuietly(c, r2, old);
  return res;
}

/** {import, note_id}：普通随手记移进隐私记（图片进 vault-images，附件加密进 vault-files） */
export const importNote = (c: Ctx, r: ReqOf<'import'>, epoch: number) => move(c, r.note_id, IMPORT, epoch);
/** {export, note_id}：隐私记移出成普通随手记（图片写回 images 桶，附件解密写回 files） */
export const exportNote = (c: Ctx, r: ReqOf<'export'>, epoch: number) => move(c, r.note_id, EXPORT, epoch);
