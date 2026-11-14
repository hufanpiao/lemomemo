// vault-file：隐私记的文档附件（架构 5.13 第 11 点、第 6 节 vault-file 行；B4b-1）。请求、响应、错误码见 shared/schema/vault-file.ts。
// 纯逻辑，依赖由 index.ts 注入，Vitest 直接测（tests/edge/vault-file.test.ts）；store.ts 的 SQL 由 store-it 打真库。
// • 鉴权：cron 的 {action: sweep} 只认 x-cron-secret（_shared/http.ts 的 cronGate）；其余一律 JWT（requireActiveUser）→ 每人每分钟 30 次
//   （vault-file-min:<uid>:<UTC 分钟>）→ x-vault-token（只验、不续，同 vault-image）；ms_preview 另算每人每小时 20 次（vault-file-msp:<uid>:<UTC 小时>）。
// • upload（multipart）：先看 Content-Length、边读边计数（≤ VAULT_FILE_UPLOAD_MAX_BODY）→ meta、bytes、sha256、缩略图（≤ 128 KB、RIFF????WEBP）
//   → 本人没删的隐私记、同 id 没有行 → file-sniff 判类型 = kind、ZIP 家族真实解压计数（zipBombCheck）→ 一把随机数据密钥加密文件、缩略图、
//   文件名（sanitizeFileName 清理后）、文字，数据密钥用 VAULT_KEY 子密钥包起来（_shared/vault-files.ts）→ 写 R2 vault-files（显式 contentType）
//   → 写 note_files 行（is_vault、check_status = ok、sha256 存 HMAC；额度由写行触发器判）。
//   写对象不带 If-None-Match：同 id 的上一次中途断了留下的对象直接盖掉；和同 id 的另一次并发上传撞上（写行时行已经在）时，
//   按已提交那一行的数据密钥把对象重新加密写一遍（内容相同才写，见 repair），免得对象和行的密钥对不上。写行失败、行也不在就删掉刚写的对象。
// • get：解密后直接回字节（no-store、nosniff）；full 时核对 HMAC(sha256)，对不上 500 corrupt。
// • ms_preview：先删这个人之前的预览 → 生成随机路径 → 先登记 private.vault_preview → 再写 vault-preview（Supabase Storage）→ 签名链接；
//   中途失败尽力删对象和登记。ms_preview_end：删对象和登记。
// • sweep：删过期登记的对象和登记；再删桶里早于“链接有效期 + 2 分钟”的对象（没登记的、或登记已过期的；没过期的登记一定比这年轻，
//   因为先登记再写对象，所以不会误删正在用的预览）；写心跳 vault-file-sweep。
// 日志只经 deps.log 记码，不记文件名、路径、签名链接、内容。
import { readAll, readCapped, readJsonCapped } from '../_shared/body.ts';
import type { AuthResult } from '../_shared/auth-result.ts';
import { cronGate, errorResponder, json, NO_STORE } from '../_shared/http.ts';
import { utcHourKey, utcMinuteKey } from '../_shared/rate-key.ts';
import { ENC_KEY_ID } from '../_shared/vault-crypto.ts';
import {
  CIPHER_TYPE, type Dek, hex, newDek, openPart, openText, sealPart, sealText, sha256Hex, shaMac, unwrapDek, VAULT_FILE_BUCKET as BUCKET, wrapDek,
} from '../_shared/vault-files.ts';
import { IMAGE_TYPE, isWebp } from '../_shared/vault-images.ts';
import { VAULT_TOKEN_HEADER, type VaultTokenVerdict } from '../_shared/vault-token.ts';

type Bytes = Uint8Array<ArrayBuffer>;

// 请求、判型结果只写这里用到的形状，不引 _shared/gen 下的 schema（带 npm:zod，Vitest 的 tsc 解析不了）；
//   index.ts 把 shared/schema/vault-file.ts 的 zod 解析接进来时，deno check 按这里的形状核对
/** 同 shared/schema/attachments.ts 的 REJECT_REASONS */
export type RejectReason = 'unknown' | 'too_big' | 'bad_archive' | 'encrypted';
export type Part = 'full' | 'thumb';
export type Req =
  | { action: 'list'; note_id: string }
  | { action: 'get'; id: string; part?: Part | undefined }
  | { action: 'remove'; id: string }
  | { action: 'restore'; id: string }
  | { action: 'ms_preview'; id: string }
  | { action: 'ms_preview_end' }
  | { action: 'sweep' };
