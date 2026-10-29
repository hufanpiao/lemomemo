// account 的处理逻辑（架构第 6 节函数表 account、“account delete”和“account-purge 怎么执行”的时序 1、2；
// 0.29 续第 88、92～96、129、131、134、137、138 条；0.38 第 45、47、48 条；TC-B1-95、98、99、100、103、104、108）。
// 数据库、Auth、发信、鉴权都由 index.ts 注入，Vitest 直接测这一份；不 import npm 包、不碰 Deno 全局。
//
// 四个 action（JWT；requireActiveUser 由 index.ts 注入成 authenticate）：
//   status  {action}：登录后判断要不要显示恢复页（10-30 架构师：冷静期里别的 RPC 都回 account_disabled，客户端分不出）。
//           冷静期放行；没有副作用：不写库、不计次数、不发信。管理员停用（含没有 profile）不当错误，回 200 {ok, status: 'disabled'}；
//           会话失效、没登录等照 requireActiveUser 原样回（session_revoked、unauthorized、try_later）。
//           → {ok, status: 'active'} / {ok, status: 'pending_deletion', purge_after} / {ok, status: 'disabled'}
//   delete  {action, confirm}：confirm 去掉首尾空白后等于“注销”或“탈퇴”（R-188）→ 管理员拒 → 每天 3 次（和 export 合计）
//           → rpc account_request_deletion（一个事务：pending_deletions、停用、吊销全部会话；0.38 第 45 条）→ {ok, purge_after}
//           → 响应之后发第一封信（不放链接，时刻按本人时区）。不删任何数据、不写 deleted_accounts。
//   restore {action}：和 status 一样在冷静期里放行（allowPendingDeletion）；amr 里 otp 在 10 分钟内 → 每天 5 次
//           → rpc account_restore（service role 调 definer 函数，先锁 pending_deletions 行再判断，和 account-purge 的认领互斥；
//           0.38 第 45 条）→ {ok} → 发“已恢复”。
//   status  {action}：冷静期放行、没有副作用（不写库、不计次、不发信）→ {ok, status: active / pending_deletion（带 purge_after）/ disabled}；
//           管理员停用排在会话检查前面，停用且会话已吊销时回 disabled，不回 session_revoked（R-256 ③）。
//   export  {action, device_id?}（请求头可带 x-vault-token）：每天 3 次（和 delete 合计）→ 先写一条 logs（写不进就 try_later、不导出）
//           → 按数据清单读本人各表（按主键往后翻页，每张表有行数上限，logs 另算）→ 边读边压缩成 gzip（内存里只留压缩后的块，
//           原文总字节有上限）→ 直接回 gzip 的 JSON（attachment、no-store，不发下载链接）→ 响应之后发导出通知；
//           发信失败另记一条 logs（act = export_mail_failed，code = 对应 export 那一行的 t 的 ISO 字符串，两行靠它配对），不当作“没导出”。
//           计次以后的失败都回 try_later；写不进 logs、数据库出错这类临时性失败把当天这一次退回去（K3 安全审查必改 2），
//           数据本身导致的（超行数、超字节、读到别人的行等）照常扣次数（K3 复审 B）。
//           没带 vault_token：包里不放隐私记的任何行，顶层 "vault": "omitted"；带了但无效或过期整个请求被拒（vault_locked / vault_relock）；
//           带了有效的：隐私记行只放密文列（R-184 选 a）；vault-images、vault-files 两个桶不进导出（export: none）。
//           清单 exportOmitCols 里的列不进包（devices 的推送订阅密钥和会话 id）。
// 错误码以 shared/schema/account.ts 的 accountErrorCode 为准（0.38 第 48 条），另有各函数共用的 bad_request、method_not_allowed。
// 日志只记错误码（A23）：不打印请求头、请求体、邮箱、JWT、vault_token。响应体不打印（导出内容）。
// 版本门：account 在免查名单里（0.38 第 47 条：只免 POST），函数里不查 X-App-Version。

import {
  deletionRequestedMail, exportMail, mailLocale, restoredMail, type Mail, type MailLocale,
} from '../_shared/account-mail.ts';
import { readProxyHeaders } from '../_shared/proxy-headers.ts';

