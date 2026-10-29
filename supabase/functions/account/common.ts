// account 几个 action 共用的常量、注入依赖的类型、响应和计数键小工具、响应之后发信（ACCOUNT-sugg ①：从 core.ts 拆出）。
// 只被 account/ 下的 core.ts、status.ts、export.ts 引用，不反过来 import 它们（没有循环依赖）；对外一律经 core.ts 转出。
// 和 core.ts 同样的约束：不 import npm 包、不碰 Deno 全局，Vitest 直接测。

import { mailLocale, type Mail, type MailLocale } from '../_shared/account-mail.ts';

// ---------------- 常量（出处见行尾） ----------------
export const ACCOUNT_DAILY_LIMIT = 3;          // export、delete 合计每人每天 3 次（第 6 节、附录 A account:<user_id>:<UTC 日期>）
export const DAY_S = 86400;

/**
 * account 自己的 11 个错误码。和 shared/schema/account.ts 的 ACCOUNT_ERROR_CODES（accountErrorCode，0.38 第 48 条，前后端共用）
 * 必须一字不差：tests/functions/account.test.ts 核对，index.ts 启动时也核对一次（对不上记 error_codes_drift）。
 * 这里不 import 它：core.ts 要在 Vitest 和 unit 的 tsc 里跑，那时 _shared/gen/ 还没生成。
 */
export const ACCOUNT_ERRS = [
  'confirm_required', 'admin_cannot_delete', 'rate_limited', 'reauth_required', 'not_pending', 'restore_too_late',
  'account_disabled', 'account_pending_deletion', 'vault_locked', 'vault_relock', 'try_later',
] as const;
/** 回给客户端的错误码：account 自己的 11 个加各函数共用的两个 */
export type AccountErr = (typeof ACCOUNT_ERRS)[number] | 'bad_request' | 'method_not_allowed';

// ---------------- 注入的依赖 ----------------
/** pendingDeletion：只在 allowPendingDeletion 放行了冷静期账号时才有（_shared/auth.ts 的 requireActiveUser） */
export interface ActiveUser { userId: string; sessionId: string; jwt: string; pendingDeletion?: { purgeAfter: string | null } | undefined }
/** 没过时 code = requireActiveUser 的错误码（AuthError.code）；status 靠它把 account_disabled 变成 {status: 'disabled'} */
export type AuthResult = { ok: true; user: ActiveUser } | { ok: false; response: Response; code?: string | undefined };

/** 清单里 export: json 的 public 表（index.ts 从 _shared/gen/manifests 算出来；测试从 shared/manifests 算；挑表见 export.ts 的 exportTablesOf） */
export interface ExportTable {
  name: string;
  /** 排序、翻页用的主键列（profiles 是 user_id，其余是 id） */
  keyCol: 'id' | 'user_id';
  /** 这张表最多读多少行（超过整次失败） */
  maxRows: number;
  /** 导出时去掉的列（清单的 exportOmitCols） */
  omitCols: readonly string[];
  /** 同一张表里既有普通行又有隐私记行的（notes、note_images、note_files） */
  vaultRows?: { flag: string; cipherCols: readonly string[]; neutralCols: readonly string[] } | undefined;
}

/** code：只有 export_mail_failed 带，写对应 export 那一行 t 的 ISO 字符串（24 个字符，logs.code ≤ 64） */
export interface LogRow { t: number; device: string | null; kind: 'run'; act: 'export' | 'export_mail_failed'; src: 'account'; code?: string }