export interface Meta { id: string; note_id: string; kind: string; name: string; sha256: string; bytes: number; pages: number | null; text: string | null }
type SniffResult = { ok: true; kind: string } | { ok: false; reason: Exclude<RejectReason, 'too_big'> };

/** fn_vault 读到的一行（只用到这些列）；时刻毫秒 */
export interface FileRow {
  id: string; note_id: string; kind: string; bytes: number; pages: number | null; has_thumb: boolean; is_vault: boolean;
  check_status: string; deleted_at: number | null; created_at: number; sha256: string;
  name_enc: Uint8Array | null; text_enc: Uint8Array | null; dek_enc: Uint8Array | null;
}
/** 要写的新行（user_id、path 由 store 按 uid 和清单拼法补） */
export interface NewRow {
  id: string; note_id: string; kind: string; mime: string; bytes: number; pages: number | null; has_thumb: boolean;
  sha256: string; name_enc: Bytes; text_enc: Bytes | null; dek_enc: Bytes; enc_key_id: number; created_at: number;
}
export type InsertResult = 'ok' | 'exists' | 'no_note' | 'quota';

export interface Store {
  /** 本人、没删的隐私记 */
  privateNote(uid: string, noteId: string): Promise<boolean>;
  /** 本人的一行（含已删、含普通的）；没有回 null */
  file(uid: string, id: string): Promise<FileRow | null>;
  /** 本人这条随手记里 is_vault、没删、check_status = ok 的行，按 id 排 */
  files(uid: string, noteId: string): Promise<FileRow[]>;
  /** 同一句里核对挂的是本人没删的隐私记；同 id 已有回 exists；超了存储额度或行数上限回 quota */
  insert(uid: string, row: NewRow): Promise<InsertResult>;
  /** 只改本人 is_vault 的行：at 为数字时只改没删的，null 时只改已删的；改到 0 行回 false */
  setDeleted(uid: string, id: string, at: number | null): Promise<boolean>;
  /** 这个人现在登记着的预览路径 */
  previews(uid: string): Promise<string[]>;
  register(uid: string, path: string, fileId: string, expiresAt: number): Promise<void>;
  unregister(uid: string, paths: readonly string[]): Promise<void>;
  /** 跨用户：已过期的登记（private.scan_vault_preview） */
  expired(): Promise<{ path: string; user_id: string }[]>;
  heartbeat(detail: Record<string, number>): Promise<void>;
}

/** vault-preview 桶（Supabase Storage，service role） */
export interface Preview {
  /** contentType 由调用处当场写出（TC-B0-75、check_backend F14） */
  put(path: string, body: Uint8Array, opts: { contentType: string }): Promise<void>;
  /** 签名链接，回同源相对地址 /sb/storage/v1/object/sign/vault-preview/…?token=… */
  sign(path: string, ttlS: number): Promise<string>;
  remove(paths: readonly string[]): Promise<void>;
  /** 桶里的对象和建立时刻（毫秒） */
  list(): Promise<{ name: string; created_at: number }[]>;
}

export interface Obj {
  get(bucket: string, key: string): Promise<{ body: unknown; contentLength: number | null } | null>;
  put(bucket: string, key: string, body: Uint8Array, opts: { contentType: string; ifNoneMatch?: boolean }): Promise<unknown>;
  deleteMany(bucket: string, keys: readonly string[]): Promise<number>;
}

/** shared 里的常量和纯函数（index.ts 从 _shared/gen 注入，测试注入 shared 原件） */
export interface Rules {
  parse(v: unknown): Req | null;
  parseMeta(v: unknown): Meta | null;
  sniff(b: Uint8Array): Promise<SniffResult>;
  /** zipBombCheck：只对 ZIP 家族有意义，别的回 ok */
  bomb(b: Uint8Array): Promise<{ ok: boolean }>;
  sanitizeName(raw: string, kind: string): string;
  mime(kind: string): string;
  fileKey(uid: string, noteId: string, id: string, kind: string): string;
  thumbKey(uid: string, noteId: string, id: string): string;
  maxBytes: number;
  thumbMaxBytes: number;
  uploadMaxBody: number;
  ratePerMin: number;
  previewPerHour: number;
  previewTtlS: number;
}

