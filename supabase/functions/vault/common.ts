// vault 几个文件共用的类型、注入的依赖、响应小工具（照 account/common.ts 的拆法）。
// 只被 vault/ 下的 core.ts、pin.ts、webauthn.ts、notes.ts、move.ts 引用，不反过来 import 它们。
// 不 import npm 包、不 import _shared/gen/、不碰 Deno 全局：shared/schema/vault.ts 里的常量和 zod 解析由 index.ts 经 Deps.rules、Deps.parse 注入，
//   测试注入真的 shared/schema/vault.ts（只此一份，不复制常量）。
import type { Bytes } from '../_shared/b64url.ts';
import type { EnvKind } from '../_shared/env-kind.ts';
import { json } from '../_shared/http.ts';
import type { VaultPushEvent } from '../_shared/push/payload.ts';

// ---------------- 请求（和 shared/schema/vault.ts 的 vaultRequest 推出的类型一致，tests/functions/vault-core.test.ts 双向核对） ----------------
type Uuid = string;
export interface ImageAdd { id: Uuid; bytes: number; width: number | null; height: number | null; has_thumb: boolean }
export type VaultReq =
  | { action: 'status' }
  | { action: 'setup'; pin: string }
  | { action: 'unlock'; pin: string }
  | { action: 'reset'; new_pin: string }
  | { action: 'webauthn_options'; purpose: 'register' | 'unlock' }
  | { action: 'unlock_webauthn'; assertion: { id: string; client_data_json: string; authenticator_data: string; signature: string } }
  | { action: 'change_pin'; old_pin: string; new_pin: string }
  | { action: 'webauthn_register'; pin: string; label: string; attestation: { id: string; client_data_json: string; attestation_object: string } }
  | { action: 'list_credentials' }
  | { action: 'renew' }
  | { action: 'remove_credential'; credential_id: string }
  | { action: 'list' }
  | {
    action: 'save'; id: Uuid; title: string; body: string; category_id: Uuid | null; created_at: number; updated_at: number;
    add_images?: ImageAdd[] | undefined; remove_images?: Uuid[] | undefined;
  }
  | { action: 'delete'; id: Uuid }
  | { action: 'undelete'; id: Uuid }
  | { action: 'purge'; items: Uuid[] }
  | { action: 'import'; note_id: Uuid }
  | { action: 'export'; note_id: Uuid };
export type ReqOf<A extends VaultReq['action']> = Extract<VaultReq, { action: A }>;

/** shared/schema/vault.ts 里用到的常量和函数（index.ts 从 _shared/gen 注入） */
export interface VaultRules {
  pinRe: RegExp;
  failsPerLevel: number;
  lockSeconds(level: number): number;
  resetOtpMaxAgeS: number;
  challengeTtlS: number;
  rpId: string;
  imageMaxBytes: number;
  imageKey(userId: string, noteId: string, imageId: string, part: 'full' | 'thumb'): string;
}

/** 三把钥匙（index.ts 用 decodeKey32 解；解不出就是 null） */
export interface VaultKeys { master: Bytes | null; pepper: Bytes | null; tokenSecret: Bytes | null }
/** 三把都在：core.ts 的 handle 判一次（缺一把回 misconfigured），之后经 Ctx.keys 传给各动作，不再各自判空 */
export interface FullKeys { master: Bytes; pepper: Bytes; tokenSecret: Bytes }
export function fullKeys(k: VaultKeys): FullKeys | null {
  return k.master && k.pepper && k.tokenSecret ? { master: k.master, pepper: k.pepper, tokenSecret: k.tokenSecret } : null;
}

// ---------------- 数据库（index.ts 经 withVaultUser 的 fn_vault 事务实现，store.ts；测试用内存假库） ----------------
/** 时刻一律毫秒 */
export interface VaultRow {
  pin_hash: string; pin_epoch: number; fail_count: number; lock_level: number; locked_until: number | null; last_reset_at: number | null;
}
export type VaultPatch = Partial<Omit<VaultRow, 'last_reset_at'>> & { last_reset_at?: number };
export interface CredRow { id: string; public_key: Uint8Array; sign_count: number; label: string | null }
export interface NoteRow {
  id: Uuid; is_private: boolean; deleted_at: number | null; title: string | null; body: string | null;
  body_enc: Uint8Array | null; enc_key_id: number | null; category_id: Uuid | null; created_at: number; updated_at: number;
}
export interface ImageRow {
  id: Uuid; note_id: Uuid; bucket: 'images' | 'vault-images'; has_thumb: boolean; width: number | null; height: number | null;
  bytes: number; deleted_at: number | null;
}

