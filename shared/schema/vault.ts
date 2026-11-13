// 隐私记 vault、vault-image 两个函数的请求、响应和错误码（架构 5.5、第 6 节 vault / vault-image 行、0.29 续第 94 条；B5 任务单 S1、D6、D20）。
// 前后端共用这一份：服务器 supabase/functions/vault*/ 只回这里的码；前端 src/features/vault/data/vault-errors.ts 穷尽 switch（新增一个码不处理就编译不过）。
// 不设全局错误码表（0.38 第 48 条、代定 D20）：session_revoked、try_later、upgrade_required、unauthorized 这些各函数共用的码照 B1 的处理（outbox-logic.ts、sync/engine.ts），
//   这里只放隐私记自己的。加码、改码要同时改架构第 6 节的 vault 行。
//
// 令牌（vault_token）：请求头 x-vault-token；签发和续期都在 JSON 响应体的 vault_token、expires_at（毫秒）里回。
//   vault 每一次带令牌的成功调用都续 10 分钟（5.5“每次调用续期”）；vault-image 只验、不续（回的是图片字节，不夹 JSON）。
// 隐私记的正文密文里放 {v: 1, title, body}（代定 D7），notes 的 title、body 列为空；category_id 照旧明文。
import { z } from 'zod';

/** 隐私记自己的错误码；HTTP 状态写在行尾 */
export const VAULT_ERROR_CODES = [
  'vault_locked',          // 401  没带令牌、签名不对、user_id 对不上、过期（0.29 续第 94 条 ①～④）
  'vault_relock',          // 401  令牌里的 pin_epoch 不是当前值（别处改过或重设过密码，⑤）
  'not_set',               // 409  还没设过密码（unlock、change_pin、webauthn 等）
  'already_set',           // 409  setup 第二次（安全审查中 2）
  'bad_pin',               // 400  不是 4～12 位数字
  'pin_wrong',             // 403  密码不对；带 left（还能试几次，到 0 就锁上了）
  'pin_locked',            // 423  逐级锁定中；带 retry_after_s
  'reauth_required',       // 401  reset 要 10 分钟内刚用邮箱验证码登录过（看 amr 的 otp timestamp，不看 iat）
  'webauthn_failed',       // 403  WebAuthn 校验没过（origin、RP ID、签名、sign_count、挑战过期或用过、不认识的凭据）
  'webauthn_unavailable',  // 400  这个来源不能用 WebAuthn（exe 的 tauri.localhost 等，R-105）
  'not_found',             // 404  隐私记、图片、凭据不存在或不是本人的
  'has_files',             // 409  带文档附件的随手记暂时不能移进、移出隐私记（代定 D13，B4b-1 放开）
  'too_large',             // 413  图片超过 2 MB、正文超长
  'bad_image',             // 415  不是 webp（文件头不是 RIFF????WEBP）
  'rate_limited',          // 429  每人每分钟 60 次（vault-image 30 次）；交接设备行另见 account
  'try_later',             // 503  数据库、R2 暂时不通
] as const;
export const vaultErrorCode = z.enum(VAULT_ERROR_CODES);
export type VaultErrorCode = z.infer<typeof vaultErrorCode>;

/** 错误响应体：pin_wrong 带 left，pin_locked 带 retry_after_s；其余只有 error */
export const vaultErrorBody = z.object({
  error: z.string().min(1).max(64),
  left: z.number().int().min(0).max(5).optional(),
  retry_after_s: z.number().int().min(0).optional(),
});
export type VaultErrorBody = z.infer<typeof vaultErrorBody>;