export interface Deps {
  authenticate(req: Request): Promise<AuthResult>;
  takeRate(key: string, limit: number, windowS: number): Promise<boolean>;
  checkToken(userId: string, token: string | null): Promise<{ verdict: VaultTokenVerdict }>;
  cronSecret: string | undefined;
  /** VAULT_KEY（解不出 32 字节就是 null，用到时回 try_later） */
  master: Bytes | null;
  rules: Rules;
  store: Store | null;
  r2: Obj | null;
  preview: Preview | null;
  random(n: number): Uint8Array;
  now(): number;
  log(code: string): void;
}

type Code =
  | 'vault_locked' | 'vault_relock' | 'not_found' | 'exists' | 'too_large' | 'rejected' | 'quota_exceeded' | 'rate_limited' | 'bad_request'
  | 'corrupt' | 'try_later' | 'method_not_allowed';
const err = errorResponder<Code>();

/** 桶里早于“链接有效期 + 这么久”的预览对象一律删（见文件头） */
export const STRAY_GRACE_MS = 2 * 60_000;
const JSON_MAX_BODY = 1024;
const PREVIEW_KIND = 'pptx';

interface Ctx { uid: string; deps: Deps; rules: Rules; store: Store; r2: Obj; master: Bytes }

async function blobBytes(v: FormDataEntryValue | null): Promise<Uint8Array | null> {
  if (v === null || typeof v === 'string') return null;
  return new Uint8Array(await v.arrayBuffer());
}

const rejected = (reason: RejectReason) => err(422, 'rejected', { reason });

/** 对象键：原文件，有缩略图再加缩略图 */
function keysOf(c: Ctx, noteId: string, id: string, kind: string, thumb: boolean): string[] {
  const k = [c.rules.fileKey(c.uid, noteId, id, kind)];
  if (thumb) k.push(c.rules.thumbKey(c.uid, noteId, id));
  return k;
}

/** 用这把数据密钥加密原文件（和缩略图）写进 vault-files */
async function putObjects(c: Ctx, m: Meta, dek: Dek, file: Uint8Array, thumb: Uint8Array | null): Promise<void> {
  await c.r2.put(BUCKET, c.rules.fileKey(c.uid, m.note_id, m.id, m.kind), await sealPart(dek, c.uid, m.id, 'file', file), { contentType: CIPHER_TYPE });
  if (thumb) await c.r2.put(BUCKET, c.rules.thumbKey(c.uid, m.note_id, m.id), await sealPart(dek, c.uid, m.id, 'thumb', thumb), { contentType: CIPHER_TYPE });
}

/** 同 id 并发上传撞上：已提交那一行内容相同（HMAC 一样）时，按它的数据密钥把对象重写一遍；内容不同不动（记码） */
async function repair(c: Ctx, m: Meta, mac: string, file: Uint8Array, thumb: Uint8Array | null): Promise<void> {
  const r = await c.store.file(c.uid, m.id);
  const dek = r && r.is_vault && r.sha256 === mac && r.dek_enc ? await unwrapDek(c.master, c.uid, m.id, r.dek_enc) : null;
  if (!r || !dek) {
    c.deps.log('upload_conflict');
    return;
  }
  await putObjects(c, m, dek, file, r.has_thumb ? thumb : null);
}

const item = (r: Pick<FileRow, 'id' | 'note_id' | 'kind' | 'bytes' | 'pages' | 'has_thumb' | 'created_at'>, name: string) => ({
  id: r.id, note_id: r.note_id, kind: r.kind, name, bytes: r.bytes, pages: r.pages, has_thumb: r.has_thumb, created_at: r.created_at,
});

