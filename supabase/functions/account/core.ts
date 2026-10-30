// account 的处理逻辑（架构第 6 节函数表 account、“account delete”和“account-purge 怎么执行”的时序 1、2；
// 0.29 续第 88、92～96、129、131、134、137、138 条；0.38 第 45、47、48 条；TC-B1-95、98、99、100、103、104、108）。
// 数据库、Auth、发信、鉴权都由 index.ts 注入，Vitest 直接测这一份；不 import npm 包、不碰 Deno 全局。
//
// 四个 action（JWT；requireActiveUser 由 index.ts 注入成 authenticate）：
//   status  {action}：登录后判断要不要显示恢复页（10-30 架构师：冷静期里别的 RPC 都回 account_disabled，客户端分不出）。
//           冷静期放行；没有副作用：不写库、不计次数、不发信。管理员停用（含没有 profile）不当错误，回 200 {ok, status: 'disabled'}；
//           管理员停用排在会话检查前面，停用且会话已吊销时回 disabled，不回 session_revoked（R-256 ③）；
//           其余会话失效、没登录等照 requireActiveUser 原样回（session_revoked、unauthorized、try_later）。
//           → {ok, status: 'active'} / {ok, status: 'pending_deletion', purge_after} / {ok, status: 'disabled'}
//   delete  {action, confirm}：confirm 去掉首尾空白后等于“注销”或“탈퇴”（R-188）→ 管理员拒 → 每天 3 次（和 export 合计）
//           → rpc account_request_deletion（一个事务：pending_deletions、停用、吊销全部会话；0.38 第 45 条）→ {ok, purge_after}
//           → 响应之后发第一封信（不放链接，时刻按本人时区）。不删任何数据、不写 deleted_accounts。
//   restore {action}：和 status 一样在冷静期里放行（allowPendingDeletion）；amr 里 otp 在 10 分钟内 → 每天 5 次
//           → rpc account_restore（service role 调 definer 函数，先锁 pending_deletions 行再判断，和 account-purge 的认领互斥；
//           0.38 第 45 条）→ {ok} → 发“已恢复”。
//   export  分两步（架构 0.47 续 ①，0.47 第 4～19 条；一次调用只做一片，免得满载账号撞上每次 2 秒 CPU）：
//     start {action, step: 'start', device_id?}（可带 x-vault-token）：定模式 → 只读查当天次数（已满 429）→ 预检限流 export-size（每天 6 次）
//           → 大小预检 export_size_over（全库一次一个；超 480 MB 回 413 export_too_large，超时、忙、出错回 try_later，都不扣导出次数、
//           不写 logs、不发信，只记函数日志）→ 扣当天次数（和 delete 合计 3 次）→ export_job_start 建任务（键带会话）→ 写 logs export
//           （code = export_id）→ 响应之后发导出通知 → {ok, export_id, exported_at}。不读用户数据。
//           建任务、写 logs 失败退回当天这一次（每天最多退 3 次），并尽力删掉已建的任务行（N2）。
//     part  {action, step: 'part', export_id, cursor}：先扣每天分片数 export-part（72，超了 429）→ 校验 export_id 和游标（400）
//           → 定模式 → export_job_take（别的会话、别的用户、模式不一致、过期 410 export_expired；超 36 片 413 export_too_large）
//           → logs 里有本人这个 export_id 的发起记录（没有也 410，0.47 第 22 条 T2）
//           → 从游标处按主键翻页读（第一页 50 行，之后按平均行宽自适应），每写一行查一次本片 16 MB 预算 → 回这一片单独的 gzip 成员，
//           下一个游标在响应头 x-lemo-export-next（取完为 done）；最后一片写 logs export_done（片数、gzip 字节合计）。
//           读到别人的行、超行数、主键不前进等数据导致的失败只记 export_<码>、回 try_later。
//     没带 vault_token：包里不放隐私记的任何行，顶层 "vault": "omitted"；带了但无效或过期整个请求被拒（vault_locked / vault_relock）；
//     带了有效的：隐私记行只放密文列（R-184 选 a）；vault-images、vault-files 两个桶不进导出（export: none）。
//     清单 exportOmitCols 里的列不进包（devices 的推送订阅密钥和会话 id）。
// 错误码以 shared/schema/account.ts 的 accountErrorCode 为准（0.38 第 48 条），另有各函数共用的 bad_request、method_not_allowed。
// 日志只记错误码（A23）：不打印请求头、请求体、邮箱、JWT、vault_token。响应体不打印（导出内容）。
// 版本门：account 在免查名单里（0.38 第 47 条：只免 POST），函数里不查 X-App-Version。
// store 调用一律带超时（store-timeout.ts，0.47 第 22 条）：超时都回 try_later；start 扣了次数之后的超时退回（export.ts 的 fail），delete、restore 不退。
//
// 文件拆分（ACCOUNT-sugg ①，max-lines）：common.ts 放共用的常量、类型、响应和计数键、发信小工具；status.ts 放 status；
//   export.ts 放 export 的 start 和挑表、隐私记过滤、通知；export-part.ts 放 part（游标、翻页、gzip）。这里留入口、delete、restore，并把三个文件的导出原样转出——
//   index.ts、测试照旧只从 core.ts 引用。