/** 数据库（index.ts 用 service role 的 supabase-js 实现）。出错一律抛错，code 用 DbError 带出 rpc 抛的业务错误 */
export interface AccountStore {
  isAdmin(userId: string): Promise<boolean>;
  /** private.take_rate：true = 放行 */
  takeRate(key: string, limit: number, windowS: number): Promise<boolean>;
  /** 退回一次：这个键最新窗口的 count 减 1（比较并交换，不减到 0 以下）。出错抛错，调用方只记日志 */
  refundRate(key: string): Promise<void>;
  /** rpc private.account_request_deletion：返回 purge_after（ISO）。业务拒绝抛 DbError(code) */
  requestDeletion(userId: string): Promise<string>;
  /** rpc private.account_restore：ok / not_pending / purge_started / expired / account_disabled */
  restore(userId: string): Promise<string>;
  /** profiles 的 ui_locale、current_tz（发信用）；没有返回 null */
  profile(userId: string): Promise<{ ui_locale: string | null; current_tz: string | null } | null>;
  /** 本人这台设备的名字（devices.label，按 id 和 user_id 一起查）；查不到返回 null */
  deviceLabel(userId: string, deviceId: string): Promise<string | null>;
  insertLog(userId: string, row: LogRow): Promise<void>;
  /**
   * 读本人一张表的一页：where user_id = $userId [and keyCol > after] order by keyCol limit $limit。
   * 按主键往后翻页（K3 安全审查低 7），不用 offset；service role 绕过 RLS，所以这里必须带 user_id 条件
   */
  readPage(table: string, keyCol: string, userId: string, after: string | number | null, limit: number): Promise<Record<string, unknown>[]>;
}

export class DbError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface Deps {
  authenticate(req: Request, opts: { allowPendingDeletion: boolean }): Promise<AuthResult>;
  store: AccountStore;
  /** auth.admin.getUserById 的邮箱；取不到返回 null */
  userEmail(userId: string): Promise<string | null>;
  sendMail(to: string, mail: Mail): Promise<boolean>;
  /** 验 vault_token（B5 的 _shared/vault-token.ts：HMAC、过期、pin_epoch） */
  verifyVaultToken(userId: string, token: string): Promise<'ok' | 'vault_locked' | 'vault_relock'>;
  exportTables: readonly ExportTable[];
  proxySecret: string | undefined;
  /** 响应之后还要做的事（EdgeRuntime.waitUntil）；测试里收集起来 await */
  background(p: Promise<unknown>): void;
  now: () => number;
  log?: (code: string) => void;
  /** 原文总字节上限（默认 export.ts 的 EXPORT_MAX_RAW_BYTES；测试注入小值） */
  exportMaxRawBytes?: number;
}

// ---------------- 小工具 ----------------
export const NO_STORE = { 'cache-control': 'no-store' };

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE } });
}
export const err = (status: number, code: AccountErr, extra: Record<string, unknown> = {}) => json(status, { error: code, ...extra });

/** UTC 日期 yyyymmdd（计数键第三段；和 invite-signup 同一写法） */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

/** 计数键（附录 A；都得过 counters 的 check 约束，单测核对） */
export const keys = {
  account: (uid: string, ms: number) => `account:${uid}:${utcDate(ms)}`,
  restore: (uid: string, ms: number) => `restore:${uid}:${utcDate(ms)}`,
  exportRefund: (uid: string, ms: number) => `export-refund:${uid}:${utcDate(ms)}`,
};

export async function mailInfo(deps: Deps, userId: string): Promise<{ email: string; loc: MailLocale; tz: string | null } | null> {
  const [email, prof] = await Promise.all([deps.userEmail(userId), deps.store.profile(userId)]);
  if (!email) return null;
  return { email, loc: mailLocale(prof?.ui_locale), tz: prof?.current_tz ?? null };
}

/** 响应之后发信；失败只记错误码（邮件不是这一步成败的依据） */
export function mailLater(deps: Deps, userId: string, make: (loc: MailLocale, tz: string | null) => Mail, failCode: string): void {
  deps.background((async () => {
    try {
      const info = await mailInfo(deps, userId);
      if (!info) { deps.log?.(`${failCode}:no_email`); return; }
      const ok = await deps.sendMail(info.email, make(info.loc, info.tz)).catch(() => false);
      if (!ok) deps.log?.(failCode);
    } catch {
      deps.log?.(failCode);
    }
  })());
}