async function upload(c: Ctx, req: Request): Promise<Response> {
  const { rules, store, deps } = c;
  const raw = await readCapped(req, rules.uploadMaxBody);
  if (raw === 'too_large') return err(413, 'too_large');
  if (raw === 'empty') return err(400, 'bad_request');
  let form: FormData;
  try {
    form = await new Response(raw as Bytes, { headers: { 'content-type': req.headers.get('content-type') ?? '' } }).formData();
  } catch {
    return err(400, 'bad_request');
  }
  const metaRaw = form.get('meta');
  let metaJson: unknown;
  try {
    metaJson = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : undefined;
  } catch {
    metaJson = undefined;
  }
  const m = rules.parseMeta(metaJson);
  const file = await blobBytes(form.get('file'));
  if (!m || !file) return err(400, 'bad_request');
  if (file.length > rules.maxBytes) return err(413, 'too_large');
  if (file.length !== m.bytes || (await sha256Hex(file)) !== m.sha256) return err(400, 'bad_request');
  const thumbV = form.get('thumb');
  const thumb = thumbV === null ? null : await blobBytes(thumbV);
  if (thumbV !== null && !thumb) return err(400, 'bad_request');
  if (thumb && thumb.length > rules.thumbMaxBytes) return err(413, 'too_large');
  if (thumb && !isWebp(thumb)) return err(400, 'bad_request');
  if (!(await store.privateNote(c.uid, m.note_id))) return err(404, 'not_found');
  if (await store.file(c.uid, m.id)) return err(409, 'exists');
  // 服务器明文在手，类型检查完整做一遍：签名和 [Content_Types].xml、带密码的 OLE2 外壳、ZIP 家族每个条目真的解压计数
  const s = await rules.sniff(file);
  if (!s.ok) return rejected(s.reason);
  if (s.kind !== m.kind) return rejected('unknown');
  if (!(await rules.bomb(file)).ok) return rejected('bad_archive');

  const dek = await newDek();
  const mac = await shaMac(c.master, c.uid, m.sha256);
  const name = rules.sanitizeName(m.name, m.kind);
  const now = deps.now();
  const row: NewRow = {
    id: m.id, note_id: m.note_id, kind: m.kind, mime: rules.mime(m.kind), bytes: m.bytes, pages: m.pages, has_thumb: thumb !== null,
    sha256: mac, name_enc: await sealText(dek, c.uid, m.id, 'name', name),
    text_enc: m.text === null || m.text === '' ? null : await sealText(dek, c.uid, m.id, 'text', m.text),
    dek_enc: await wrapDek(c.master, c.uid, m.id, dek), enc_key_id: ENC_KEY_ID, created_at: now,
  };
  const keys = keysOf(c, m.note_id, m.id, m.kind, thumb !== null);
  const dropOurs = async () => {
    try {
      await c.r2.deleteMany(BUCKET, keys);
    } catch {
      deps.log('upload_cleanup_failed');
    }
  };
  await putObjects(c, m, dek, file, thumb);
  let res: InsertResult;
  try {
    res = await store.insert(c.uid, row);
  } catch (e) {
    // 写行抛错：行不在才删对象（看不了也不删，宁可留给孤儿清理）
    try {
      if (!(await store.file(c.uid, m.id))) await dropOurs();
    } catch {
      deps.log('upload_cleanup_failed');
    }
    throw e;
  }
  if (res === 'exists') {
    await repair(c, m, mac, file, thumb);
    return err(409, 'exists');
  }
  if (res !== 'ok') {
    // 触发器先于冲突判断：额度、随手记不在时，同 id 的另一次也可能已经写成了
    if (await store.file(c.uid, m.id)) {
      await repair(c, m, mac, file, thumb);
      return err(409, 'exists');
    }
    await dropOurs();
    return res === 'quota' ? err(403, 'quota_exceeded') : err(404, 'not_found');
  }
  deps.log('upload_ok');
  return json(200, { ok: true, file: item(row, name) }, NO_STORE);
}

