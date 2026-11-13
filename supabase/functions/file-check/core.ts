// file-check：附件上传完的服务器复查（架构 5.13 第 2 点“服务器 fn file-check”、第 6 节 file-check 行、架构约定 9.7；B4b-1）。
// 纯逻辑，依赖由 index.ts 注入，Vitest 直接测（tests/edge/file-check.test.ts）。
// • 客户端 {action: check, id}（JWT，requireActiveUser）：每人每分钟 30 次；只认本人、普通（is_vault = false）、没删的行，别的一律 404；
//   行已经不在 pending 就直接回现在的结果（重复调用、补扫先判过了）。
// • cron {action: sweep}（x-cron-secret）：一次最多 BATCH 行 created_at 早于 30 分钟、还在 pending 的（免得和正在上传的客户端抢），写心跳 file-check。
// 判一行（verify）：
//   ① 按行里的 user_id、note_id、id、kind 拼对象路径（shared/logic/files/media-path.ts），不读存下来的 path；
//   ② 原文件不在：客户端调用回 incomplete、不改状态；补扫时行已超过 24 小时 → rejected。has_thumb 时客户端调用还要缩略图在（补扫时缺了不影响原文件通过）；
//   ③ 对象大小 = 行里 bytes（> 10 MB 直接按 too_big）、整个读进来算 sha256 = 行里 sha256、shared/logic/files/file-sniff.ts 判出的类型 = 行里 kind；
//      服务器不做整包解压（ZIP 炸弹在每台设备上传前、预览前查），只读 [Content_Types].xml；
//   ④ 通过：check_status = ok、记 etag；不通过：先删原文件和缩略图，再 check_status = rejected（删不掉就回 503，下次补扫再来）。
//   存储额度在写行时由触发器 media_quota_guard 判过、/files 的 put 复核过（迁移 2026111423xxxx），这里不再判。
// 写回带条件 check_status = 'pending'：两边同时判时只有一边写成。日志只经 deps.log 记码，不记文件名、路径、内容。
import { errorResponder, json, NO_STORE, cronGate } from '../_shared/http.ts';
import { readJsonCapped } from '../_shared/body.ts';
import type { AuthResult } from '../_shared/auth-result.ts';
import { utcMinuteKey } from '../_shared/rate-key.ts';
import { FILE_MAX_BYTES } from '../_shared/gen/logic/files/limits.ts';

// 请求、响应、判型结果只写这里用到的形状，不引 _shared/gen 下的 schema、清单（同 vault-image/core.ts：那些模块带 npm:zod，
//   Vitest 的 tsc 解析不了）；index.ts 把 shared 的 fileCheckReq、sniffFile、noteFilePath 接进来时，deno check 按这里的形状核对
/** 同 shared/schema/attachments.ts 的 REJECT_REASONS */
export type RejectReason = 'unknown' | 'too_big' | 'bad_archive' | 'encrypted';
type FileCheckReq = { action: 'check'; id: string } | { action: 'sweep' };
type FileCheckRes = { status: 'ok' } | { status: 'rejected'; reason?: RejectReason } | { status: 'incomplete' };
type SniffResult = { ok: true; kind: string } | { ok: false; reason: Exclude<RejectReason, 'too_big'> };

export const RATE_PER_MIN = 30;
export const BATCH = 50;
export const SWEEP_AFTER_MS = 30 * 60_000;
export const MISSING_GIVE_UP_MS = 24 * 3600_000;
export const BUCKET = 'files';

/** fn_ai 读到的一行（只用到这些列） */
export interface FileRow {
  id: string;
  user_id: string;
  note_id: string;
  kind: string;
  bytes: number;
  sha256: string;
  has_thumb: boolean;
  is_vault: boolean;
  deleted_at: number | null;
  check_status: 'pending' | 'ok' | 'rejected';
  created_at: number;
}

export interface Obj {
  get(bucket: string, key: string): Promise<{ body: unknown; contentLength: number | null; etag: string | null } | null>;
  head(bucket: string, key: string): Promise<{ contentLength: number | null } | null>;
  deleteMany(bucket: string, keys: readonly string[]): Promise<number>;
}

export interface Store {
  /** 本人的一行（fn_ai，app.uid = 本人）；没有回 null */
  row(userId: string, id: string): Promise<FileRow | null>;
  /** 补扫：created_at 早于 before 的 pending 普通行，最多 limit 行（fn_ai 跨用户扫描） */
  stale(before: number, limit: number): Promise<FileRow[]>;
  /** 带条件 check_status = 'pending' 写回；回写成没有 */
  settle(row: FileRow, status: 'ok' | 'rejected', etag: string | null): Promise<boolean>;
  heartbeat(detail: Record<string, number>): Promise<void>;
}

export interface Deps {
  authenticate(req: Request): Promise<AuthResult>;
  takeRate(key: string, limit: number, windowS: number): Promise<boolean>;
  cronSecret: string | undefined;
  parse(v: unknown): FileCheckReq | null;
  store: Store | null;
  r2: Obj | null;
  sniff(bytes: Uint8Array): Promise<SniffResult>;
  sha256Hex(bytes: Uint8Array): Promise<string>;
  path(userId: string, noteId: string, id: string, kind: string): string;
  thumbPath(userId: string, noteId: string, id: string): string;
  now(): number;
  log(code: string): void;
}