// ---------------- 常量（出处见行尾） ----------------
export const ACCOUNT_DAILY_LIMIT = 3;          // export、delete 合计每人每天 3 次（第 6 节、附录 A account:<user_id>:<UTC 日期>）
/** 导出临时性失败每人每天最多退回 3 次，超过就照常扣（K3 复审低 2；键 export-refund:<user_id>:<UTC 日期>，和 account 键同一天口径） */
export const EXPORT_REFUND_DAILY_LIMIT = 3;
export const RESTORE_DAILY_LIMIT = 5;          // 每人每天 5 次（第 131 条④、附录 A restore:<user_id>:<UTC 日期>）
export const RESTORE_OTP_MAX_AGE_S = 600;      // amr 里 otp 在 10 分钟以内（第 131 条④）
export const CONFIRM_WORDS = ['注销', '탈퇴'] as const;   // R-188、0.29 续第 129 条
export const EXPORT_PAGE = 1000;               // PostgREST 默认每次最多 1000 行，按主键往后翻页（gt），不用 offset
export const EXPORT_MAX_ROWS = 25_000;         // 同步表每张上限 2 万行（row_quota），多读一点余量；超过就当数据异常
/** logs 不受 row_quota 管：每人每天最多 2,000 条、保留 90 天（第 6 节 logs、3.4），最多约 18 万行，再加 2 万行余量 */
export const EXPORT_MAX_LOG_ROWS = 2000 * 90 + 20_000;
/**
 * 原文（JSON）总字节上限。边读边压缩，内存里只留一页原文和压缩后的块：
 * 同步表约 10 张 × 2 万行、logs 20 万行，正常账号原文几十 MB，压缩后几 MB；超过这个数就整次失败（退回次数），不让一个账号撑爆函数内存
 */
export const EXPORT_MAX_RAW_BYTES = 256 * 1024 * 1024;
const DAY_S = 86400;
const MAX_BODY = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** 清单里 export: json 的 public 表（index.ts 从 _shared/gen/manifests 算出来；测试从 shared/manifests 算） */
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

interface ManifestLike {
  tables: readonly {
    name: string; schema: string; export: string;
    exportOmitCols?: readonly string[] | undefined;
    vaultRows?: { flag: string; cipherCols: readonly string[]; neutralCols: readonly string[] } | undefined;
  }[];
}

/** 按数据清单（3.5）挑出要导出的表：public、export = 'json'。private 的表、export: none 的表一律不进（第 83 条） */
export function exportTablesOf(manifests: readonly ManifestLike[]): ExportTable[] {
  const out: ExportTable[] = [];
  for (const m of manifests) {
    for (const t of m.tables) {
      if (t.schema !== 'public' || t.export !== 'json') continue;
      const base = {
        name: t.name,
        keyCol: t.name === 'profiles' ? ('user_id' as const) : ('id' as const),
        maxRows: t.name === 'logs' ? EXPORT_MAX_LOG_ROWS : EXPORT_MAX_ROWS,
        omitCols: [...(t.exportOmitCols ?? [])],
      };
      out.push(t.vaultRows ? { ...base, vaultRows: t.vaultRows } : base);
    }
  }
  return out;
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
  /** 原文总字节上限（默认 EXPORT_MAX_RAW_BYTES；测试注入小值） */
  exportMaxRawBytes?: number;
}

// ---------------- 小工具 ----------------
const NO_STORE = { 'cache-control': 'no-store' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE } });
}
const err = (status: number, code: AccountErr, extra: Record<string, unknown> = {}) => json(status, { error: code, ...extra });

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

/** 方向控制符和零宽字符（U+200B～U+200F、U+202A～U+202E、U+2066～U+2069，另加 U+FEFF）：能把名字倒着显示、藏东西 */
const BIDI_ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
// eslint-disable-next-line no-control-regex -- 就是要去掉控制字符（C0、DEL、C1）
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** 像域名、网址、IP、邮箱的：名字里有任何点或句号（. 。 ． ｡，NFKC 以后 ． 变 .、｡ 变 。）一律算——非拉丁顶级域（.中国、.рф、.한국）、
 *  IP、混写字母（西里尔 о）都绕不过（K3 复审 A）；另有 @、://、www */
