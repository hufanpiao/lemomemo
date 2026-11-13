// vault-image：隐私记插图的上传和读取（架构 5.5、第 6 节 vault-image 行、0.32（R-214）；B5 任务单 S8、S18；TC-B5-09、35、38、39、43；TC-B0-75）。
// 纯逻辑，依赖由 index.ts 注入，Vitest 直接测。
// • 鉴权：JWT（requireActiveUser）+ x-vault-token（_shared/vault-token.ts，pin_epoch 经 fn_ai 读，6.2 A2）；只验、不续期（回的是字节，不夹 JSON）。
// • 每人每分钟 30 次（vault-img-min:<uid>:<UTC 分钟 yyyymmddhhmm>）。
// • upload：POST 原始字节，地址带 ?action=upload&note_id=&image_id=&part=full|thumb；只收 vault {save, add_images} 已经预登记的图
//   （本人 vault-images 的行、没删、note_id 对得上；thumb 还要登记时 has_thumb），没有一律 404——每个对象都对应一行、行数上限和存储额度都算过
//   （11-14 整块评审第 3 条）；再边读边计数（原图 ≤ 2 MB、缩略图 ≤ 128 KB，超了 413 too_large，整块评审第 11 条），原图字节数必须等于登记的 bytes
//   （不等 400 bad_request），核对 RIFF????WEBP 文件头（不是 415 bad_image），写 vault-images，put 一律显式写 contentType 'image/webp'（TC-B0-75），
//   带 If-None-Match；对象已经在算成功（客户端重试）。
// • get：POST JSON {action: 'get', image_id, part?}；只认本人 vault-images、没删的图（不是的一律 404，整块评审第 9 条）；直接回字节，
//   Content-Type: image/webp、Cache-Control: no-store、X-Content-Type-Options: nosniff。
// • 在免查名单里（shared/version-gate-list.ts，0.29 续第 77 条：旧版也能看隐私记的图），所以入口不查版本。
// 不打印请求体、字节、令牌；日志只经 deps.log。
import { readCapped, readJsonCapped } from '../_shared/body.ts';
import type { AuthResult as SharedAuthResult } from '../_shared/auth-result.ts';
import { errorResponder, json, NO_STORE } from '../_shared/http.ts';
import { utcMinuteKey } from '../_shared/rate-key.ts';
import { IMAGE_TYPE, isExists, VAULT_IMAGE_BUCKET as BUCKET, VAULT_THUMB_MAX_BYTES, type VaultObj } from '../_shared/vault-images.ts';
import { VAULT_TOKEN_HEADER, type VaultTokenVerdict } from '../_shared/vault-token.ts';

export const RATE_PER_MIN = 30;
const GET_MAX_BODY = 1024;

export type Part = 'full' | 'thumb';
export interface UploadQuery { note_id: string; image_id: string; part: Part }
export interface GetReq { image_id: string; part?: Part | undefined }
/** 本人一张没删的图（store.ts 的 imageMeta 只回 deleted_at is null 的行） */
export interface ImageMeta { note_id: string; bucket: string; has_thumb: boolean; bytes: number }

export type Obj = Pick<VaultObj, 'get' | 'put'>;

export type AuthResult = SharedAuthResult;

export interface Deps {
  authenticate(req: Request): Promise<AuthResult>;
  takeRate(key: string, limit: number, windowS: number): Promise<boolean>;
  /** vaultTokenChecker（没配 VAULT_TOKEN_SECRET 时一律 vault_locked） */
  checkToken(userId: string, token: string | null): Promise<{ verdict: VaultTokenVerdict }>;
  /** shared/schema/vault.ts 的 vaultImageUploadQuery / vaultImageGet；不合格回 null */
  parseUpload(q: Record<string, string>): UploadQuery | null;
  parseGet(v: unknown): GetReq | null;
  imageKey(userId: string, noteId: string, imageId: string, part: Part): string;
  maxBytes: number;
  /** 本人的一张没删的图（fn_ai；没有、已删回 null） */
  image(userId: string, imageId: string): Promise<ImageMeta | null>;
  r2: Obj | null;
  now(): number;
  log(code: string): void;
}

