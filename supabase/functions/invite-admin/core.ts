// invite-admin 的处理逻辑（架构 5.6 发码、第 6 节函数表 invite-admin、3.3 F、15.4 S-B1；R-83；TC-B1-01、TC-B1-70）。
// 数据库、鉴权、版本门的配置读取都由 index.ts 注入，Vitest 直接测这一份；不 import npm 包、不碰 Deno 全局。
//
// 只有管理员能用（R-83）：JWT（requireActiveUser 由 index.ts 注入成 authenticate）→ 在 private.admins 里 → 版本门 → 动作。
//   create {action, note?}：备注含控制字符、孤立代理项、双向覆盖字符回 bad_request；去掉首尾空白，空的当没写；
//          超过 40 个字符回 note_too_long（这两种都在计次数之前，不计次数）
//          → 每人每天 20 次（键 invite-admin:<user_id>:<UTC 日期>）→ 生成 12 位码（_shared/invite-code.ts，约 60 bit）
//          → 库里只存哈希（code_hash = inviteCodeHash），7 天有效，只能用 1 次 → 回 {code, expires_at}（明文码只出现在这一次响应里）。
//   list   {action}：本人发过、还没过期的码（不含码本身，库里也没有）：标识 id、备注、已用次数、上限、过期时刻；不计次数。
//          id = code_hash 的前 8 位十六进制（32 bit，见 inviteIdOf）：拿它反推不出码，也认不出是哪个码（约 60 bit 的码空间里
//          同一个前缀有约 2^28 个码），只够在本人的列表里指定一行；同一份列表里前 8 位撞了的几行改用前 16 位。
//   revoke {action, id}：作废本人发的、还没用、还没过期的一个码（负责人 11-27“生产的邀请码可以查看跟废除”，选了“只加作废”）。
//          id 不是 8 或 16 位小写十六进制回 bad_request；按前缀找本人没过期的行，不正好 1 行（没有、撞了）或已用完回 not_found；
//          找到就比较并交换：update set expires_at = REVOKED_EXPIRES_AT（1970-01-01）where code_hash、created_by、used_count 都对得上、
//          expires_at 还没过；改到 0 行（刚好被人占上、刚过期）同样 not_found。作废以后它和过期的码一样：invite-signup 的
//          start（inviteUsable 要 expires_at > now）、verify 的 invite_claim（expires_at > p_now）都不认，list 也不再列出。不计次数。
// 错误码以 shared/schema/invite-admin.ts 的 inviteAdminErrorCode 为准，另有各函数共用的 bad_request、method_not_allowed。
// 日志只记错误码（A23）：不打印请求头、请求体、邀请码、备注。

import type { AuthResult as SharedAuthResult } from '../_shared/auth-result.ts';
import { readJsonObjectCapped } from '../_shared/body.ts';
import { inviteCodeHash, randomInviteCode } from '../_shared/invite-code.ts';
import { json } from '../_shared/http.ts';
import { utcDayKey } from '../_shared/rate-key.ts';
import { StoreTimeout } from '../_shared/store-timeout.ts';
import { versionBlock } from '../_shared/version-gate-core.ts';

// ---------------- 常量（出处见行尾） ----------------
export const INVITE_DAILY_LIMIT = 20;          // 每人每天 20 次（第 6 节函数表 invite-admin）
export const INVITE_TTL_S = 7 * 86400;         // 7 天有效（5.6）
export const INVITE_MAX_USES = 1;              // 只能用 1 次（5.6）
export const NOTE_MAX = 40;                    // private.invites.note 的 check：char_length(note) <= 40（0001_core.sql）
export const LIST_LIMIT = 100;                 // list 最多回这么多条（每天最多发 20 个、7 天过期，正常不会超过 140）
export const INVITE_ID_LEN = 8;                // list 每行的标识：code_hash 前 8 位十六进制
export const INVITE_ID_LONG = 16;              // 同一份列表里前 8 位撞了的行改用前 16 位
/**
 * 作废时把 expires_at 改成这一刻（1970-01-01）：比“改成现在”稳——invite-signup 拿它自己的时钟（p_now）比，两个函数的时钟差一点
 * 也不会留出一个还能注册的空当；和自然过期（发码时刻 + 7 天）也分得开，查库时看得出是作废的。不改表结构（架构 5.6）
 */
export const REVOKED_EXPIRES_AT = new Date(0).toISOString();
/** revoke 收的 id：8 位或 16 位小写十六进制（只有这两种长度，拼进 like 前缀也不会带通配符） */
const INVITE_ID = /^[0-9a-f]{8}(?:[0-9a-f]{8})?$/;
const DAY_S = 86400;
const MAX_BODY = 4096;
/** 生成的码撞上已有的 code_hash（约 60 bit，几乎不会）时重新生成的次数 */
const INSERT_ATTEMPTS = 3;