/** 一个按用户开的事务（app.uid = 本人；RLS 只放本人的行）。出错就抛，整个事务回滚 */
export interface VaultTx {
  /** private.vault 本人这一行；lock = for update（核对密码时排队，防并发猜） */
  vault(lock: boolean): Promise<VaultRow | null>;
  /** 没有才插（setup）；已有回 false */
  insertVault(pinHash: string): Promise<boolean>;
  updateVault(p: VaultPatch): Promise<void>;
  /** 改密码、重设后：删本人全部 vault_credentials 和 device_secrets */
  dropCredentialsAndSecrets(): Promise<void>;
  credentials(): Promise<CredRow[]>;
  credential(id: string): Promise<CredRow | null>;
  /** 已有同 id 的回 false */
  insertCredential(c: CredRow): Promise<boolean>;
  setSignCount(id: string, n: number): Promise<void>;
  deleteCredential(id: string): Promise<boolean>;
  putChallenge(challenge: string, expiresAt: number): Promise<void>;
  /** 删掉并回过期时刻（没有回 null）：验过即删 */
  takeChallenge(challenge: string): Promise<number | null>;
  /** 本人的全部隐私记（含已删） */
  privateNotes(): Promise<NoteRow[]>;
  /** 本人的一条（普通或隐私） */
  note(id: Uuid): Promise<NoteRow | null>;
  /** 本人 vault-images 的全部图片行（含已删） */
  vaultImages(): Promise<ImageRow[]>;
  imagesOf(noteId: Uuid): Promise<ImageRow[]>;
  insertPrivateNote(n: { id: Uuid; body_enc: Uint8Array; enc_key_id: number; category_id: Uuid | null; created_at: number; updated_at: number }): Promise<void>;
  /** 只改没删的隐私记；改到 0 行回 false */
  updatePrivateNote(id: Uuid, p: { body_enc: Uint8Array; enc_key_id: number; category_id: Uuid | null; updated_at: number }): Promise<boolean>;
  /** 隐私记软删（at）或恢复（null）；改到 0 行回 false */
  setPrivateDeleted(id: Uuid, at: number | null): Promise<boolean>;
  insertVaultImage(noteId: Uuid, img: ImageAdd): Promise<void>;
  removeVaultImages(noteId: Uuid, ids: readonly Uuid[], at: number): Promise<void>;
  /** private.purge_vault_impl：只删本人已软删的隐私记 */
  purge(ids: readonly Uuid[]): Promise<number>;
  hasFiles(noteId: Uuid): Promise<boolean>;
  /** 移进：同一条 update 写密文、清明文残留，is_private = true；只改没删的普通随手记，0 行回 false */
  toVault(id: Uuid, bodyEnc: Uint8Array, encKeyId: number, updatedAt: number): Promise<boolean>;
  /** 移出：写回明文，is_private = false、body_enc 清空；只改没删的隐私记，0 行回 false */
  toPlain(id: Uuid, title: string | null, body: string, updatedAt: number): Promise<boolean>;
  /** 这条的图片行换桶（vault-images 清 taken_at、ai_desc、ai_tags） */
  moveImages(noteId: Uuid, to: 'images' | 'vault-images'): Promise<void>;
  /** 删这条和它图片的旧向量、vault_ai（触发器按新身份重新入队） */
  dropVectors(noteId: Uuid): Promise<void>;
}

/** 数据本身不合格（SQLSTATE 22、23 类）或超了行数上限（row_quota 抛 quota） */
export class StoreDataError extends Error {
  readonly kind: 'data' | 'quota';
  constructor(kind: 'data' | 'quota') {
    super(kind);
    this.kind = kind;
  }
}

