// 告知与同意页的接口（架构 15.5、3.3 D；0.40 R-238、R-239；R-103；TC-B1-11、13）
// • 同意或不同意都调 RPC record_consent(policy_ver, revoke)：同意 revoke=false，不同意 revoke=true（记下“看过、拒绝了”的那一版）。
//   policy_ver 必须等于 app_config.notice.policy_ver，否则服务器报 policy_ver_mismatch，所以每次点按钮前现读一次。
//   同意记录（consent_ai_at、consent_policy_ver）只由服务器写，客户端改不了。
// • R-239：notice 为空或 policy_ver 认不出（不符合 R-238 的写法）时不调 RPC，回 no_policy——界面说“暂时没法保存你的选择”，不说“刚更新过”。
// • 告知状态 noticeState()：consent_policy_ver 为空 → first（第一次的告知页，同意和拒绝都会写版本，看过的同一版不再弹）；
//   consent_policy_ver 有值且低于 min_consent_ver → updated（“隐私说明更新了”那一屏，另做）；其余（含 notice 认不出）→ none。
// • 慢网（审查建议）：超过 slowMs 先回调 onSlow（界面保持忙碌、提示“还在保存”），超过 hardMs 才放弃、回 unsure（“不确定记下没有”）。
//   record_consent 同一个人重复调结果一样，再点一次无害。
// • 超过 hardMs 放弃时真正中断（接手清单 CONSENT-wire ⑧）：rpc 带 .abortSignal()，放弃的那一刻 abort；还在读 notice 时就放弃了的，读完也不再调 rpc。
//   免得晚到的“同意”落在用户随后点的“不同意”之后（服务器按到达先后记，后到的说了算）。已经到了服务器的请求 abort 拦不住，这一点只能缩小窗口
// • 打开 ai.enabled（15.5：同意后 ai.enabled = true）不在这里写：settings 走同步层，由接线方在 onDone(true) 里写（见交付说明）。
// 错误只认码：session_revoked、unauthorized、401 → revoked；account_disabled → disabled；fetch 失败 → offline。
// • revoked、disabled 带着这次请求用的会话的 session_id（sid；接手清单 K6-sugg4 ①）：record 一开头（发请求前）同步读本机会话的 session_id，
//   随错误带回；离开本机时只删这个会话（consent-exit.ts），回包前别的标签页写进来的新会话不删
import { readSessionId } from '../../../platform/session.ts';
import { withTimeout } from '../../../platform/sign-out.ts';
import type { Db } from '../../../platform/supabase/client.ts';

export type ConsentErr =
  /** 会话被吊销或不在了：交给接线方按“被移除 / 没登录”处理 */
  | 'revoked'
  /** 账号停用、没有 profile 行或一行都没更新（服务器报 account_disabled）：交给接线方按架构 4.3 清本机、回登录页。
   *  不并进 revoked：登录页对“被移除”和“已停用”给的退出原因不同（auth.exit.removed / auth.exit.disabled） */
  | 'disabled'
  | 'offline'
  /** 服务器说 policy_ver 对不上（刚好升版）：再点一次会重读 */
  | 'version_changed'
  /** R-239：notice 为空或认不出，没调 RPC；先不使用 AI，下次打开再问 */
  | 'no_policy'
  /** 等太久放弃了，不确定服务器记下没有 */
  | 'unsure'
  | 'try_later'
  | 'unknown';

/** 要离开本机的两种错误：一定带着 sid（这次请求用的会话；那时读不出为 null） */
export type LeaveErr = 'revoked' | 'disabled';

export type Failure = { ok: false; error: LeaveErr; sid: string | null } | { ok: false; error: Exclude<ConsentErr, LeaveErr> };

export type Result<T = undefined> = { ok: true; value: T } | Failure;

/** 按错误码组出失败结果：要离开本机的两种带上 sid，别的不带 */
export function failWith(error: ConsentErr, sid: string | null): Failure {
  return error === 'revoked' || error === 'disabled' ? { ok: false, error, sid } : { ok: false, error };
}

export type NoticeState = 'first' | 'updated' | 'none';

