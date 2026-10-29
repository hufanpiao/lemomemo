// usage-report 的处理逻辑（架构第 6 节函数表、6.1、0.29 续第 116、143 条；TC-B1-94 ①、TC-B1-102 ⑤）。
// 不 import npm 包、不碰 Deno 全局：数据库读取由 index.ts 注入，Vitest 直接测这一份。
// 鉴权只认 x-ops-secret（单独一把，不和 CRON_SECRET 共用）；日志只记错误码，不打印请求头、请求体（A23）。

/** 查数据库出错或超过这个时长就回 503 db_unreachable（0.29 续第 116 条①） */
export const DB_TIMEOUT_MS = 5_000;

export interface HeartbeatRow {
  name: string;
  at: string;
  detail: unknown;
}

export interface PendingDeletionRow {
  purge_after: string;
  purge_started_at: string | null;
}

/** 发信量的读取单独计时（比整轮的 DB_TIMEOUT_MS 短）：到点 auth_mail 给 null，心跳那几项照常回 200 */
export const AUTH_MAIL_TIMEOUT_MS = 2_000;

/**
 * 发信量（架构 15.6 第 4d 条 ①、0.38 第 12 条），两个数口径和来源不同：
 * - `auth_1h`：过去 1 小时 **Supabase Auth（GoTrue）发出的验证码邮件**数。来源定为 `auth.audit_log_entries`
 *   （经一个只给 service_role 的 private 定义者函数读，S1 合并后再接）；
 * - `resend_24h`：过去 24 小时 **经 Resend 发出的所有邮件合计**（验证码、invite-signup、注销通知、lemo-ops 告警都算），
 *   对照 Resend 每天 100 封的额度。要一把有读权限的 Resend 密钥，**暂不接**：缺省或 null 表示没接。
 */
export interface AuthMailCounts {
  auth_1h: number;
  resend_24h?: number | null;
}

/** 各读取都必须尊重 signal（超时后中止） */
export interface UsageDb {
  heartbeats(signal: AbortSignal): Promise<HeartbeatRow[]>;
  pendingDeletions(signal: AbortSignal): Promise<PendingDeletionRow[]>;
  /** private.long_transactions() 的行数（超过 4 分钟的事务，0.29 续第 141 条） */
  longTxCount(signal: AbortSignal): Promise<number>;
  /**
   * 发信量（0.38 第 12 条，口径见 AuthMailCounts）。**还没接**：index.ts 暂不提供这一项，返回体里就没有 `auth_mail`，
   * lemo-ops 不查这一件。接上以后：单独计时 AUTH_MAIL_TIMEOUT_MS；出错、超时、数字不对只让 `auth_mail` 为 null
   * （日志记 auth_mail:error / auth_mail:timeout / auth_mail:bad_data），不连累心跳那几项。
   */
  authMail?(signal: AbortSignal): Promise<AuthMailCounts>;
}

export interface Deps {
  opsSecret: string | undefined;
  /** null = 函数没配好（缺 SUPABASE_URL 或 service role key）；鉴权之后才回 misconfigured */
  db: UsageDb | null;
  now: () => number;
  timeoutMs?: number;
  /** 发信量读取的单独超时（测试用；默认 AUTH_MAIL_TIMEOUT_MS） */
  authMailTimeoutMs?: number;
  log?: (code: string) => void;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** OPS_SECRET 至少 32 字节（UTF-8），短了按没配置好处理 */
export const MIN_SECRET_BYTES = 32;

/** heartbeat.detail 只转发这些数字字段（cleanup 的 rows、ms；push-dispatch 的 sent、failed；account-purge 的 purged），其余一律丢掉 */
export const DETAIL_FIELDS = ['rows', 'ms', 'sent', 'failed', 'purged'] as const;

type TimingSafeEqual = (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView) => boolean;

/**
 * 定长比较，免得按响应时间猜密钥。两边先各算 SHA-256（长度一样、不泄露长度），
 * 运行环境有 crypto.subtle.timingSafeEqual（Cloudflare Workers）就用它；Supabase 函数跑在 Deno 上，
 * Deno 2.9.8 没有这个方法（10-29 实测 typeof 为 undefined），就对两段摘要逐字节异或比较。
 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const tse = (crypto.subtle as unknown as { timingSafeEqual?: TimingSafeEqual }).timingSafeEqual;
  if (typeof tse === 'function') return tse.call(crypto.subtle, da, db);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

class DbTimeout extends Error {}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** 返回体里的 auth_mail：resend_24h 没接时固定写 null */
interface AuthMailOut {
  auth_1h: number;
  resend_24h: number | null;
}

function pickAuthMail(r: unknown): AuthMailOut | null {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return null;
  const { auth_1h: h, resend_24h: d } = r as Record<string, unknown>;
  if (!isCount(h)) return null;
  if (d === undefined || d === null) return { auth_1h: h, resend_24h: null };
  return isCount(d) ? { auth_1h: h, resend_24h: d } : null;
}

const TIMED_OUT = Symbol('timeout');

/**
 * 开始读发信量，单独计时：done 一定 resolve（出错、超时、数字不对都给 null，只记错误码）。
 * stop()：整轮已经失败（503 / 500）时调用，中止读取、清掉计时器，之后不再记任何日志。
 */
function startAuthMail(read: (signal: AbortSignal) => Promise<AuthMailCounts>, ms: number, log?: (code: string) => void) {
  const ctl = new AbortController();
  let quiet = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const say = (code: string) => {
    if (!quiet) log?.(code);
  };
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      // 先记“超时”再中止：读取方收到 abort 立刻拒绝时，记的仍是 timeout、不是 error
      timedOut = true;
      resolve(TIMED_OUT);
      ctl.abort();
    }, ms);
  });
  const done = (async (): Promise<AuthMailOut | null> => {
    try {
      const r: unknown = await Promise.race([read(ctl.signal), timeout]);
      if (r === TIMED_OUT) {
        say('auth_mail:timeout');
        return null;
      }
      const out = pickAuthMail(r);
      if (out === null) say('auth_mail:bad_data');
      return out;
    } catch {
      say(timedOut ? 'auth_mail:timeout' : 'auth_mail:error');
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  })();
  return {
    done,
    stop() {
      quiet = true;
      if (timer !== undefined) clearTimeout(timer);
      ctl.abort();
    },
  };
}
/** 数据库里的时间戳解析不了：是数据问题、不是连不上数据库，单独给错误码 */
class BadData extends Error {}