/** 读出并解密一个对象；对象不在回 'missing'，解不开回 null */
async function decrypted(c: Ctx, r: FileRow, part: Part): Promise<Bytes | 'missing' | null> {
  const key = part === 'thumb' ? c.rules.thumbKey(c.uid, r.note_id, r.id) : c.rules.fileKey(c.uid, r.note_id, r.id, r.kind);
  const obj = await c.r2.get(BUCKET, key);
  if (!obj) return 'missing';
  const dek = r.dek_enc ? await unwrapDek(c.master, c.uid, r.id, r.dek_enc) : null;
  if (!dek) return null;
  const plain = await openPart(dek, c.uid, r.id, part === 'thumb' ? 'thumb' : 'file', await readAll(obj.body));
  if (!plain || part === 'thumb') return plain;
  // 原文件：核对 HMAC(sha256)（架构 5.13 第 11 点：核对由 vault-file 在函数里做）
  return (await shaMac(c.master, c.uid, await sha256Hex(plain))) === r.sha256 ? plain : null;
}

/** 本人 is_vault、没删、通过检查的一行 */
async function liveFile(c: Ctx, id: string): Promise<FileRow | null> {
  const r = await c.store.file(c.uid, id);
  return r && r.is_vault && r.deleted_at === null && r.check_status === 'ok' ? r : null;
}

async function get(c: Ctx, id: string, part: Part): Promise<Response> {
  const r = await liveFile(c, id);
  if (!r || (part === 'thumb' && !r.has_thumb)) return err(404, 'not_found');
  const plain = await decrypted(c, r, part);
  if (plain === 'missing') return err(404, 'not_found');
  if (!plain) {
    c.deps.log('decrypt_failed');
    return err(500, 'corrupt');
  }
  return new Response(plain, {
    status: 200,
    headers: { 'content-type': part === 'thumb' ? IMAGE_TYPE : c.rules.mime(r.kind), 'x-content-type-options': 'nosniff', 'content-length': String(plain.length), ...NO_STORE },
  });
}

async function list(c: Ctx, noteId: string): Promise<Response> {
  if (!(await c.store.privateNote(c.uid, noteId))) return err(404, 'not_found');
  const out = [];
  for (const r of await c.store.files(c.uid, noteId)) {
    const dek = r.dek_enc ? await unwrapDek(c.master, c.uid, r.id, r.dek_enc) : null;
    const name = dek && r.name_enc ? await openText(dek, c.uid, r.id, 'name', r.name_enc) : null;
    if (name === null) c.deps.log('decrypt_failed');
    out.push(item(r, name ?? `file.${r.kind}`));
  }
  return json(200, { ok: true, files: out }, NO_STORE);
}

/** 删这个人登记着的预览：先删对象再删登记（对象删不掉时登记留着，sweep 到期照样按登记删） */
async function endPreviews(c: Ctx, preview: Preview): Promise<void> {
  const paths = await c.store.previews(c.uid);
  if (paths.length === 0) return;
  await preview.remove(paths);
  await c.store.unregister(c.uid, paths);
}

async function msPreview(c: Ctx, preview: Preview, id: string): Promise<Response> {
  const { deps, rules } = c;
  if (!(await deps.takeRate(utcHourKey('vault-file-msp', c.uid, deps.now()), rules.previewPerHour, 3600))) return err(429, 'rate_limited');
  const r = await liveFile(c, id);
  if (!r || r.kind !== PREVIEW_KIND) return err(404, 'not_found');
  const plain = await decrypted(c, r, 'full');
  if (plain === 'missing') return err(404, 'not_found');
  if (!plain) {
    deps.log('decrypt_failed');
    return err(500, 'corrupt');
  }
  await endPreviews(c, preview);
  const path = `${hex(deps.random(16))}.pptx`;
  const expiresAt = deps.now() + rules.previewTtlS * 1000;
  // 先登记再写对象（0.23 第五轮架构 L6）：写到一半断了，sweep 照样按登记删
  await c.store.register(c.uid, path, r.id, expiresAt);
  try {
    await preview.put(path, plain, { contentType: rules.mime(PREVIEW_KIND) });
    const url = await preview.sign(path, rules.previewTtlS);
    deps.log('preview_ok');
    return json(200, { ok: true, url, expires_at: expiresAt }, NO_STORE);
  } catch (e) {
    try {
      await preview.remove([path]);
      await c.store.unregister(c.uid, [path]);
    } catch {
      deps.log('preview_cleanup_failed');
    }
    throw e;
  }
}

