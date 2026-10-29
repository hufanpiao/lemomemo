// account 的 status action（账号状态，登录后判断要不要显示恢复页；ACCOUNT-sugg ①：从 core.ts 拆出）。
// 只看鉴权结果，不碰 store、不发信、不计次数。对外经 core.ts 转出。

import { type ActiveUser, json } from './common.ts';

/** status 回的三种状态（和 shared/schema/account.ts 的 ACCOUNT_STATUSES 一字不差，测试核对） */
export const ACCOUNT_STATUS_VALUES = ['active', 'pending_deletion', 'disabled'] as const;

/** 鉴权通过：冷静期里回 pending_deletion（带 purge_after），否则 active */
export function status(user: ActiveUser): Response {
  if (user.pendingDeletion) return json(200, { ok: true, status: 'pending_deletion', purge_after: user.pendingDeletion.purgeAfter });
  return json(200, { ok: true, status: 'active' });
}

/** 鉴权回 account_disabled（管理员停用，含没有 profile）：是一种状态，不是错误 */
export function statusDisabled(): Response {
  return json(200, { ok: true, status: 'disabled' });
}