const LINK_LIKE = /[.\u3002\uff0e\uff61]|@|:\/\/|www/i;
/** 像电话号码的：7 位以上数字，中间只隔空白、横线、括号、斜杠、加号、下划线（02-1234-5678、010 1234 5678、全角数字 NFKC 后同样）。
 *  防止安全通知里出现“请回拨”的话术（K3 复审低 1）；iPhone 15 Pro、Galaxy S24 不受影响。用 \p{Nd} 认各种文字的数字 */
const PHONE_LIKE = /(?:\p{Nd}[\s\p{Pd}()/+_]*){6}\p{Nd}/u;

/**
 * 设备名放进邮件正文前清一下（K3 安全审查必改 1：设备名是用户自己写的，拿到会话的人也能改，不能让它变成钓鱼文案）：
 * NFKC 规整 → 去掉方向控制符、零宽字符、控制字符 → 像域名、网址、邮箱的一律整个不用（返回 null，邮件里写通用的“未知设备”）
 * → 截到 40 个字符。判断在截断之前做，截断只为版面。
 */
export function cleanDeviceLabel(v: string | null): string | null {
  if (v === null) return null;
  const s = v.normalize('NFKC').replace(BIDI_ZERO_WIDTH, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!s || LINK_LIKE.test(s) || PHONE_LIKE.test(s)) return null;
  return [...s].slice(0, 40).join('');
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

async function mailInfo(deps: Deps, userId: string): Promise<{ email: string; loc: MailLocale; tz: string | null } | null> {
  const [email, prof] = await Promise.all([deps.userEmail(userId), deps.store.profile(userId)]);
  if (!email) return null;
  return { email, loc: mailLocale(prof?.ui_locale), tz: prof?.current_tz ?? null };
}

/** 响应之后发信；失败只记错误码（邮件不是这一步成败的依据） */
function mailLater(deps: Deps, userId: string, make: (loc: MailLocale, tz: string | null) => Mail, failCode: string): void {
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

// ---------------- status（账号状态，登录页用） ----------------
/** status 回的三种状态（和 shared/schema/account.ts 的 ACCOUNT_STATUSES 一字不差，测试核对） */
export const ACCOUNT_STATUS_VALUES = ['active', 'pending_deletion', 'disabled'] as const;

/** 只看鉴权结果，不碰 store、不发信、不计次数 */
function status(user: ActiveUser): Response {
  if (user.pendingDeletion) return json(200, { ok: true, status: 'pending_deletion', purge_after: user.pendingDeletion.purgeAfter });
  return json(200, { ok: true, status: 'active' });
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

// ---------------- export ----------------
type VaultMode = 'omitted' | 'cipher';

/** 导出中途失败的原因（写进日志的码是 export_<它>） */
class ExportError extends Error {}

/** 行是不是隐私记行：flag 写成列名（is_private、is_vault）或 "col = 'value'"（note_images 的 bucket = 'vault-images'） */
export function isVaultRow(row: Record<string, unknown>, flag: string): boolean {
  const m = /^\s*([a-z_][a-z0-9_]*)\s*=\s*'([^']*)'\s*$/.exec(flag);
  if (m) { const col = m[1] ?? ''; return (Object.hasOwn(row, col) ? row[col] : undefined) === m[2]; }   // 只取自有属性（check_backend F7）
  if (!/^[a-z_][a-z0-9_]*$/.test(flag)) throw new ExportError('bad_vault_flag');   // 认不出的写法不猜，整次导出失败
  return (Object.hasOwn(row, flag) ? row[flag] : undefined) === true;
}

function flagCols(flag: string): string[] {
  const m = /^\s*([a-z_][a-z0-9_]*)/.exec(flag);
  return m?.[1] ? [m[1]] : [];
}

/**
 * 一张表的导出行：普通行原样；隐私记行没带令牌时整行不要，带了有效令牌只留密文列和不含内容的列（含 flag 列）；
 * 最后去掉清单 exportOmitCols 的列
 */
export function exportRows(t: ExportTable, rows: readonly Record<string, unknown>[], mode: VaultMode): Record<string, unknown>[] {
  const v = t.vaultRows;
  const keep = v ? new Set([...v.cipherCols, ...v.neutralCols, ...flagCols(v.flag)]) : null;
  const omit = new Set(t.omitCols);
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    let row = r;
    if (v && keep && isVaultRow(r, v.flag)) {
      if (mode === 'omitted') continue;
      row = Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k)));
    }
    out.push(omit.size ? Object.fromEntries(Object.entries(row).filter(([k]) => !omit.has(k))) : row);
  }
  return out;
}