async function sweep(deps: Deps, store: Store, preview: Preview): Promise<Response> {
  const d = { expired: 0, stray: 0, failed: 0 };
  const ex = await store.expired();
  if (ex.length > 0) {
    await preview.remove(ex.map((x) => x.path));
    const byUser = new Map<string, string[]>();
    for (const x of ex) byUser.set(x.user_id, [...(byUser.get(x.user_id) ?? []), x.path]);
    for (const [uid, paths] of byUser) {
      try {
        await store.unregister(uid, paths);
        d.expired += paths.length;
      } catch {
        d.failed += 1;
        deps.log('sweep_unregister_failed');
      }
    }
  }
  const cutoff = deps.now() - deps.rules.previewTtlS * 1000 - STRAY_GRACE_MS;
  const handled = new Set(ex.map((x) => x.path));
  const stray = (await preview.list()).filter((o) => o.created_at < cutoff && !handled.has(o.name)).map((o) => o.name);
  if (stray.length > 0) {
    await preview.remove(stray);
    d.stray = stray.length;
  }
  try {
    await store.heartbeat(d);
  } catch {
    deps.log('heartbeat_failed');
  }
  return json(200, { ok: true, ...d }, NO_STORE);
}

const isMultipart = (req: Request) => (req.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data');

/** JWT → 每分钟限流 → 令牌 → 配置齐了：过了回 Ctx，不过回响应 */
async function enter(req: Request, deps: Deps): Promise<Ctx | Response> {
  const auth = await deps.authenticate(req);
  if (!auth.ok) return auth.response;
  const uid = auth.user.userId;
  if (!(await deps.takeRate(utcMinuteKey('vault-file-min', uid, deps.now()), deps.rules.ratePerMin, 60))) return err(429, 'rate_limited');
  const v = await deps.checkToken(uid, req.headers.get(VAULT_TOKEN_HEADER));
  if (v.verdict !== 'ok') return err(401, v.verdict);
  if (!deps.store || !deps.r2 || !deps.master) {
    deps.log('misconfigured');
    return err(503, 'try_later');
  }
  return { uid, deps, rules: deps.rules, store: deps.store, r2: deps.r2, master: deps.master };
}

async function dispatch(req: Request, deps: Deps): Promise<Response> {
  if (isMultipart(req)) {
    const declared = Number(req.headers.get('content-length') ?? 'NaN');
    if (Number.isFinite(declared) && declared > deps.rules.uploadMaxBody) {
      await req.body?.cancel().catch(() => {});
      return err(413, 'too_large');
    }
    const c = await enter(req, deps);
    return c instanceof Response ? c : await upload(c, req);
  }
  const raw = await readJsonCapped(req, JSON_MAX_BODY);
  const r = raw === 'too_large' ? null : deps.rules.parse(raw);
  if (!r) return err(400, 'bad_request');
  if (r.action === 'sweep') {
    const denied = cronGate(req.headers.get('x-cron-secret'), deps.cronSecret, deps.log);
    if (denied) return denied;
    if (!deps.store || !deps.preview) {
      deps.log('misconfigured');
      return err(503, 'try_later');
    }
    return await sweep(deps, deps.store, deps.preview);
  }
  const c = await enter(req, deps);
  if (c instanceof Response) return c;
  switch (r.action) {
    case 'list': return await list(c, r.note_id);
    case 'get': return await get(c, r.id, r.part ?? 'full');
    case 'remove':
    case 'restore':
      return (await c.store.setDeleted(c.uid, r.id, r.action === 'remove' ? deps.now() : null)) ? json(200, { ok: true }, NO_STORE) : err(404, 'not_found');
    case 'ms_preview':
    case 'ms_preview_end': {
      if (!deps.preview) {
        deps.log('misconfigured');
        return err(503, 'try_later');
      }
      if (r.action === 'ms_preview') return await msPreview(c, deps.preview, r.id);
      await endPreviews(c, deps.preview);
      return json(200, { ok: true }, NO_STORE);
    }
  }
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return err(405, 'method_not_allowed');
  try {
    return await dispatch(req, deps);
  } catch {
    deps.log('try_later');
    return err(503, 'try_later');
  }
}
