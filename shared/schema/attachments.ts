// file-check 函数的请求和响应（架构 5.13 第 2 点“服务器 fn file-check”、第 6 节 file-check 行；B4b-1）。前后端共用这一份。
// • 客户端（带 JWT）：{action: 'check', id} —— 上传完调一次；回这一行现在的结果
// • cron（带 x-cron-secret）：{action: 'sweep'} —— 每 10 分钟补扫 created_at 早于 30 分钟、还在 pending 的行
// • 客户端（带 JWT）：{action: 'retry_ai', kind: 'image', id} —— 识图“没识别 · 重新识别”（架构 5.13 第 5 点，线框 sAIst；B4b-2 识图）：
//   本人普通插图 ai_status = failed 的改回 pending（ai_tries 清零），回 {ai_status}；不是 failed 的原样回现在的状态。这一批只有图片（kind 只收 image）
// 回的 status：ok 通过；rejected 没通过（对象已删，reason 是给界面的四种原因之一）；incomplete 原文件还不在（客户端补传再调，最多 3 次）；
//   pending 不会回（判不出时回 503 try_later）。行不是本人的、是隐私记的、已删的一律 404 not_found
import { z } from 'zod';

export const FILE_CHECK_FN = 'file-check';

/** 被拒的原因（界面“这个文件没能加上：…”的四种写法；R-408 加 encrypted） */
export const REJECT_REASONS = ['unknown', 'too_big', 'bad_archive', 'encrypted'] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const fileCheckReq = z.discriminatedUnion('action', [
  z.object({ action: z.literal('check'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('sweep') }).strict(),
  z.object({ action: z.literal('retry_ai'), kind: z.literal('image'), id: z.uuid() }).strict(),
]);
export type FileCheckReq = z.infer<typeof fileCheckReq>;

export const fileCheckRes = z.union([
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('rejected'), reason: z.enum(REJECT_REASONS).optional() }),
  z.object({ status: z.literal('incomplete') }),
]);
export type FileCheckRes = z.infer<typeof fileCheckRes>;

/** retry_ai 的回答：改完以后这张图的识别状态 */
export const AI_STATUSES = ['pending', 'done', 'skip', 'failed'] as const;
export const retryAiRes = z.object({ ai_status: z.enum(AI_STATUSES) });
export type RetryAiRes = z.infer<typeof retryAiRes>;

/** 错误码（HTTP 状态写在行尾）；session_revoked、upgrade_required 这些各函数共用的码照 B1 的处理 */
export const FILE_CHECK_ERRORS = ['not_found', 'rate_limited', 'try_later', 'bad_request', 'method_not_allowed'] as const;