type Code = 'vault_locked' | 'vault_relock' | 'not_found' | 'too_large' | 'bad_image' | 'rate_limited' | 'try_later' | 'bad_request' | 'method_not_allowed';
const err = errorResponder<Code>();

/** RIFF????WEBP：前 4 字节 'RIFF'，第 8～11 字节 'WEBP' */
export function isWebp(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  const tag = (from: number) => String.fromCharCode(...b.slice(from, from + 4));
  return tag(0) === 'RIFF' && tag(8) === 'WEBP';
}

/** 这张图在不在、能不能取或传这一份：本人 vault-images、没删、要缩略图时登记过有缩略图 */
async function metaFor(userId: string, imageId: string, part: Part, deps: Deps): Promise<ImageMeta | null> {
  const meta = await deps.image(userId, imageId);
  return meta && meta.bucket === BUCKET && (part === 'full' || meta.has_thumb) ? meta : null;
}

async function upload(req: Request, url: URL, userId: string, r2: Obj, deps: Deps): Promise<Response> {
  const q = deps.parseUpload(Object.fromEntries(url.searchParams));
  if (!q) return err(400, 'bad_request');
  const meta = await metaFor(userId, q.image_id, q.part, deps);
  if (!meta || meta.note_id !== q.note_id) return err(404, 'not_found');
  const b = await readCapped(req, q.part === 'thumb' ? VAULT_THUMB_MAX_BYTES : deps.maxBytes);
  if (b === 'too_large') return err(413, 'too_large');
  if (b === 'empty') return err(400, 'bad_request');
  if (q.part === 'full' && b.length !== meta.bytes) return err(400, 'bad_request');
  if (!isWebp(b)) return err(415, 'bad_image');
  try {
    await r2.put(BUCKET, deps.imageKey(userId, q.note_id, q.image_id, q.part), b, { contentType: IMAGE_TYPE, ifNoneMatch: true });
  } catch (e) {
    if (!isExists(e)) throw e;
  }
  return json(200, { ok: true }, NO_STORE);
}

async function get(req: Request, userId: string, r2: Obj, deps: Deps): Promise<Response> {
  const raw = await readJsonCapped(req, GET_MAX_BODY);
  if (raw === 'too_large') return err(413, 'too_large');
  const r = deps.parseGet(raw);
  if (!r) return err(400, 'bad_request');
  const part = r.part ?? 'full';
  const meta = await metaFor(userId, r.image_id, part, deps);
  if (!meta) return err(404, 'not_found');
  const obj = await r2.get(BUCKET, deps.imageKey(userId, meta.note_id, r.image_id, part));
  if (!obj) return err(404, 'not_found');
  const headers: Record<string, string> = {
    'content-type': IMAGE_TYPE, 'x-content-type-options': 'nosniff', ...NO_STORE,
    ...(obj.contentLength !== null ? { 'content-length': String(obj.contentLength) } : {}),
  };
  return new Response(obj.body as BodyInit, { status: 200, headers });
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return err(405, 'method_not_allowed');
  try {
    const auth = await deps.authenticate(req);
    if (!auth.ok) return auth.response;
    const userId = auth.user.userId;
    if (!(await deps.takeRate(utcMinuteKey('vault-img-min', userId, deps.now()), RATE_PER_MIN, 60))) return err(429, 'rate_limited');
    const v = await deps.checkToken(userId, req.headers.get(VAULT_TOKEN_HEADER));
    if (v.verdict !== 'ok') return err(401, v.verdict);
    if (!deps.r2) {
      deps.log('misconfigured:r2');
      return err(503, 'try_later');
    }
    const url = new URL(req.url);
    return url.searchParams.get('action') === 'upload' ? await upload(req, url, userId, deps.r2, deps) : await get(req, userId, deps.r2, deps);
  } catch {
    deps.log('db_error');
    return err(503, 'try_later');
  }
}