/** 边写边压缩：原文按块进 CompressionStream，压缩后的块收进数组；内存里不留整份原文 */
class GzipSink {
  rawBytes = 0;
  private readonly maxRaw: number;
  private readonly writer: ReturnType<CompressionStream['writable']['getWriter']>;
  private readonly chunks: Promise<Uint8Array[]>;
  private readonly enc = new TextEncoder();

  constructor(maxRaw: number) {
    this.maxRaw = maxRaw;
    const cs = new CompressionStream('gzip');
    this.writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    this.chunks = (async () => {
      const out: Uint8Array[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return out;
        out.push(value);
      }
    })();
    this.chunks.catch(() => {});   // abort 时读端也报错，这里不算未处理
  }

  async write(text: string): Promise<void> {
    const b = this.enc.encode(text);
    this.rawBytes += b.byteLength;
    if (this.rawBytes > this.maxRaw) throw new ExportError('too_large');
    await this.writer.write(b);
  }

  /** 收尾，拼成一整块（只拼压缩后的字节） */
  async close(): Promise<ArrayBuffer> {
    await this.writer.close();
    const parts = await this.chunks;
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.byteLength; }
    return out.buffer;
  }

  abort(): void {
    this.writer.abort().catch(() => {});
  }
}

/** 按主键往后翻页读一张表，读一页写一页；读到别人的行、超过这张表的上限、主键不前进都整次失败 */
async function writeTable(deps: Deps, sink: GzipSink, t: ExportTable, userId: string, mode: VaultMode): Promise<void> {
  let after: string | number | null = null;
  let n = 0;
  let first = true;
  for (;;) {
    const page = await deps.store.readPage(t.name, t.keyCol, userId, after, EXPORT_PAGE);
    for (const r of page) {
      if (r.user_id !== userId) throw new ExportError('foreign_row');   // service role 绕过 RLS：读到别人的行就整次失败，不往包里放
    }
    n += page.length;
    if (n > t.maxRows) throw new ExportError('too_many_rows');
    const rows = exportRows(t, page, mode);
    if (rows.length) {
      await sink.write((first ? '' : ',') + rows.map((r) => JSON.stringify(r)).join(','));
      first = false;
    }
    if (page.length < EXPORT_PAGE) return;
    const lastRow = page.at(-1);
    const last: unknown = t.keyCol === 'user_id' ? lastRow?.user_id : lastRow?.id;   // 只有这两种主键（不用方括号取列，check_backend F7）
    if ((typeof last !== 'string' && typeof last !== 'number') || last === after) throw new ExportError('bad_page_key');   // 防止翻不动时死循环
    after = last;
  }
}

/** 整份导出（gzip）。中途失败抛 ExportError 或数据库的错，压缩到一半的块丢掉 */
async function buildExport(deps: Deps, userId: string, now: number, mode: VaultMode): Promise<ArrayBuffer> {
  const sink = new GzipSink(deps.exportMaxRawBytes ?? EXPORT_MAX_RAW_BYTES);
  try {
    const head = { format: 'lemomemo-export', version: 1, exported_at: new Date(now).toISOString(), user_id: userId, vault: mode };
    await sink.write(`${JSON.stringify(head).slice(0, -1)},"tables":{`);
    let firstTable = true;
    for (const t of deps.exportTables) {
      await sink.write(`${firstTable ? '' : ','}${JSON.stringify(t.name)}:[`);
      firstTable = false;
      await writeTable(deps, sink, t, userId, mode);
      await sink.write(']');
    }
    await sink.write('}}');
    return await sink.close();
  } catch (e) {
    sink.abort();
    throw e;
  }
}