import { deletionRequestedMail, restoredMail } from '../_shared/account-mail.ts';
import { ACCOUNT_DAILY_LIMIT, type ActiveUser, DAY_S, DbError, type Deps, err, json, keys, mailLater } from './common.ts';
import { partExport } from './export-part.ts';
import { startExport } from './export.ts';
import { status, statusDisabled } from './status.ts';
import { StoreTimeout } from './store-timeout.ts';

export * from './common.ts';
export * from './export.ts';
export * from './export-part.ts';
export * from './status.ts';
export * from './store-timeout.ts';

// ---------------- 常量（出处见行尾） ----------------
export const RESTORE_DAILY_LIMIT = 5;          // 每人每天 5 次（第 131 条④、附录 A restore:<user_id>:<UTC 日期>）
export const RESTORE_OTP_MAX_AGE_S = 600;      // amr 里 otp 在 10 分钟以内（第 131 条④）
export const CONFIRM_WORDS = ['注销', '탈퇴'] as const;   // R-188、0.29 续第 129 条
const MAX_BODY = 4096;

/** 打出的确认词：去掉首尾空白后完全等于“注销”或“탈퇴”（中间的空格、全角空格不去） */
export function confirmOk(v: unknown): boolean {
  return typeof v === 'string' && v.length <= 32 && (CONFIRM_WORDS as readonly string[]).includes(v.trim());
}

/** JWT payload（requireActiveUser 已验过签名，这里只读 amr） */
function claims(jwt: string): { amr?: unknown } {
  try {
    const part = jwt.split('.')[1];
    if (!part) return {};
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))) as { amr?: unknown };
  } catch {
    return {};
  }
}

/**
 * amr 里 otp 那一项在 maxAgeS 秒以内（第 131 条④：刚用邮箱验证码登录就满足）。
 * GoTrue 的写法是 [{method: 'otp', timestamp: 秒}]；只认 otp（magiclink、password 等不算），取最近的一次。
 */
export function otpFresh(jwt: string, nowMs: number, maxAgeS = RESTORE_OTP_MAX_AGE_S): boolean {
  const amr = claims(jwt).amr;
  if (!Array.isArray(amr)) return false;
  let latest = -Infinity;
  for (const e of amr) {
    if (typeof e !== 'object' || e === null) continue;
    const { method, timestamp } = e as { method?: unknown; timestamp?: unknown };
    if (method === 'otp' && typeof timestamp === 'number' && Number.isFinite(timestamp)) latest = Math.max(latest, timestamp);
  }
  if (latest === -Infinity) return false;
  const age = nowMs / 1000 - latest;
  return age >= -60 && age <= maxAgeS;   // 允许 1 分钟时钟误差
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => null);
  if (text === null || text.length > MAX_BODY) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------- delete（申请注销） ----------------
