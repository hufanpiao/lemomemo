// account 函数的错误码（架构第 6 节“account 的错误码”，0.38 第 48 条）：前后端共用一份。
// 服务器：supabase/functions/account/core.ts 只回这里的码（另有各函数共用的 bad_request、method_not_allowed、unauthorized、
//   session_revoked、upgrade_required、misconfigured，不在本表）；前端设置页按这里认码、按 2.4 翻译。
// 加码、改码要同时改架构第 6 节那张表（码、HTTP 状态、前端怎么处理）。
import { z } from 'zod';

export const ACCOUNT_ERROR_CODES = [
  'confirm_required',          // 400  delete 的确认词不是“注销”或“탈퇴”
  'admin_cannot_delete',       // 403  管理员申请注销
  'rate_limited',              // 429  delete、export 每天合计 3 次；restore 每天 5 次
  'reauth_required',           // 401  restore 要 10 分钟内用邮箱验证码登录过
  'not_pending',               // 409  restore 时不在冷静期
  'restore_too_late',          // 409  account-purge 已认领或已到期
  'account_disabled',          // 403  管理员停用
  'account_pending_deletion',  // 403  冷静期里调 restore 以外的动作
  'vault_locked',              // 401  export 带的 vault_token 无效、为空或过期
  'vault_relock',              // 401  export 带的 vault_token 的 pin_epoch 过时
  'try_later',                 // 503  数据库、写日志等暂时不通
] as const;

export const accountErrorCode = z.enum(ACCOUNT_ERROR_CODES);
export type AccountErrorCode = z.infer<typeof accountErrorCode>;

// account {action: 'status'} 的返回（10-30 架构师：登录页靠它判断要不要显示恢复页）：冷静期放行、不写库、不计次数、不发信。
// 管理员停用（含没有 profile）回 disabled，不是 403；会话失效、没登录照旧回 {error}（session_revoked、unauthorized、try_later）。
// 服务器：supabase/functions/account/core.ts 的 ACCOUNT_STATUS_VALUES 和这里一字不差（tests/functions/account.test.ts 核对）。
export const ACCOUNT_STATUSES = ['active', 'pending_deletion', 'disabled'] as const;

export const accountStatusResponse = z.discriminatedUnion('status', [
  z.object({ ok: z.literal(true), status: z.literal('active') }),
  // purge_after：ISO 时刻；冷静期但取不到 pending_deletions 行时为 null（不该出现，前端按“冷静期、时刻未知”处理）
  z.object({ ok: z.literal(true), status: z.literal('pending_deletion'), purge_after: z.string().nullable() }),
  z.object({ ok: z.literal(true), status: z.literal('disabled') }),
]);
export type AccountStatusResponse = z.infer<typeof accountStatusResponse>;