/**
 * invite-admin 自己的 5 个错误码。和 shared/schema/invite-admin.ts 的 INVITE_ADMIN_ERROR_CODES 必须一字不差：
 * tests/functions/invite-admin.test.ts 核对，index.ts 启动时也核对一次（对不上记 error_codes_drift）。
 * 这里不 import 它：core.ts 要在 Vitest 和 unit 的 tsc 里跑，那时 _shared/gen/ 还没生成（同 account）。
 */
export const INVITE_ADMIN_ERRS = ['not_admin', 'note_too_long', 'rate_limited', 'try_later', 'not_found'] as const;
export type InviteAdminErr = (typeof INVITE_ADMIN_ERRS)[number] | 'bad_request' | 'method_not_allowed';

// ---------------- 注入的依赖 ----------------
export interface ActiveUser { userId: string; sessionId: string; jwt: string }
export type AuthResult = SharedAuthResult<ActiveUser>;

export interface InviteInsert {
  code_hash: string;
  created_by: string;
  max_uses: number;
  used_count: number;
  expires_at: string;
  note: string | null;
}

export interface InviteListRow {
  /** 只在函数里用来算 id，不回给前端 */
  code_hash: string;
  note: string | null;
  max_uses: number | null;
  used_count: number | null;
  expires_at: string | null;
}

/** revoke 按前缀找到的行（只读这三列） */
export interface InviteLiveRow {
  code_hash: string;
  max_uses: number | null;
  used_count: number | null;
}

/** 插入结果：ok；duplicate = code_hash 撞了（主键冲突，换一个码重来）。其余出错抛错 */
export type InsertResult = 'ok' | 'duplicate';

/** 数据库（index.ts 用 service role 的 supabase-js 实现，private 表经 schema('private')）。出错一律抛错 */
export interface InviteStore {
  /** private.admins 里有没有这个人 */
  isAdmin(userId: string): Promise<boolean>;
  /** private.take_rate：true = 放行 */
  takeRate(key: string, limit: number, windowS: number): Promise<boolean>;
  /** insert into private.invites */
  insertInvite(row: InviteInsert): Promise<InsertResult>;
  /** 本人发的、expires_at > notExpiredAt 的码，按 expires_at 倒序，最多 limit 条；只读 code_hash、note、max_uses、used_count、expires_at */
  listInvites(createdBy: string, notExpiredAt: string, limit: number): Promise<InviteListRow[]>;
  /** 本人发的、code_hash 以 idPrefix 开头、expires_at > notExpiredAt 的码，最多 limit 条；只读 code_hash、max_uses、used_count */
  findLiveInvites(createdBy: string, idPrefix: string, notExpiredAt: string, limit: number): Promise<InviteLiveRow[]>;
  /**
   * 作废（比较并交换）：update set expires_at = expiresAt where code_hash = codeHash and created_by = createdBy
   *   and used_count = usedCount and expires_at > notExpiredAt；改到 1 行回 true，0 行回 false
   */
  expireInvite(codeHash: string, createdBy: string, usedCount: number, notExpiredAt: string, expiresAt: string): Promise<boolean>;
  /** app_config.min_client_version（经 _shared/version-gate.ts 的缓存和超时）；读不到返回 null（放行） */
  minClientVersion(): Promise<string | null>;
}

export interface Deps {
  authenticate(req: Request): Promise<AuthResult>;
  store: InviteStore;
  now: () => number;
  /** 生成邀请码（默认 randomInviteCode；测试注入固定值） */
  newCode?: () => string;
  log?: (code: string) => void;
}

// ---------------- 小工具 ----------------
const err = (status: number, code: InviteAdminErr) => json(status, { error: code });

/** 计数键（附录 A 的三段格式；得过 counters 的 check 约束，单测核对） */
export const keys = {
  create: (uid: string, ms: number) => utcDayKey('invite-admin', uid, ms),
};

// eslint-disable-next-line no-control-regex -- 就是要拒绝控制字符（C0 含 U+0000、DEL、C1）
const NOTE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** 双向覆盖、嵌入、隔离字符（U+202A～U+202E、U+2066～U+2069），零宽字符和方向标记（U+200B～U+200F、U+061C），行、段分隔符（U+2028、U+2029）：能把备注倒着显示、藏东西、断行（复查建议）。源码里一律写转义 */
const NOTE_BIDI = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\u061c\u2028\u2029]/;
/** 孤立的代理项（高代理后面没有低代理，或低代理前面没有高代理）：不是合法的 Unicode，Postgres 也存不进 */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * 备注：undefined、null、去掉首尾空白后为空的 → null；不是字符串、含控制字符（C0 含 U+0000、DEL、C1；换行、制表也算）、
 * 孤立代理项、双向覆盖字符 → 'bad'（安全审查必改 2；在原值上判断，去空白之前）；超过 40 个字符（按码点，和 char_length 一致）→ 'too_long'。
 * 只写编号或日期，不准写名字（0001 的注释、R-83）——这一条服务器判断不了，靠界面提示。
 */
export function parseNote(v: unknown): string | null | 'bad' | 'too_long' {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return 'bad';
  if (NOTE_CONTROL.test(v) || NOTE_BIDI.test(v) || LONE_SURROGATE.test(v)) return 'bad';
  const s = v.trim();
  if (!s) return null;
  return [...s].length > NOTE_MAX ? 'too_long' : s;
}