async function del(body: Record<string, unknown>, user: ActiveUser, deps: Deps): Promise<Response> {
  const { store } = deps;
  // ① 确认词不对：什么都不写（不计次数、不碰数据库）
  if (!confirmOk(body.confirm)) return err(400, 'confirm_required');
  // ② 管理员一律拒（rpc 里还有一道）
  if (await store.isAdmin(user.userId)) return err(403, 'admin_cannot_delete');
  // ③ export、delete 合计每天 3 次
  if (!(await store.takeRate(keys.account(user.userId, deps.now()), ACCOUNT_DAILY_LIMIT, DAY_S))) return err(429, 'rate_limited');
  // ④ 一个事务：pending_deletions、停用、吊销全部会话
  let purgeAfter: string;
  try {
    purgeAfter = await store.requestDeletion(user.userId);
  } catch (e) {
    if (e instanceof DbError && e.code === 'admin_cannot_delete') return err(403, 'admin_cannot_delete');
    if (e instanceof DbError && e.code === 'account_disabled') return err(403, 'account_disabled');
    if (e instanceof DbError && e.code === 'account_pending_deletion') return err(403, 'account_pending_deletion');
    throw e;
  }
  const pa = Date.parse(purgeAfter);
  // ⑤ 第一封信（响应之后发；时刻和 purge_after 一致，按本人时区）
  mailLater(deps, user.userId, (loc, tz) => deletionRequestedMail(loc, pa, tz), 'mail_failed:requested');
  return json(200, { ok: true, purge_after: purgeAfter });
}

// ---------------- restore（冷静期里恢复） ----------------
async function restore(user: ActiveUser, deps: Deps): Promise<Response> {
  const { store } = deps;
  // ① 刚用邮箱验证码登录（amr 里 otp 在 10 分钟内）；不计次数
  if (!otpFresh(user.jwt, deps.now())) return err(401, 'reauth_required');
  // ② 每天 5 次
  if (!(await store.takeRate(keys.restore(user.userId, deps.now()), RESTORE_DAILY_LIMIT, DAY_S))) return err(429, 'rate_limited');
  // ③ 锁行、判断、删行、清两列（一个事务）
  const r = await store.restore(user.userId);
  if (r === 'not_pending') return err(409, 'not_pending');
  if (r === 'purge_started' || r === 'expired') return err(409, 'restore_too_late');
  if (r === 'account_disabled') return err(403, 'account_disabled');
  if (r !== 'ok') throw new Error('bad_restore_result');
  mailLater(deps, user.userId, (loc) => restoredMail(loc), 'mail_failed:restored');
  return json(200, { ok: true });
}

// ---------------- 入口 ----------------
export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return err(405, 'method_not_allowed');
  const body = await readBody(req);
  if (!body || typeof body.action !== 'string') return err(400, 'bad_request');
  const action = body.action;
  if (action !== 'delete' && action !== 'restore' && action !== 'export' && action !== 'status') return err(400, 'bad_request');

  try {
    // 只有 restore、status 在冷静期里放行；管理员停用的（account_disabled）restore 也被 requireActiveUser 拦下
    const auth = await deps.authenticate(req, { allowPendingDeletion: action === 'restore' || action === 'status' });
    if (!auth.ok) {
      // status：管理员停用（含没有 profile）是一种状态，不是错误；其余（session_revoked、unauthorized、try_later）原样回
      if (action === 'status' && auth.code === 'account_disabled') return statusDisabled();
      return auth.response;
    }
    if (action === 'status') return status(auth.user);
    if (action === 'delete') return await del(body, auth.user, deps);
    if (action === 'restore') return await restore(auth.user, deps);
    // export 分两步（0.47 续 ①）：start 建任务、part 取一片；没写 step 或写错一律 bad_request
    if (body.step === 'start') return await startExport(req, body, auth.user, deps);
    if (body.step === 'part') return await partExport(req, body, auth.user, deps);
    return err(400, 'bad_request');
  } catch (e) {
    // 错误对象可能带连接信息、SQL，不打印；超时在 store-timeout.ts 已记 store_timeout:<方法名>，不再记 db_error
    if (!(e instanceof StoreTimeout)) deps.log?.('db_error');
    return err(503, 'try_later');
  }
}