async function exportData(req: Request, body: Record<string, unknown>, user: ActiveUser, deps: Deps): Promise<Response> {
  const { store } = deps;
  const deviceId = typeof body.device_id === 'string' && UUID.test(body.device_id) ? body.device_id.toLowerCase() : null;
  if (body.device_id !== undefined && body.device_id !== null && deviceId === null) return err(400, 'bad_request');

  // ① 隐私记令牌：没带不拒（包里不放隐私记）；带了就必须有效（第 93、94 条）
  const token = req.headers.get('x-vault-token');
  let mode: VaultMode = 'omitted';
  if (token !== null) {
    if (token === '' || token.length > 2048) return err(401, 'vault_locked');
    const v = await deps.verifyVaultToken(user.userId, token);
    if (v !== 'ok') return err(401, v);
    mode = 'cipher';
  }
  // ② 每天 3 次（和 delete 合计）
  const now = deps.now();
  const rateKey = keys.account(user.userId, now);
  if (!(await store.takeRate(rateKey, ACCOUNT_DAILY_LIMIT, DAY_S))) return err(429, 'rate_limited');
  // 计次以后失败：只有临时性失败（写不进 logs、数据库出错）退回这一次，重试有望成功、不该占当天的额度；
  // 数据本身导致的失败（ExportError：too_large、too_many_rows、foreign_row、bad_page_key、bad_vault_flag）每次重试都一样，
  // 照常扣次数——否则塞满数据就能无限次触发“读几百 MB 再压缩”（K3 复审 B）
  const fail = async (code: string, refund: boolean): Promise<Response> => {
    deps.log?.(code);
    if (refund) {
      try {
        // 退回也有每天上限：反复制造临时性失败（比如故意打满数据库）不能换来无限次导出
        if (await store.takeRate(keys.exportRefund(user.userId, now), EXPORT_REFUND_DAILY_LIMIT, DAY_S)) await store.refundRate(rateKey);
        else deps.log?.('export_refund_capped');
      } catch {
        deps.log?.('export_refund_failed');
      }
    }
    return err(503, 'try_later');
  };
  // ③ 先记录：写不进就不导出（第 96 条②）
  try {
    await store.insertLog(user.userId, { t: now, device: deviceId, kind: 'run', act: 'export', src: 'account' });
  } catch {
    return await fail('export_log_failed', true);
  }
  // ④ 读各表、边读边压缩
  let gz: ArrayBuffer;
  try {
    gz = await buildExport(deps, user.userId, now, mode);
  } catch (e) {
    // 错误对象可能带连接信息、SQL，不打印；只记我们自己的码
    return e instanceof ExportError ? await fail(`export_${e.message}`, false) : await fail('db_error', true);
  }

  // ⑤ 响应之后发通知；发信失败另记一条（不当作“没导出”）
  const proxy = readProxyHeaders(req, deps.proxySecret);
  deps.background((async () => {
    let sent = false;
    try {
      const [info, label] = await Promise.all([
        mailInfo(deps, user.userId),
        deviceId ? store.deviceLabel(user.userId, deviceId).catch(() => null) : Promise.resolve(null),
      ]);
      if (info) sent = await deps.sendMail(info.email, exportMail(info.loc, now, info.tz, cleanDeviceLabel(label), proxy.geo)).catch(() => false);
    } catch {
      sent = false;
    }
    if (!sent) {
      deps.log?.('mail_failed:export');
      // t 是发信失败的时刻；code 写 export 那一行的 t（ISO），同一台设备连着导出两次也配得准
      //   （logs 没有唯一约束，两种都行；不让两行 t 相同，是为了留下失败时刻，t 也照旧是“发生时刻”）
      await store.insertLog(user.userId, {
        t: deps.now(), device: deviceId, kind: 'run', act: 'export_mail_failed', src: 'account', code: new Date(now).toISOString(),
      })
        .catch(() => deps.log?.('export_mail_log_failed'));
    }
  })());

  return new Response(gz, {
    status: 200,
    headers: {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="lemomemo-export-${utcDate(now)}.json.gz"`,
      'x-content-type-options': 'nosniff',
      ...NO_STORE,
    },
  });
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
      if (action === 'status' && auth.code === 'account_disabled') return json(200, { ok: true, status: 'disabled' });
      return auth.response;
    }
    if (action === 'status') return status(auth.user);
    if (action === 'delete') return await del(body, auth.user, deps);
    if (action === 'restore') return await restore(auth.user, deps);
    return await exportData(req, body, auth.user, deps);
  } catch {
    // 错误对象可能带连接信息、SQL，不打印
    deps.log?.('db_error');
    return err(503, 'try_later');
  }
}