// ---------------- create ----------------
async function create(body: Record<string, unknown>, userId: string, deps: Deps): Promise<Response> {
  const { store } = deps;
  // ① 备注不对：什么都不写（不计次数）
  const note = parseNote(body.note);
  if (note === 'bad') return err(400, 'bad_request');
  if (note === 'too_long') return err(400, 'note_too_long');
  // ② 每人每天 20 次
  const now = deps.now();
  if (!(await store.takeRate(keys.create(userId, now), INVITE_DAILY_LIMIT, DAY_S))) return err(429, 'rate_limited');
  // ③ 生成码，只存哈希
  const expiresAt = new Date(now + INVITE_TTL_S * 1000).toISOString();
  for (let i = 0; i < INSERT_ATTEMPTS; i++) {
    const code = (deps.newCode ?? randomInviteCode)();
    const r = await store.insertInvite({
      code_hash: await inviteCodeHash(code),
      created_by: userId,
      max_uses: INVITE_MAX_USES,
      used_count: 0,
      expires_at: expiresAt,
      note,
    });
    if (r === 'ok') return json(200, { code, expires_at: expiresAt });
  }
  deps.log?.('code_collision');
  return err(503, 'try_later');
}

// ---------------- list ----------------
/**
 * 每行的标识：code_hash 前 8 位；同一份里前 8 位相同的几行改用前 16 位（本人 7 天内最多 140 个码，前 8 位撞上的机会约百万分之二）。
 * 16 位也撞了（约 10^-15）不再加长：revoke 按前缀找到不止 1 行回 not_found，不会作废错。
 */
export function inviteIdOf(hashes: readonly string[]): (hash: string) => string {
  const seen = new Map<string, number>();
  for (const h of hashes) {
    const s = h.slice(0, INVITE_ID_LEN);
    seen.set(s, (seen.get(s) ?? 0) + 1);
  }
  return (h) => h.slice(0, (seen.get(h.slice(0, INVITE_ID_LEN)) ?? 0) > 1 ? INVITE_ID_LONG : INVITE_ID_LEN);
}

async function list(userId: string, deps: Deps): Promise<Response> {
  const rows = await deps.store.listInvites(userId, new Date(deps.now()).toISOString(), LIST_LIMIT);
  // 只回这五项（库里本来也没有明文码；不回完整的 code_hash，只回前 8 位 / 16 位的 id）
  const idOf = inviteIdOf(rows.map((r) => r.code_hash));
  const invites = rows.map((r) => ({ id: idOf(r.code_hash), note: r.note, max_uses: r.max_uses, used_count: r.used_count, expires_at: r.expires_at }));
  return json(200, { invites });
}

// ---------------- revoke ----------------
async function revoke(body: Record<string, unknown>, userId: string, deps: Deps): Promise<Response> {
  const id = body.id;
  if (typeof id !== 'string' || !INVITE_ID.test(id)) return err(400, 'bad_request');
  const now = new Date(deps.now()).toISOString();
  // 取 2 行就够判断“正好 1 行”；已用完的也算在内（前缀撞上一个已用完的码同样当认不准，不作废）
  const rows = await deps.store.findLiveInvites(userId, id, now, 2);
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row || row.max_uses === null || row.used_count === null || row.used_count >= row.max_uses) return err(404, 'not_found');
  if (!(await deps.store.expireInvite(row.code_hash, userId, row.used_count, now, REVOKED_EXPIRES_AT))) return err(404, 'not_found');
  return json(200, { ok: true });
}

// ---------------- 入口 ----------------
export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return err(405, 'method_not_allowed');
  try {
    // ① JWT、账号能用、会话没被吊销（_shared/auth.ts 的 requireActiveUser）
    const auth = await deps.authenticate(req);
    if (!auth.ok) return auth.response;
    const { userId } = auth.user;
    // ② 只有管理员（R-83）。不是管理员的请求不读配置、不读请求体、不计次数
    if (!(await deps.store.isAdmin(userId))) return err(403, 'not_admin');
    // ③ 版本门（不在免查名单里，一律查）
    const blocked = await versionBlock(req, () => deps.store.minClientVersion());   // 第 6 节：函数里的第二道，读配置失败放行
    if (blocked) return blocked;

    const body = await readJsonObjectCapped(req, MAX_BODY);   // 边读边计字节，超了中断（安全审查第 2 条）
    if (body === null || body === 'too_large') return err(400, 'bad_request');
    if (body.action === 'create') return await create(body, userId, deps);
    if (body.action === 'list') return await list(userId, deps);
    if (body.action === 'revoke') return await revoke(body, userId, deps);
    return err(400, 'bad_request');
  } catch (e) {
    // 错误对象可能带连接信息、SQL，不打印；超时在 store-timeout 已记 store_timeout:<方法名>，不再记 db_error
    if (!(e instanceof StoreTimeout)) deps.log?.('db_error');
    return err(503, 'try_later');
  }
}