export interface ConsentApi {
  /** agree=true：同意；false：不同意（revoke=true）。onSlow：超过 slowMs 还没回时调一次 */
  record(agree: boolean, onSlow?: () => void): Promise<Result>;
  /** 要弹哪一屏（见文件头） */
  noticeState(): Promise<Result<NoticeState>>;
}

// ───── 版本号（R-238；和 supabase/functions/_shared/consent.ts 的 POLICY_VER_RE、policyVerAtLeast 同一口径，前端不能引服务器目录，所以抄一份，测试对两边同一批样例） ─────
export const POLICY_VER_RE = /^\d{4}-\d{2}-\d{2}(-[1-9]\d?)?$/;

export function policyVerAtLeast(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !POLICY_VER_RE.test(a) || !POLICY_VER_RE.test(b)) return false;
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

interface ErrLike {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const FETCH_FAILED = /failed to fetch|load failed|networkerror|network request failed|network error/i;

/** supabase-js 的 PostgrestError、AuthError、抛出的异常 → 界面的错误 */
export function mapConsentError(e: unknown): ConsentErr {
  if (typeof e !== 'object' || e === null) return 'unknown';
  const x = e as ErrLike;
  const code = str(x.code);
  const msg = str(x.message);
  const status = typeof x.status === 'number' ? x.status : -1;
  if (/\bsession_revoked\b|\bunauthorized\b/.test(msg) || code === 'session_revoked' || code === 'unauthorized' || status === 401) return 'revoked';
  if (/\baccount_disabled\b/.test(msg) || code === 'account_disabled') return 'disabled';
  if (/\bpolicy_ver_mismatch\b/.test(msg)) return 'version_changed';
  if (/\btry_later\b/.test(msg) || code === 'try_later' || status === 503) return 'try_later';
  if (str(x.name) === 'AuthRetryableFetchError' || status === 0 || FETCH_FAILED.test(msg)) return 'offline';
  return 'unknown';
}

type Res<T = unknown> = PromiseLike<{ data: T | null; error: unknown }>;
/** 用到的几处查询的最小类型（profiles 只读得到本人那一行，RLS prof_sel） */
interface ConsentDb {
  from(table: 'app_config'): { select(cols: 'notice'): { eq(col: 'id', v: 1): { maybeSingle(): Res<{ notice: unknown }> } } };
  from(table: 'profiles'): { select(cols: 'consent_policy_ver'): { maybeSingle(): Res<{ consent_policy_ver: string | null }> } };
  rpc(fn: 'record_consent', args: { policy_ver: string; revoke: boolean }): { abortSignal(signal: AbortSignal): Res };
}
const narrow = (db: Db): ConsentDb => db as unknown as ConsentDb;

/** 超过这么久先提示“还在保存”（和设置页的 API_TIMEOUT_MS 一样） */
export const CONSENT_SLOW_MS = 8000;
/** 超过这么久才放弃，回 unsure */
export const CONSENT_HARD_MS = 30000;

const fail = (e: unknown, sid: string | null): Failure => failWith(mapConsentError(e), sid);
const ERR = (error: Exclude<ConsentErr, LeaveErr>): Failure => ({ ok: false, error });

/** notice 里的一个键；不是 R-238 写法的一律当没有 */
function noticeVer(notice: unknown, key: 'policy_ver' | 'min_consent_ver'): string | null {
  if (typeof notice !== 'object' || notice === null) return null;
  const v = (notice as Record<string, unknown>)[key];
  return typeof v === 'string' && POLICY_VER_RE.test(v) ? v : null;
}

// ───── 首屏快读（B2 FA-6 ①）：启动关口的 noticeState 不为它加载 supabase-js（约 53 KB gzip） ─────
// • 直接 GET 两张表（PostgREST，和 supabase-js 发的同一对请求）：/rest/v1/profiles?select=consent_policy_ver（RLS 只给本人那一行）、
//   /rest/v1/app_config?select=notice&id=eq.1；带 apikey、Authorization: Bearer <本机会话的 access token>，经 appFetch 带版本头。
// • 只在“令牌还新鲜”（exp 距现在超过 marginMs，和同步层先刷新再发的 REFRESH_MARGIN_MS 同一口径）时走；拿不到令牌、读不出 exp、
//   任何一张表不是 2xx、不是 JSON、形状不对、网络错——一律回 null（另一张当场中断，L2），退回原来的 supabase-js 路径（会刷新令牌），错误的归类和以前完全一样。
//   例如本机时钟不准导致 401：不在这里当成“被移除”，由 supabase-js 那条路刷新后再判断。
// • 只读这两样；令牌只放在请求头里，不记录、不打印、不写回。record()（点同意、不同意）不走这里，页面那时早已画好。
/** 快读到的两样：本人的 consent_policy_ver（没有 profile 行为 null）、app_config.notice（没有那一行为 null） */
export interface NoticeRows {
  mine: string | null;
  notice: unknown;
}
/** 快读：读到了回 NoticeRows；读不了回 null（调用方退回 supabase-js）。signal：调用方放弃时中断请求 */
export type FastNoticeRead = (signal: AbortSignal) => Promise<NoticeRows | null>;

export interface RestNoticeDeps {
  supabaseUrl: string;
  anonKey: string;
  /** 同步读本机会话的 access token（platform/session.ts 的 readSessionAccessToken） */
  readToken(): string | null;
  fetch(input: string, init: RequestInit): Promise<Response>;
  now(): number;
  /** 令牌至少还要剩这么久才走快读 */
  marginMs: number;
}

/** access token payload 里的 exp（毫秒）；只解这一个字段，不校验签名。读不出返回 null */
export function tokenExpMs(token: string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const exp = (JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='))) as { exp?: unknown } | null)?.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** 一张表读不了（不是 2xx、不是 JSON、不是数组、多于一行）：抛它，让另一张立刻被中断（安全审查 L2） */
class NoticeReadMiss extends Error {}

/**
 * GET 一张表、最多一行（同 maybeSingle）：row（没有那一行时为 null）；读不了就抛（见 NoticeReadMiss）。
 * 不走 HTTP 缓存（缓存按 URL 存、不按 Authorization 分，换账号不能读到上一个人的行）、不跟随重定向（带 Bearer 的请求不转去别处）：安全审查 L1
 */
async function getOne(d: RestNoticeDeps, path: string, token: string, signal: AbortSignal): Promise<unknown> {
  const res = await d.fetch(`${d.supabaseUrl.replace(/\/+$/, '')}/rest/v1/${path}`, {
    headers: { apikey: d.anonKey, Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
    redirect: 'error',
    signal,
  });
  if (!res.ok) throw new NoticeReadMiss();
  const body: unknown = await res.json();
  if (!Array.isArray(body) || body.length > 1) throw new NoticeReadMiss();
  return body[0] ?? null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function createRestNoticeRead(d: RestNoticeDeps): FastNoticeRead {
  return async (signal) => {
    if (!d.supabaseUrl || !d.anonKey) return null;
    const token = d.readToken();
    if (!token) return null;
    const exp = tokenExpMs(token);
    if (exp === null || exp - d.now() < d.marginMs) return null;
    // 一张表读不了（或抛错）就立刻中断另一张、马上退回 supabase-js，不等它回来（安全审查 L2）；外面放弃时同样中断两张
    const own = new AbortController();
    const stop = (): void => own.abort();
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    const one = (path: string): Promise<unknown> => getOne(d, path, token, own.signal).catch((e: unknown) => {
      stop();
      throw e;
    });
    try {
      const [p, c] = await Promise.all([one('profiles?select=consent_policy_ver'), one('app_config?select=notice&id=eq.1')]);
      if (p !== null && !(isObj(p) && (p['consent_policy_ver'] === null || typeof p['consent_policy_ver'] === 'string'))) return null;
      if (c !== null && !(isObj(c) && 'notice' in c)) return null;
      return { mine: isObj(p) ? (p['consent_policy_ver'] as string | null) : null, notice: isObj(c) ? c['notice'] : null };
    } catch {
      return null;
    } finally {
      signal.removeEventListener('abort', stop);
    }
  };
}

/** createConsentApi 的可选项（B2 FA-6 ①） */
export interface ConsentApiOptions {
  /** noticeState 先试的快读；不给就只走 supabase-js */
  fastRead?: FastNoticeRead;
  /**
   * 构建没带 supabase 地址或 anon key（本机、假后端 e2e）：supabase-js 那条路只会报 supabase_env_missing（归 unknown），
   * noticeState 直接回这个结果，不为它下载 supabase-js。默认 true
   */
  envReady?: boolean;
}

/** 两样都读到了以后判断弹哪一屏（快读和 supabase-js 共用；规则见文件头） */
function judgeNotice(mine: string | null, notice: unknown): Result<NoticeState> {
  if (!mine) return { ok: true, value: 'first' };
  const min = noticeVer(notice, 'min_consent_ver');
  // R-239：只在本人版本有值、min 认得出、且本人版本低于 min 时才是“更新了”；本人版本认不出也按低于处理（要重新确认）
  if (min && !policyVerAtLeast(mine, min)) return { ok: true, value: 'updated' };
  return { ok: true, value: 'none' };
}

/** readSid：同步读本机会话的 session_id（默认 platform/session.ts 的 readSessionId；测试换掉） */
export function createConsentApi(
  getDb: () => Promise<Db>,
  slowMs: number = CONSENT_SLOW_MS,
  hardMs: number = CONSENT_HARD_MS,
  readSid: () => string | null = () => readSessionId(),
  opts: ConsentApiOptions = {},
): ConsentApi {
  const { fastRead, envReady = true } = opts;
  async function readNotice(db: ConsentDb, sid: string | null): Promise<{ notice: unknown } | Failure> {
    const cfg = await db.from('app_config').select('notice').eq('id', 1).maybeSingle();
    return cfg.error ? fail(cfg.error, sid) : { notice: cfg.data?.notice ?? null };
  }
  const safeSid = (): string | null => {
    try {
      return readSid();
    } catch {
      return null;
    }
  };

  return {
    async record(agree, onSlow) {
      const slow = setTimeout(() => onSlow?.(), slowMs);
      const ctl = new AbortController();
      // 发请求前记下本页的会话（K6-sugg4 ①）
      const sid = safeSid();
      try {
        return await withTimeout(async (): Promise<Result> => {
          try {
            const db = narrow(await getDb());
            const n = await readNotice(db, sid);
            if ('ok' in n) return n;
            const ver = noticeVer(n.notice, 'policy_ver');
            if (!ver) return ERR('no_policy');   // R-239：不调 RPC
            if (ctl.signal.aborted) return ERR('unsure');   // 已经放弃了：不再发
            const { error } = await db.rpc('record_consent', { policy_ver: ver, revoke: !agree }).abortSignal(ctl.signal);
            return error ? fail(error, sid) : { ok: true, value: undefined };
          } catch (e) {
            return fail(e, sid);
          }
        }, hardMs, () => ERR('unsure'));
      } finally {
        clearTimeout(slow);
        // 正常返回时请求已结束，abort 不起作用；超时放弃时中断还在路上的请求
        ctl.abort();
      }
    },

    noticeState: () => {
      // 超过 slowMs 放弃时中断快读还在路上的请求，也不再退回 supabase-js（FA-6 ①）
      const ctl = new AbortController();
      return withTimeout(async (): Promise<Result<NoticeState>> => {
        const sid = safeSid();
        if (!envReady) return ERR('unknown');
        try {
          const fast = fastRead ? await fastRead(ctl.signal) : null;
          if (fast) return judgeNotice(fast.mine, fast.notice);
          if (ctl.signal.aborted) return ERR('offline');
          const db = narrow(await getDb());
          const [prof, n] = await Promise.all([db.from('profiles').select('consent_policy_ver').maybeSingle(), readNotice(db, sid)]);
          if (prof.error) return fail(prof.error, sid);
          if ('ok' in n) return n;
          return judgeNotice(prof.data?.consent_policy_ver ?? null, n.notice);
        } catch (e) {
          return fail(e, sid);
        }
      }, slowMs, () => {
        ctl.abort();
        return ERR('offline');
      });
    },
  };
}
