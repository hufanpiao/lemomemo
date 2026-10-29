// invite-admin 的处理逻辑（架构 5.6 发码、第 6 节函数表 invite-admin、3.3 F、15.4 S-B1；R-83；TC-B1-01、TC-B1-70）。
// 数据库、鉴权、版本门的配置读取都由 index.ts 注入，Vitest 直接测这一份；不 import npm 包、不碰 Deno 全局。
//
// 只有管理员能用（R-83）：JWT（requireActiveUser 由 index.ts 注入成 authenticate）→ 在 private.admins 里 → 版本门 → 动作。
//   create {action, note?}：备注含控制字符、孤立代理项、双向覆盖字符回 bad_request；去掉首尾空白，空的当没写；
//          超过 40 个字符回 note_too_long（这两种都在计次数之前，不计次数）
//          → 每人每天 20 次（键 invite-admin:<user_id>:<UTC 日期>）→ 生成 12 位码（_shared/invite-code.ts，约 60 bit）
//          → 库里只存哈希（code_hash = inviteCodeHash），7 天有效，只能用 1 次 → 回 {code, expires_at}（明文码只出现在这一次响应里）。
//   list   {action}：本人发过、还没过期的码（不含码本身，库里也没有）：备注、已用次数、上限、过期时刻；不计次数。
// 错误码以 shared/schema/invite-admin.ts 的 inviteAdminErrorCode 为准，另有各函数共用的 bad_request、method_not_allowed。
// 日志只记错误码（A23）：不打印请求头、请求体、邀请码、备注。

import { inviteCodeHash, randomInviteCode } from '../_shared/invite-code.ts';
import { blockedMin, upgradeRequiredResponse } from '../_shared/version-gate-core.ts';

// ---------------- 常量（出处见行尾） ----------------
export const INVITE_DAILY_LIMIT = 20;          // 每人每天 20 次（第 6 节函数表 invite-admin）
export const INVITE_TTL_S = 7 * 86400;         // 7 天有效（5.6）
export const INVITE_MAX_USES = 1;              // 只能用 1 次（5.6）
export const NOTE_MAX = 40;                    // private.invites.note 的 check：char_length(note) <= 40（0001_core.sql）
export const LIST_LIMIT = 100;                 // list 最多回这么多条（每天最多发 20 个、7 天过期，正常不会超过 140）
const DAY_S = 86400;
const MAX_BODY = 4096;
/** 生成的码撞上已有的 code_hash（约 60 bit，几乎不会）时重新生成的次数 */
const INSERT_ATTEMPTS = 3;

/**
 * invite-admin 自己的 4 个错误码。和 shared/schema/invite-admin.ts 的 INVITE_ADMIN_ERROR_CODES 必须一字不差：
 * tests/functions/invite-admin.test.ts 核对，index.ts 启动时也核对一次（对不上记 error_codes_drift）。
 * 这里不 import 它：core.ts 要在 Vitest 和 unit 的 tsc 里跑，那时 _shared/gen/ 还没生成（同 account）。
 */
export const INVITE_ADMIN_ERRS = ['not_admin', 'note_too_long', 'rate_limited', 'try_later'] as const;
export type InviteAdminErr = (typeof INVITE_ADMIN_ERRS)[number] | 'bad_request' | 'method_not_allowed';

// ---------------- 注入的依赖 ----------------
export interface ActiveUser { userId: string; sessionId: string; jwt: string }
export type AuthResult = { ok: true; user: ActiveUser } | { ok: false; response: Response };

export interface InviteInsert {
  code_hash: string;
  created_by: string;
  max_uses: number;
  used_count: number;
  expires_at: string;
  note: string | null;
}

export interface InviteListRow {
  note: string | null;
  max_uses: number | null;
  used_count: number | null;
  expires_at: string | null;
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
  /** 本人发的、expires_at > notExpiredAt 的码，按 expires_at 倒序，最多 limit 条；只读 note、max_uses、used_count、expires_at */
  listInvites(createdBy: string, notExpiredAt: string, limit: number): Promise<InviteListRow[]>;
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
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
const err = (status: number, code: InviteAdminErr) => json(status, { error: code });

/** UTC 日期 yyyymmdd（计数键第三段；和 invite-signup、account 同一写法） */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

/** 计数键（附录 A 的三段格式；得过 counters 的 check 约束，单测核对） */
export const keys = {
  create: (uid: string, ms: number) => `invite-admin:${uid}:${utcDate(ms)}`,
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

// ---------------- 版本门（第 6 节：函数里的第二道；口径同 functions/sb/version-gate.ts，比较用 _shared/version-gate-core.ts） ----------------
async function versionBlock(req: Request, store: InviteStore): Promise<Response | null> {
  let min: string | null;
  try {
    min = await store.minClientVersion();
  } catch {
    return null;   // 读配置失败就放行（同转发层、invite-signup）
  }
  const b = blockedMin(min, req.headers.get('x-app-version'));
  return b === null ? null : upgradeRequiredResponse(b);
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
async function list(userId: string, deps: Deps): Promise<Response> {
  const rows = await deps.store.listInvites(userId, new Date(deps.now()).toISOString(), LIST_LIMIT);
  // 只回这四列（库里本来也没有明文码；不回 code_hash）
  const invites = rows.map((r) => ({ note: r.note, max_uses: r.max_uses, used_count: r.used_count, expires_at: r.expires_at }));
  return json(200, { invites });
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
    const blocked = await versionBlock(req, deps.store);
    if (blocked) return blocked;

    const body = await readBody(req);
    if (!body) return err(400, 'bad_request');
    if (body.action === 'create') return await create(body, userId, deps);
    if (body.action === 'list') return await list(userId, deps);
    return err(400, 'bad_request');
  } catch {
    // 错误对象可能带连接信息、SQL，不打印
    deps.log?.('db_error');
    return err(503, 'try_later');
  }
}
