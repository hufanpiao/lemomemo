// vault-file 函数（隐私记的文档附件，架构 5.13 第 11 点、第 6 节 vault-file 行；B4b-1）的请求、响应和错误码。前后端共用这一份。
// 鉴权：一律 JWT + 请求头 x-vault-token（只验、不续期，同 vault-image：回的有字节，不夹 JSON；要续期另调 vault {renew}）；
//   锁着回 401 vault_locked / vault_relock。只有 cron 的 {action: 'sweep'} 例外：带 x-cron-secret、不带 JWT。
// 版本门：不进免查名单（shared/version-gate-list.ts）——upload 会写同步表 note_files，旧版不该写；所以 /sb 和函数入口都照常查，
//   旧版回 426 upgrade_required（各函数共用的码，照 B1 的处理，不列在这里）。带 x-cron-secret 的 sweep 在函数入口跳过版本门。
//
// 动作（POST）：
// • upload：multipart/form-data（唯一不是 JSON 的动作，按 Content-Type 认），三个字段：
//     meta  —— JSON 字符串，形状见 vaultFileMeta；
//     file  —— 原文件（明文；服务器在内存里重做类型检查、真实解压计数，核对 bytes、sha256，再加密写进 vault-files）；
//     thumb —— 可选，image/webp，≤ VAULT_FILE_THUMB_MAX_BYTES，文件头必须是 RIFF????WEBP。
//   整个请求体 ≤ VAULT_FILE_UPLOAD_MAX_BODY（先看 Content-Length，再边读边计数）。
//   成功 200 vaultFileUploadResponse；同 id 的行已经在 409 exists（客户端重发时当作已经传上去了，再 list 一次即可）；
//   类型不对 422 {error: 'rejected', reason}（reason 同 file-check 的 REJECT_REASONS）；超了存储额度或附件行数上限 403 quota_exceeded；
//   note_id 不是本人没删的隐私记 404 not_found；bytes、sha256 和实际内容对不上、缩略图不合格、meta 不合格 400 bad_request；超大 413 too_large。
// • list {note_id}：本人这条隐私记里没删、已通过检查的附件（文件名已解密），按 id 排 → vaultFileListResponse。
// • get {id, part?}：解密后直接回字节（不是 JSON）：Content-Type 按 kind 取 DOC_TYPES（part = 'thumb' 时 image/webp），
//   Cache-Control: no-store、X-Content-Type-Options: nosniff。full 时在函数里核对 HMAC(sha256)，对不上回 500 corrupt、不给内容。
// • remove {id}：写 deleted_at（30 天后清理）；restore {id}：改回 null（提示条上的“撤销”）→ vaultFileOkResponse。
// • ms_preview {id}：只给本人、kind = pptx、已通过检查的隐私记附件。先删这个人之前的预览，再生成随机路径（32 位十六进制 + .pptx，
//   不含 user_id、note_id、文件名）、先登记 private.vault_preview、再把解密后的文件写进 vault-preview 桶，回签名链接
//   （同源相对地址 /sb/storage/v1/object/sign/vault-preview/…?token=…，客户端拼上 location.origin 交给微软）→ vaultFilePreviewResponse。
//   每人每小时 VAULT_PREVIEW_RATE_PER_HOUR 次（另外也算进每分钟的次数）。
// • ms_preview_end {}：立即删这个人的预览对象和登记（关预览、上锁、页面隐藏时调；页面隐藏和上锁用 fetch keepalive）→ vaultFileOkResponse。
//   只验 JWT、不要 x-vault-token（11-14 审查第 4 条：令牌过期上锁那一刻发的 end 原来会被拒，副本留到有效期满）。
// • sweep {}（x-cron-secret）：删过期登记和对象、删桶里没登记的旧对象、写心跳 vault-file-sweep。
// 文件名由服务器按 sanitizeFileName 清理后再加密（结果一定满足 note_files.name 的 check 约束，移出隐私记时直接写回明文列）。
import { z } from 'zod';
import { FILE_MAX_BYTES } from '../logic/files/limits.ts';
import { DOC_TYPES, type DocKind } from '../manifests/attachments.ts';
import { REJECT_REASONS } from './attachments.ts';

export const VAULT_FILE_FN = 'vault-file';

/** 错误码；HTTP 状态写在行尾。upgrade_required（426）、session_revoked、account_disabled、unauthorized 这些各函数共用的码照 B1 的处理，不列在这里 */
export const VAULT_FILE_ERROR_CODES = [
  'vault_locked',        // 401  没带令牌、令牌不对或过期
  'vault_relock',        // 401  令牌里的 pin_epoch 不是当前值（别处改过或重设过密码）
  'not_found',           // 404  附件、隐私记不存在、不是本人的、已删；ms_preview 时不是 pptx 或还没通过检查
  'exists',              // 409  upload：同 id 的行已经在
  'too_large',           // 413  请求体超过 VAULT_FILE_UPLOAD_MAX_BODY、原文件超过 10 MB、缩略图超过 128 KB
  'rejected',            // 422  upload：类型不认、压缩包异常、带密码、和 kind 不一致（带 reason）
  'quota_exceeded',      // 403  upload：超了存储额度或附件行数上限
  'rate_limited',        // 429  每人每分钟 30 次；ms_preview 每人每小时 20 次
  'bad_request',         // 400  请求不合格；upload 的 bytes、sha256 和实际内容对不上
  'corrupt',             // 500  get、ms_preview：解不开或 HMAC(sha256) 对不上，不给内容
  'try_later',           // 503  数据库、R2、Storage 暂时不通，或钥匙没配好
  'method_not_allowed',  // 405  不是 POST
] as const;
export const vaultFileErrorCode = z.enum(VAULT_FILE_ERROR_CODES);
export type VaultFileErrorCode = z.infer<typeof vaultFileErrorCode>;

