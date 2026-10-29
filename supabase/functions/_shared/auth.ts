// 带 JWT 的函数一律先过 requireActiveUser（第 6 节）；cron 按用户处理前用 isUsable（0.29 续第 138 条：只经 private.account_usable 判断）
// admin = 用 service role 建的 supabase-js 客户端（绕过 RLS，所以这里必须自己查停用和会话）
// 部署时函数没有 import map，写全 npm: 版本（和 package.json 一致，tests/build/deno-config.test.ts 核对）
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';

export type AuthCode = 'unauthorized' | 'account_disabled' | 'account_pending_deletion' | 'session_revoked' | 'try_later';

export class AuthError extends Error {
  readonly code: AuthCode;
  readonly status: number;
  readonly purgeAfter: string | undefined;
  constructor(code: AuthCode, status: number, purgeAfter?: string) {
    super(code);
    this.code = code;
    this.status = status;
    this.purgeAfter = purgeAfter;
  }
  toResponse(headers: HeadersInit = {}): Response {
    const body = this.purgeAfter ? { error: this.code, purge_after: this.purgeAfter } : { error: this.code };
    return new Response(JSON.stringify(body), { status: this.status, headers: { ...headers, 'content-type': 'application/json' } });
  }
}

export type Usable = { ok: true } | { ok: false; code: 'account_disabled' | 'account_pending_deletion'; purgeAfter?: string | undefined };

const RPC_TIMEOUT_MS = 2000;   // 0.29 续第 110 条：查会话超时或出错一律不放行

async function timed<T>(p: PromiseLike<T>): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new AuthError('try_later', 503)), RPC_TIMEOUT_MS); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
}

/**
 * 账号能不能用：唯一的判断是 private.account_usable（profile 存在且 disabled_at 为空）。
 * 不能用时再看原因：注销冷静期（disabled_reason = 'deletion'）回 account_pending_deletion 和 purge_after，其余（admin、没有 profile）回 account_disabled。
 * 查询出错抛 try_later，不当成“能用”。
 */
export async function isUsable(admin: SupabaseClient, userId: string): Promise<Usable> {
  const { data: ok, error } = await timed(admin.schema('private').rpc('account_usable', { p_user: userId }));
  if (error || typeof ok !== 'boolean') throw new AuthError('try_later', 503);
  if (ok) return { ok: true };

  const prof = await timed(admin.from('profiles').select('disabled_reason').eq('user_id', userId).maybeSingle());
  if (prof.error) throw new AuthError('try_later', 503);
  if ((prof.data as { disabled_reason: string | null } | null)?.disabled_reason !== 'deletion') return { ok: false, code: 'account_disabled' };

  const pd = await timed(admin.schema('private').from('pending_deletions').select('purge_after').eq('user_id', userId).maybeSingle());
  if (pd.error) throw new AuthError('try_later', 503);
  const purgeAfter = (pd.data as { purge_after: string } | null)?.purge_after;
  return { ok: false, code: 'account_pending_deletion', purgeAfter };
}

type Claims = { sub?: string; session_id?: string; amr?: unknown };

/** JWT 的 payload（只在 getUser 验过以后读，不单独信任） */
function claims(jwt: string): Claims {
  try {
    const part = jwt.split('.')[1];
    if (!part) return {};
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')));
  } catch {
    return {};
  }
}

/**
 * 密码会话（架构 0.36 第 1 条 ②，TC-B1-111）：amr 是数组，元素两种写法都认——对象 {method: 'password', timestamp: …}（GoTrue 文档）
 * 和裸字符串 'password'（B0 第四轮 QA 真库实测记作 amr = ["password"]）。
 * 只认 password（黑名单）：otp、magiclink、recovery、email_change 等照常；刷新出来的令牌沿用原会话的 amr，照样被拒。
 * 和 SQL 一侧 private.not_password_session() 同一口径（0.38）：没有 amr 放行；有 amr 但不是数组（含 null、字符串）当密码会话拒。
 */
function isPasswordSession(c: Claims): boolean {
  if (c.amr === undefined) return false;
  if (!Array.isArray(c.amr)) return true;
  return c.amr.some((e: unknown) => e === 'password'
    || (typeof e === 'object' && e !== null && (e as { method?: unknown }).method === 'password'));
}

/**
 * pendingDeletion：只在 allowPendingDeletion 放行了冷静期账号时才有（purgeAfter 取不到 pending_deletions 行时为 null）；
 * account 的 status 靠它分出“正常”和“冷静期”，其余函数不会拿到冷静期账号，不用看它
 */
export type ActiveUser = { userId: string; sessionId: string; jwt: string; pendingDeletion?: { purgeAfter: string | null } };

/**
 * 验 JWT → 不是密码会话（amr 里没有 password，0.36）→ 账号能不能用 → 会话还在不在、有没有被吊销（private.session_alive）。
 * allowPendingDeletion：只有 account 的 restore、status 传 true，冷静期里放行（返回值带 pendingDeletion）。
 * 不通过抛 AuthError，函数入口 catch 后 return e.toResponse(cors)。
 */
export async function requireActiveUser(req: Request, admin: SupabaseClient, opts: { allowPendingDeletion?: boolean } = {}): Promise<ActiveUser> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!m) throw new AuthError('unauthorized', 401);
  const jwt = m[1];
  if (!jwt) throw new AuthError('unauthorized', 401);

  const { data, error } = await timed(admin.auth.getUser(jwt));
  // Auth 服务出错不算“没登录”：5xx、429（限流），以及连不上——supabase-js 2.x 把网络错误报成 AuthRetryableFetchError、status 为 0
  const st = error ? (error as { status?: number }).status : undefined;
  if (error && (st === undefined || st === 0 || st === 429 || st >= 500)) throw new AuthError('try_later', 503);
  if (error || !data.user) throw new AuthError('unauthorized', 401);
  const userId = data.user.id;
  const c = claims(jwt);
  if (c.sub !== userId || !c.session_id) throw new AuthError('unauthorized', 401);
  // 0.36：密码会话按“没登录”处理（401 unauthorized，不加新错误码，客户端回登录页）
  if (isPasswordSession(c)) throw new AuthError('unauthorized', 401);

  const u = await isUsable(admin, userId);
  if (!u.ok && !(u.code === 'account_pending_deletion' && opts.allowPendingDeletion)) {
    throw new AuthError(u.code, 403, u.code === 'account_pending_deletion' ? u.purgeAfter : undefined);
  }

  const { data: alive, error: e2 } = await timed(admin.schema('private').rpc('session_alive', { p_session: c.session_id }));
  if (e2 || typeof alive !== 'boolean') throw new AuthError('try_later', 503);   // 数据库一抖不能把所有人当成“被移除”
  if (!alive) throw new AuthError('session_revoked', 401);

  return u.ok ? { userId, sessionId: c.session_id, jwt } : { userId, sessionId: c.session_id, jwt, pendingDeletion: { purgeAfter: u.purgeAfter ?? null } };
}