// ---------------- 常量（出处见行尾） ----------------
export const PIN_RE = /^\d{4,12}$/;                                  // 5.5：4 到 12 位数字
export const VAULT_TOKEN_TTL_S = 600;                                // 5.5：10 分钟，每次调用续期
export const VAULT_FAILS_PER_LEVEL = 5;                              // 5.5：连续错 5 次锁一次
export const VAULT_LOCK_STEPS_S = [60, 300, 900, 3600, 14400, 86400] as const;   // 5.5：1 分、5 分、15 分、1 小时、4 小时，之后一直 24 小时
export const VAULT_RESET_OTP_MAX_AGE_S = 600;                        // 5.5：amr 里 otp 的 timestamp 在 10 分钟以内
export const VAULT_TITLE_MAX = 160;                                  // 和 notes.title 的 check 一样
export const VAULT_BODY_MAX = 20000;                                 // 和 notes.body 的 check 一样
export const VAULT_IMAGE_MAX_BYTES = 2097152;                        // 清单 vault-images 的 fileSizeLimit（2 MB）
export const VAULT_PURGE_MAX = 200;                                  // 一次永久删除最多几条
export const VAULT_IMAGES_PER_SAVE = 20;                             // 一次保存最多加、删几张图
export const WEBAUTHN_RP_ID = 'lemomemo.com';                        // 5.5
export const WEBAUTHN_CHALLENGE_TTL_S = 120;                         // 挑战 2 分钟内有效、验过即删
export const WEBAUTHN_LABEL_MAX = 40;

/** 第 n 次锁定（lock_level 从 0 起）的时长（秒）：超出表的一律 24 小时 */
export function lockSeconds(level: number): number {
  const steps = VAULT_LOCK_STEPS_S;
  return steps.at(Math.min(Math.max(0, Math.trunc(level)), steps.length - 1)) ?? 86400;   // at()：check_backend F7 不放行算出来的下标
}

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const pin = z.string().max(64);   // 格式由服务器判（bad_pin），这里只防超长
const b64u = z.string().regex(/^[A-Za-z0-9_-]*$/).max(8192);
const ms = z.number().int().nonnegative();

/** 新增一张已经经 vault-image 上传好的图（服务器 HEAD 一下 R2 核对大小后写 note_images 行） */
export const vaultImageAdd = z.object({
  id: uuid, bytes: z.number().int().positive().max(VAULT_IMAGE_MAX_BYTES),
  width: z.number().int().positive().max(20000).nullable(), height: z.number().int().positive().max(20000).nullable(),
  has_thumb: z.boolean(),
});
export type VaultImageAdd = z.infer<typeof vaultImageAdd>;

// ---------------- vault 的请求（按 action 分） ----------------
export const vaultRequest = z.discriminatedUnion('action', [
  // 只要 JWT
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('setup'), pin }),
  z.object({ action: z.literal('unlock'), pin }),
  z.object({ action: z.literal('reset'), new_pin: pin }),
  z.object({ action: z.literal('webauthn_options'), purpose: z.enum(['register', 'unlock']) }),
  z.object({ action: z.literal('unlock_webauthn'), assertion: z.object({
    id: b64u, client_data_json: b64u, authenticator_data: b64u, signature: b64u }) }),
  // 下面都要 x-vault-token
  z.object({ action: z.literal('change_pin'), old_pin: pin, new_pin: pin }),
  z.object({ action: z.literal('webauthn_register'), pin, label: z.string().max(WEBAUTHN_LABEL_MAX),
    attestation: z.object({ id: b64u, client_data_json: b64u, attestation_object: b64u }) }),
  z.object({ action: z.literal('list_credentials') }),
  z.object({ action: z.literal('renew') }),   // 什么都不做、只续期（编辑久了、传图前；回 vaultTokenResponse）
  z.object({ action: z.literal('remove_credential'), credential_id: b64u }),
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('save'), id: uuid, title: z.string().max(VAULT_TITLE_MAX), body: z.string().max(VAULT_BODY_MAX),
    category_id: uuid.nullable(), created_at: ms, updated_at: ms,
    add_images: z.array(vaultImageAdd).max(VAULT_IMAGES_PER_SAVE).optional(),
    remove_images: z.array(uuid).max(VAULT_IMAGES_PER_SAVE).optional() }),
  z.object({ action: z.literal('delete'), id: uuid }),
  z.object({ action: z.literal('undelete'), id: uuid }),
  z.object({ action: z.literal('purge'), items: z.array(uuid).min(1).max(VAULT_PURGE_MAX) }),
  z.object({ action: z.literal('import'), note_id: uuid }),
  z.object({ action: z.literal('export'), note_id: uuid }),
]);
export type VaultRequest = z.infer<typeof vaultRequest>;
export type VaultAction = VaultRequest['action'];