/** 错误响应体：rejected 带 reason，其余只有 error */
export const vaultFileErrorBody = z.object({ error: z.string().min(1).max(64), reason: z.enum(REJECT_REASONS).optional() });
export type VaultFileErrorBody = z.infer<typeof vaultFileErrorBody>;

// ---------------- 常量（出处见行尾） ----------------
export const VAULT_FILE_THUMB_MAX_BYTES = 131072;          // 同普通附件缩略图（files_authorize、清单 attachments.ts 缩略图同插图）
export const VAULT_FILE_TEXT_MAX = 20000;                  // 同 note_files.text_excerpt 的 check
export const VAULT_FILE_NAME_MAX = 120;                    // 同 note_files.name 的 check（服务器再按 sanitizeFileName 清理）
/** upload 整个请求体上限：原文件 10 MB + 缩略图 128 KB + meta 和 multipart 分隔的余量 64 KB */
export const VAULT_FILE_UPLOAD_MAX_BODY = FILE_MAX_BYTES + VAULT_FILE_THUMB_MAX_BYTES + 65536;
export const VAULT_FILE_RATE_PER_MIN = 30;                 // 一般动作每人每分钟（同 vault-image）
export const VAULT_PREVIEW_RATE_PER_HOUR = 20;             // 架构 5.13 第 11 点“限流每人每小时 20 次”
/** 预览签名链接的有效期（秒）：和普通 PPT 的 ms 签名一样（functions/_lib/files-rules.ts 的 TTL.ms，tests/edge/vault-file.test.ts 核对） */
export const VAULT_PREVIEW_TTL_S = 300;
/** 心跳名（workers/lemo-ops/src/rules.ts 的 HEARTBEAT_RULES 已按这个名字配好 10 分钟） */
export const VAULT_FILE_HEARTBEAT = 'vault-file-sweep';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const ms = z.number().int().nonnegative();
const KINDS = Object.keys(DOC_TYPES) as [DocKind, ...DocKind[]];
export const vaultFileKind = z.enum(KINDS);

/** upload 的 meta 字段（JSON 字符串里的对象） */
export const vaultFileMeta = z.object({
  id: uuid,
  note_id: uuid,
  kind: vaultFileKind,
  name: z.string().min(1).max(1024),                       // 原样的文件名；服务器清理成 ≤ 120 字符再加密
  sha256: z.string().regex(/^[0-9a-f]{64}$/),              // 明文整个文件的 SHA-256（小写十六进制）
  bytes: z.number().int().positive().max(FILE_MAX_BYTES),  // 明文字节数，必须等于 file 字段的实际大小
  pages: z.number().int().nonnegative().max(100000).nullable(),
  text: z.string().max(VAULT_FILE_TEXT_MAX).nullable(),    // 抽出的文字（前 20000 字）
}).strict();
export type VaultFileMeta = z.infer<typeof vaultFileMeta>;

/** JSON 请求（upload 以外的动作） */
export const vaultFileRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), note_id: uuid }).strict(),
  z.object({ action: z.literal('get'), id: uuid, part: z.enum(['full', 'thumb']).optional() }).strict(),
  z.object({ action: z.literal('remove'), id: uuid }).strict(),
  z.object({ action: z.literal('restore'), id: uuid }).strict(),
  z.object({ action: z.literal('ms_preview'), id: uuid }).strict(),
  z.object({ action: z.literal('ms_preview_end') }).strict(),
  z.object({ action: z.literal('sweep') }).strict(),
]);
export type VaultFileRequest = z.infer<typeof vaultFileRequest>;
export type VaultFileAction = VaultFileRequest['action'] | 'upload';

/** 列表里的一项（文件名是服务器解密后的明文） */
export const vaultFileItem = z.object({
  id: uuid, note_id: uuid, kind: vaultFileKind, name: z.string(), bytes: z.number().int().positive(),
  pages: z.number().int().nullable(), has_thumb: z.boolean(), created_at: ms,
});
export type VaultFileItem = z.infer<typeof vaultFileItem>;

export const vaultFileUploadResponse = z.object({ ok: z.literal(true), file: vaultFileItem });
export const vaultFileListResponse = z.object({ ok: z.literal(true), files: z.array(vaultFileItem) });
export const vaultFileOkResponse = z.object({ ok: z.literal(true) });
/** url 是同源相对地址（/sb/storage/v1/object/sign/vault-preview/<32 位十六进制>.pptx?token=…）；expires_at 毫秒 */
export const vaultFilePreviewResponse = z.object({
  ok: z.literal(true),
  url: z.string().regex(/^\/sb\/storage\/v1\/object\/sign\/vault-preview\/[0-9a-f]{32}\.pptx\?token=[A-Za-z0-9._~%+=-]+$/).max(2048),
  expires_at: ms,
});