type Code = 'not_found' | 'rate_limited' | 'try_later' | 'bad_request' | 'method_not_allowed' | 'misconfigured';
const err = errorResponder<Code>();

type Verdict = FileCheckRes | { status: 'lost' };

async function readAll(body: unknown): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
}

/** 判一行；fromCron 时原文件缺了按 24 小时放弃、缩略图缺了不管 */
export async function verify(row: FileRow, deps: Deps, r2: Obj, store: Store, fromCron: boolean): Promise<Verdict> {
  const key = deps.path(row.user_id, row.note_id, row.id, row.kind);
  const thumb = deps.thumbPath(row.user_id, row.note_id, row.id);
  const reject = async (reason: RejectReason | null): Promise<Verdict> => {
    await r2.deleteMany(BUCKET, row.has_thumb ? [key, thumb] : [key]);
    const done = await store.settle(row, 'rejected', null);
    deps.log(`rejected:${reason ?? 'missing'}`);
    return done ? (reason ? { status: 'rejected', reason } : { status: 'rejected' }) : { status: 'lost' };
  };
  const obj = await r2.get(BUCKET, key);
  if (!obj) {
    if (fromCron && deps.now() - row.created_at > MISSING_GIVE_UP_MS) return reject(null);
    return { status: 'incomplete' };
  }
  if (!fromCron && row.has_thumb && !(await r2.head(BUCKET, thumb))) return { status: 'incomplete' };
  if (obj.contentLength !== null && obj.contentLength > FILE_MAX_BYTES) return reject('too_big');
  const bytes = await readAll(obj.body);
  if (bytes.length > FILE_MAX_BYTES) return reject('too_big');
  if (bytes.length !== row.bytes) return reject('unknown');
  if ((await deps.sha256Hex(bytes)) !== row.sha256) return reject('unknown');
  const s = await deps.sniff(bytes);
  if (!s.ok) return reject(s.reason);
  if (s.kind !== row.kind) return reject('unknown');
  return (await store.settle(row, 'ok', obj.etag)) ? { status: 'ok' } : { status: 'lost' };
}

/** 判完以后写回没成（别处先判了）：重读这一行回它现在的结果 */
async function current(row: FileRow, store: Store): Promise<FileCheckRes | null> {
  const now = await store.row(row.user_id, row.id);
  if (!now || now.deleted_at !== null) return null;
  return now.check_status === 'pending' ? null : { status: now.check_status };
}

async function check(req: Request, deps: Deps, store: Store, r2: Obj, id: string): Promise<Response> {
  const auth = await deps.authenticate(req);
  if (!auth.ok) return auth.response;
  const uid = auth.user.userId;
  if (!(await deps.takeRate(utcMinuteKey('file-check-min', uid, deps.now()), RATE_PER_MIN, 60))) return err(429, 'rate_limited');
  const row = await store.row(uid, id);
  if (!row || row.is_vault || row.deleted_at !== null) return err(404, 'not_found');
  if (row.check_status !== 'pending') return json(200, { status: row.check_status }, NO_STORE);
  const v = await verify(row, deps, r2, store, false);
  if (v.status !== 'lost') return json(200, v, NO_STORE);
  const c = await current(row, store);
  return c ? json(200, c, NO_STORE) : err(503, 'try_later');
}

async function sweep(deps: Deps, store: Store, r2: Obj): Promise<Response> {
  const rows = await store.stale(deps.now() - SWEEP_AFTER_MS, BATCH);
  const d = { rows: rows.length, passed: 0, rejected: 0, incomplete: 0, failed: 0 };
  for (const row of rows) {
    try {
      const v = await verify(row, deps, r2, store, true);
      if (v.status === 'ok') d.passed += 1;
      else if (v.status === 'rejected') d.rejected += 1;
      else if (v.status === 'incomplete') d.incomplete += 1;
    } catch {
      d.failed += 1;
      deps.log('sweep_row_failed');
    }
  }
  await store.heartbeat(d);
  return json(200, { ok: true, ...d }, NO_STORE);
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return err(405, 'method_not_allowed');
  try {
    const raw = await readJsonCapped(req.clone(), 1024);
    const r = raw === 'too_large' ? null : deps.parse(raw);
    if (!r) return err(400, 'bad_request');
    if (r.action === 'sweep') {
      const denied = cronGate(req.headers.get('x-cron-secret'), deps.cronSecret, deps.log);
      if (denied) return denied;
    }
    if (!deps.store || !deps.r2) {
      deps.log('misconfigured');
      return err(500, 'misconfigured');
    }
    return r.action === 'sweep' ? await sweep(deps, deps.store, deps.r2) : await check(req, deps, deps.store, deps.r2, r.id);
  } catch {
    deps.log('try_later');
    return err(503, 'try_later');
  }
}