/** postgres.js 的错误按 SQLSTATE 归类（不带内容）：22、23 类 → data，row_quota 抛的 'quota' → quota，其余原样 */
export function classifyDbError(e: unknown): unknown {
  if (e instanceof StoreDataError) return e;
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  if (e instanceof Error && e.message === 'quota') return new StoreDataError('quota');
  if (typeof code === 'string' && (code.startsWith('22') || code.startsWith('23'))) return new StoreDataError('data');
  return e;
}

/** R2（_shared/gen/objstore.ts 的子集；测试用内存假 store） */
export interface Obj {
  get(bucket: string, key: string): Promise<{ body: unknown; contentLength: number | null } | null>;
  put(bucket: string, key: string, body: Uint8Array, opts: { contentType: string; ifNoneMatch?: boolean }): Promise<unknown>;
  head(bucket: string, key: string): Promise<{ contentLength: number | null } | null>;
  deleteMany(bucket: string, keys: readonly string[]): Promise<number>;
}

export type AuthResult = { ok: true; user: { userId: string; jwt: string } } | { ok: false; response: Response };

export interface Deps {
  authenticate(req: Request): Promise<AuthResult>;
  /** shared/schema/vault.ts 的 vaultRequest.safeParse；不合格回 null */
  parse(v: unknown): VaultReq | null;
  rules: VaultRules;
  /** private.take_rate（service role）：true = 放行 */
  takeRate(key: string, limit: number, windowS: number): Promise<boolean>;
  tx<T>(userId: string, fn: (t: VaultTx) => Promise<T>): Promise<T>;
  keys: VaultKeys;
  /** R2；没配好是 null（用到图片的动作回 misconfigured） */
  r2: Obj | null;
  /** 跑在哪个环境（_shared/env-kind.ts），定 WebAuthn 认的 origin 和 RP ID */
  env: EnvKind;
  /** 给本人所有设备推一条隐私记安全通知；失败自己吞掉（调用方放进 background） */
  notify(userId: string, event: VaultPushEvent): Promise<void>;
  /** 发“隐私记密码已重设”邮件（_shared/account-mail.ts 的 vaultResetMail） */
  resetMail(userId: string, atMs: number): Promise<void>;
  /** 写 public.logs（service role，src = 'vault'） */
  insertLog(userId: string, row: { t: number; act: string; code?: string }): Promise<void>;
  background(p: Promise<unknown>): void;
  now(): number;
  log(code: string): void;
}

/** status 用（不要钥匙：钥匙没配好时 status 照常回） */
export interface Base { req: Request; userId: string; jwt: string; deps: Deps }
/** 其余动作用：钥匙已经判过；pushes 是处理中攒下的推送，core.ts 在处理完（事务已提交）以后才发 */
export interface Ctx extends Base { keys: FullKeys; pushes: VaultPushEvent[] }

/** 处理成功：body 是响应体（不含 ok）；epoch 不为 null 时签一张新令牌放进响应（解锁、续期） */
export interface Out { body: Record<string, unknown>; epoch: number | null }
export const out = (body: Record<string, unknown>, epoch: number | null): Out => ({ body, epoch });

export type VaultErrCode =
  | 'vault_locked' | 'vault_relock' | 'not_set' | 'already_set' | 'bad_pin' | 'pin_wrong' | 'pin_locked' | 'reauth_required'
  | 'webauthn_failed' | 'webauthn_unavailable' | 'not_found' | 'has_files' | 'too_large' | 'bad_image' | 'rate_limited' | 'try_later'
  | 'bad_request' | 'method_not_allowed';
export const err = (status: number, code: VaultErrCode, extra: Record<string, unknown> = {}) => json(status, { error: code, ...extra });

/**
 * 记下一条要推送的事件。不当场发：事务里调用时库还没提交（锁定、改密码、绑定），提交失败就不该通知。
 * core.ts 的 handle 在处理函数正常返回（各事务都已提交）以后统一发；处理中抛错（回滚、回 try_later）就整批丢掉
 */
export function notifyLater(c: Ctx, event: VaultPushEvent): void {
  c.pushes.push(event);
}

/** 每分钟限流的键（附录 A 三段写法，第三段 UTC 分钟 yyyymmddThhmm，同 ai-min） */
export function minuteKey(prefix: string, userId: string, ms: number): string {
  return `${prefix}:${userId}:${new Date(ms).toISOString().slice(0, 16).replace(/[-:]/g, '')}`;
}