// 哪些动作不要令牌由 supabase/functions/vault/core.ts 的两个 switch 定（11-14 独立评审：原来这里另列的 VAULT_OPEN_ACTIONS、
//   VAULT_UNLOCK_ACTIONS 没人用、和 switch 是两份口径，删了）；vault 的响应一律 no-store。

// ---------------- vault 的响应 ----------------
/** 凡是签发或续期了令牌的成功响应都带这两项 */
const tok = { vault_token: z.string().min(16).max(512), expires_at: ms };

export const vaultStatusResponse = z.object({
  ok: z.literal(true), set: z.boolean(),
  locked_until: ms.nullable(),          // 正在锁定时是解锁时刻（毫秒），否则 null
  last_reset_at: ms.nullable(),
  webauthn: z.number().int().nonnegative(),   // 已绑定凭据数（设置页和解锁卡决定显不显示 Face ID 按钮）
});
export const vaultTokenResponse = z.object({ ok: z.literal(true), ...tok });

export const webauthnOptionsResponse = z.object({
  ok: z.literal(true), challenge: b64u, rp_id: z.string(), timeout_ms: z.number().int().positive(),
  user_id: b64u,                           // register 用：user.id（user_id 的 16 字节）
  credential_ids: z.array(b64u),           // unlock 用：allowCredentials；register 用：excludeCredentials
});

export const vaultCredential = z.object({ id: b64u, label: z.string().nullable() });
export const vaultCredentialsResponse = z.object({ ok: z.literal(true), items: z.array(vaultCredential), ...tok });

export const vaultNoteImage = z.object({
  id: uuid, has_thumb: z.boolean(), width: z.number().int().nullable(), height: z.number().int().nullable(), bytes: z.number().int(),
  deleted_at: ms.nullable(),
});
export const vaultNote = z.object({
  id: uuid, title: z.string(), body: z.string(), category_id: uuid.nullable(),
  created_at: ms, updated_at: ms, deleted_at: ms.nullable(), images: z.array(vaultNoteImage),
});
export type VaultNote = z.infer<typeof vaultNote>;
export type VaultNoteImage = z.infer<typeof vaultNoteImage>;
export const vaultListResponse = z.object({ ok: z.literal(true), notes: z.array(vaultNote), ...tok });

/** save、delete、undelete、import、export、remove_credential、webauthn_register 的成功响应 */
export const vaultOkResponse = z.object({ ok: z.literal(true), ...tok });
export const vaultPurgeResponse = z.object({ ok: z.literal(true), purged: z.number().int().nonnegative(), ...tok });

// ---------------- vault-image ----------------
// get：POST JSON {action: 'get', image_id, part?: 'thumb'} → 直接回字节（Content-Type: image/webp、Cache-Control: no-store、nosniff）
// upload：POST 原始 webp 字节，地址带 ?action=upload&note_id=&image_id=&part=full|thumb（请求体不是 JSON，参数只能放地址里；
//   地址里只有三个 UUID，不含内容）→ {ok: true}；之后由 vault {save, add_images} 写 note_images 行
export const vaultImageGet = z.object({ action: z.literal('get'), image_id: uuid, part: z.enum(['full', 'thumb']).optional() });
export const vaultImageUploadQuery = z.object({
  action: z.literal('upload'), note_id: uuid, image_id: uuid, part: z.enum(['full', 'thumb']),
});
export type VaultImageUploadQuery = z.infer<typeof vaultImageUploadQuery>;

/** vault-images 桶里的对象键（和清单 pathPattern、note_images 的 path check 一致） */
export function vaultImageKey(userId: string, noteId: string, imageId: string, part: 'full' | 'thumb'): string {
  return `${userId}/${noteId}/${imageId}${part === 'thumb' ? '.t' : ''}.webp`;
}