function ageS(now: number, iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new BadData();
  return Math.round((now - t) / 1000);
}

function pickDetail(detail: unknown): Record<string, number> | null {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return null;
  const out: Record<string, number> = {};
  for (const k of DETAIL_FIELDS) {
    const v = (detail as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

async function heartbeatPart(deps: Deps & { db: UsageDb }): Promise<Response> {
  const ctl = new AbortController();
  const ms = deps.timeoutMs ?? DB_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new DbTimeout());
    }, ms);
  });
  const db = deps.db;
  const authMail = db.authMail;
  // 发信量不进整轮的 5 秒 race：单独计时，慢了、坏了只让 auth_mail 为 null（审查必改 1）
  const mail = authMail ? startAuthMail((s) => authMail.call(db, s), deps.authMailTimeoutMs ?? AUTH_MAIL_TIMEOUT_MS, deps.log) : null;
  try {
    const [hb, pd, lt] = await Promise.race([
      Promise.all([db.heartbeats(ctl.signal), db.pendingDeletions(ctl.signal), db.longTxCount(ctl.signal)]),
      limit,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    const am = mail ? await mail.done : undefined;
    const now = deps.now();
    return json(200, {
      ok: true,
      heartbeats: hb.map((h) => ({ name: h.name, age_s: ageS(now, h.at), detail: pickDetail(h.detail) })),
      // “冷静期中的账号”（0.29 续第 143 条）：只给时间，不给 user_id（要查是谁到控制台看）
      pending_deletions: pd.map((p) => ({
        purge_after: p.purge_after,
        purge_started_at: p.purge_started_at,
        overdue_s: ageS(now, p.purge_after),
        started_age_s: p.purge_started_at === null ? null : ageS(now, p.purge_started_at),
      })),
      long_tx: lt,
      // 没接数据源时不出这个键（lemo-ops 据此不查、也不报“已恢复”）；接了但这一轮读不到是 null
      ...(am === undefined ? {} : { auth_mail: am }),
    });
  } catch (e) {
    mail?.stop();   // 整轮已失败：不再补记 auth_mail 的日志
    if (e instanceof BadData) {
      deps.log?.('bad_data:timestamp');
      return json(500, { error: 'bad_data' });
    }
    // 不回 200、不回空结果（0.29 续第 116 条①）；错误对象可能带连接信息，不打印
    deps.log?.(e instanceof DbTimeout ? 'db_unreachable:timeout' : 'db_unreachable:error');
    return json(503, { error: 'db_unreachable' });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  // 先鉴权，再判“没配置好”：没带对密钥的调用方看不出函数配没配（没配时谁也过不了鉴权）
  const secret = deps.opsSecret ?? '';
  const got = req.headers.get('x-ops-secret') ?? '';
  if (secret === '' || got === '' || !(await safeEqual(got, secret))) return json(401, { error: 'unauthorized' });
  if (new TextEncoder().encode(secret).length < MIN_SECRET_BYTES || deps.db === null) {
    deps.log?.('misconfigured');
    return json(500, { error: 'misconfigured' });
  }
  let part: unknown;
  try {
    part = ((await req.json()) as { part?: unknown } | null)?.part;
  } catch {
    return json(400, { error: 'bad_request' });
  }
  if (part === 'heartbeat') return heartbeatPart({ ...deps, db: deps.db });
  // usage 部分（数据库大小、文件存储、R2 用量、每人用量）B7 做（开发计划 B7a、3.4）；lemo-ops 的 USAGE_CHECK 在那之前保持 off
  if (part === 'usage') return json(501, { error: 'not_implemented' });
  return json(400, { error: 'bad_part' });
}
