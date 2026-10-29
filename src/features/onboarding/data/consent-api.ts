// 告知与同意页的接口（架构 15.5、3.3 D；0.40 R-238、R-239；R-103；TC-B1-11、13）
// • 同意或不同意都调 RPC record_consent(policy_ver, revoke)：同意 revoke=false，不同意 revoke=true（记下“看过、拒绝了”的那一版）。
//   policy_ver 必须等于 app_config.notice.policy_ver，否则服务器报 policy_ver_mismatch，所以每次点按钮前现读一次。
//   同意记录（consent_ai_at、consent_policy_ver）只由服务器写，客户端改不了。
// • R-239：notice 为空或 policy_ver 认不出（不符合 R-238 的写法）时不调 RPC，回 no_policy——界面说“暂时没法保存你的选择”，不说“刚更新过”。
// • 告知状态 noticeState()：consent_policy_ver 为空 → first（第一次的告知页，同意和拒绝都会写版本，看过的同一版不再弹）；
//   consent_policy_ver 有值且低于 min_consent_ver → updated（“隐私说明更新了”那一屏，另做）；其余（含 notice 认不出）→ none。
// • 慢网（审查建议）：超过 slowMs 先回调 onSlow（界面保持忙碌、提示“还在保存”），超过 hardMs 才放弃、回 unsure（“不确定记下没有”）。
//   record_consent 同一个人重复调结果一样，再点一次无害。
// • 打开 ai.enabled（15.5：同意后 ai.enabled = true）不在这里写：settings 走同步层，由接线方在 onDone(true) 里写（见交付说明）。
// 错误只认码：session_revoked、unauthorized、401 → revoked；account_disabled → disabled；fetch 失败 → offline。
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

export type Result<T = undefined> = { ok: true; value: T } | { ok: false; error: ConsentErr };

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
  rpc(fn: 'record_consent', args: { policy_ver: string; revoke: boolean }): Res;
}
const narrow = (db: Db): ConsentDb => db as unknown as ConsentDb;

/** 超过这么久先提示“还在保存”（和设置页的 API_TIMEOUT_MS 一样） */
export const CONSENT_SLOW_MS = 8000;
/** 超过这么久才放弃，回 unsure */
export const CONSENT_HARD_MS = 30000;

const fail = (e: unknown): Result<never> => ({ ok: false, error: mapConsentError(e) });
const ERR = (error: ConsentErr): Result<never> => ({ ok: false, error });

/** notice 里的一个键；不是 R-238 写法的一律当没有 */
function noticeVer(notice: unknown, key: 'policy_ver' | 'min_consent_ver'): string | null {
  if (typeof notice !== 'object' || notice === null) return null;
  const v = (notice as Record<string, unknown>)[key];
  return typeof v === 'string' && POLICY_VER_RE.test(v) ? v : null;
}

export function createConsentApi(getDb: () => Promise<Db>, slowMs: number = CONSENT_SLOW_MS, hardMs: number = CONSENT_HARD_MS): ConsentApi {
  async function readNotice(db: ConsentDb): Promise<{ notice: unknown } | Result<never>> {
    const cfg = await db.from('app_config').select('notice').eq('id', 1).maybeSingle();
    return cfg.error ? fail(cfg.error) : { notice: cfg.data?.notice ?? null };
  }

  return {
    async record(agree, onSlow) {
      const slow = setTimeout(() => onSlow?.(), slowMs);
      try {
        return await withTimeout(async (): Promise<Result> => {
          try {
            const db = narrow(await getDb());
            const n = await readNotice(db);
            if ('ok' in n) return n;
            const ver = noticeVer(n.notice, 'policy_ver');
            if (!ver) return ERR('no_policy');   // R-239：不调 RPC
            const { error } = await db.rpc('record_consent', { policy_ver: ver, revoke: !agree });
            return error ? fail(error) : { ok: true, value: undefined };
          } catch (e) {
            return fail(e);
          }
        }, hardMs, () => ERR('unsure'));
      } finally {
        clearTimeout(slow);
      }
    },

    noticeState: () =>
      withTimeout(async (): Promise<Result<NoticeState>> => {
        try {
          const db = narrow(await getDb());
          const [prof, n] = await Promise.all([db.from('profiles').select('consent_policy_ver').maybeSingle(), readNotice(db)]);
          if (prof.error) return fail(prof.error);
          if ('ok' in n) return n;
          const mine = prof.data?.consent_policy_ver ?? null;
          if (!mine) return { ok: true, value: 'first' };
          const min = noticeVer(n.notice, 'min_consent_ver');
          // R-239：只在本人版本有值、min 认得出、且本人版本低于 min 时才是“更新了”；本人版本认不出也按低于处理（要重新确认）
          if (min && !policyVerAtLeast(mine, min)) return { ok: true, value: 'updated' };
          return { ok: true, value: 'none' };
        } catch (e) {
          return fail(e);
        }
      }, slowMs, () => ERR('offline')),
  };
}
