// invite-admin 函数的错误码（架构第 6 节函数表 invite-admin、5.6 发码；R-83）：前后端共用一份。
// 服务器：supabase/functions/invite-admin/core.ts 只回这里的码（另有各函数共用的 bad_request、method_not_allowed，
//   以及 _shared/auth.ts 的 requireActiveUser 回的 unauthorized、account_disabled、account_pending_deletion、session_revoked、try_later，
//   版本门的 upgrade_required，入口的 misconfigured，不在本表）；前端设置 › 邀请朋友按这里认码、按 2.4 翻译。
// 加码、改码要同时改架构第 6 节（码、HTTP 状态、前端怎么处理）。
import { z } from 'zod';

export const INVITE_ADMIN_ERROR_CODES = [
  'not_admin',      // 403  调用者不在 private.admins 里（R-83：只有管理员能发码）
  'note_too_long',  // 400  备注超过 40 个字符（private.invites.note 的 check 约束，0001）
  'rate_limited',   // 429  发码每人每天 20 次
  'try_later',      // 503  数据库暂时不通
] as const;

export const inviteAdminErrorCode = z.enum(INVITE_ADMIN_ERROR_CODES);
export type InviteAdminErrorCode = z.infer<typeof inviteAdminErrorCode>;

/** 备注最多 40 个字符（按 Unicode 码点数，和 Postgres 的 char_length 同一口径） */
export const INVITE_NOTE_MAX = 40;
