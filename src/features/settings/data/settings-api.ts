// 设置页的接口（B1 K9）：设备列表、移除设备、退出其他所有设备、退出本机、改界面语言
// 依据：架构 0.29 续第 98、99、101、103、111、118 条，0.38 第 7、15、38 条，2.4 第 4 条
// • 设备列表：经 RLS 读 devices（只看得到本人的行）；“另有 N 个登录”和“已退出”的设备：rpc my_sessions()
//   （20261029193000 起多一列 signed_out_device_ids uuid[]：session_id 为空、会话已不在、已被吊销的设备行 id）
// • 移除别的设备：rpc remove_device(p_device_id)（服务器吊销那台的会话、删行）；移除本机由调用方改走“退出登录”
// • 退出其他所有设备：auth.signOut({scope: 'others'})（POST /auth/v1/logout?scope=others，免查名单）
// • 退出本机分两步，由 hooks/useSessionExit.ts 排顺序、套总超时（K9 第二轮 L1、N2）：deleteOwnDevice 删本机那一行 →（清本机库）→
//   dropLocalSession：auth.signOut({scope: 'local'})，不是 ok（断网、令牌失效、拿不到客户端）就删本机会话兜底
// • 读列表、移除、退出其他设备、改语言各套 API_TIMEOUT_MS 超时，超时按 offline 处理（K9 第二轮 N2）
// • 改语言：profiles.ui_locale（推送文案）＋ auth.updateUser({data: {locale}})（邮件模板）
// 错误只认码：session_revoked、unauthorized、401、刷新令牌失效 → revoked（0.38 第 7 条：一律当“没登录”）；
//   本机根本没有会话（别的标签页正常退出了）→ signed_out，提示“已退出登录”，不说“被移除”
// • revoked、signed_out 带着这次请求用的会话的 session_id（sid；接手清单 K6-sugg4 ①）：发请求前记下（getSession 拿到的令牌里读；
//   getSession 本身出错时用调它之前同步读的本机会话），随错误带回。回包前别的标签页可能已用同一账号写进新会话，
//   离开本机时只删这个 sid 的会话（clearLocalSessionIf），不在回包那一刻读本机会话、删“现在那个”
import type { UiLocale } from '../../../../shared/i18n/pick-locale.ts';
import { readSessionId } from '../../../platform/session.ts';
import { withTimeout } from '../../../platform/sign-out.ts';
import type { Db } from '../../../platform/supabase/client.ts';
import type { DeviceRow } from './devices.ts';
import { sessionIdOfToken } from './devices.ts';

export type SettingsErr =
  /** 会话已被吊销或不在了：清空本机、提示“被移除”、回登录页 */
  | 'revoked'
  /** 本机没有会话（别的标签页退出了）：清空本机、提示“已退出登录”、回登录页 */
  | 'signed_out'
  /** 账号停用或在注销冷静期（account_disabled）：只提示，重新登录可恢复（R-192） */
  | 'account_disabled'
  | 'offline'
  /** 服务器忙（503 try_later，0.29 续第 110、119 条）：只提示稍后再试，不清本机 */
  | 'try_later'
  /** 想用 remove_device 移除本机（服务器回 is_current_device）：本机请用退出登录 */
  | 'is_current_device'
  | 'device_not_found'
  | 'unknown';

/** 会话没了的两种错误：一定带着 sid（这次请求用的会话；那时本机没有会话为 null） */
export type SessionLostErr = 'revoked' | 'signed_out';

export type Failure =
  | { ok: false; error: SessionLostErr; sid: string | null }
  | { ok: false; error: Exclude<SettingsErr, SessionLostErr> };

export type Result<T = undefined> = { ok: true; value: T } | Failure;

/** 按错误码组出失败结果：会话没了的两种带上 sid，别的不带 */
export function failWith(error: SettingsErr, sid: string | null): Failure {
  return error === 'revoked' || error === 'signed_out' ? { ok: false, error, sid } : { ok: false, error };
}

export interface LoadedDevices {
  rows: DeviceRow[];
  /** my_sessions() 原样返回的行（devices.ts 的 toSessionInfo 解析）；读失败时为 null */
  sessions: unknown;
  /** 当前令牌里的 session_id（标“本机”用） */
  session: string | null;
}

export interface LocalSignOut {
  /** 服务器上的这次登录已吊销（或本来就不在了）；false = 断网等，只清了本机 */
  serverDone: boolean;
}

export interface SettingsApi {
  loadDevices(): Promise<Result<LoadedDevices>>;
  removeDevice(id: string): Promise<Result>;
  signOutOthers(): Promise<Result>;
  /** 退出前删本机那一行（4.1；del 策略只许删本会话那一行）；断网、已被删、出错都 resolve，不挡退出。不带超时，由调用方套 */
  deleteOwnDevice(currentDeviceId: string | null): Promise<void>;
  /**
   * 退出本机会话：signOut local，不是 ok 就兜底删。不带超时，由调用方套。
   * sessionId 必填（退出前记下的 session_id，K6-sugg3 ①、K6-sugg4 ②）：兜底只在本机会话还是它时才删
   */
  dropLocalSession(sessionId: string | null): Promise<LocalSignOut>;
  saveLocale(locale: UiLocale): Promise<Result>;
}

interface ErrLike {
  name?: unknown;
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const REVOKED_AUTH_CODES = ['session_not_found', 'refresh_token_not_found', 'refresh_token_already_used', 'session_expired'];
/** fetch 本身失败（断网、DNS、被拦）的几种说法：Chrome、Safari、Firefox */
const FETCH_FAILED = /failed to fetch|load failed|networkerror|network request failed|network error/i;

/** supabase-js 的 PostgrestError、AuthError、抛出的异常 → 界面的错误 */
export function mapSettingsError(e: unknown): SettingsErr {
  if (typeof e !== 'object' || e === null) return 'unknown';
  const x = e as ErrLike;
  const code = str(x.code);
  const msg = str(x.message);
  const name = str(x.name);
  const status = typeof x.status === 'number' ? x.status : -1;
  // PostgREST 把 raise exception 'session_revoked' 变成 400 + message（0.38 第 7 条）
  if (/\bsession_revoked\b|\bunauthorized\b/.test(msg) || code === 'session_revoked' || code === 'unauthorized') return 'revoked';
  if (REVOKED_AUTH_CODES.includes(code) || status === 401) return 'revoked';
  if (name === 'AuthSessionMissingError') return 'signed_out';
  if (/\baccount_disabled\b/.test(msg) || code === 'account_disabled') return 'account_disabled';
  if (/\bis_current_device\b/.test(msg)) return 'is_current_device';
  if (/\bdevice_not_found\b/.test(msg)) return 'device_not_found';
  if (/\btry_later\b/.test(msg) || code === 'try_later' || status === 503) return 'try_later';
  if (name === 'AuthRetryableFetchError' || status === 0 || FETCH_FAILED.test(msg)) return 'offline';
  return 'unknown';
}

// 类型文件 shared/db.types.ts 还没按 20261029192000 / 20261029193000 重新生成（没有 my_sessions、remove_device、devices.created_at），
// 这几处按迁移的签名手写最小的类型；重新生成后可以换回 Db 的类型
type Res<T = unknown> = PromiseLike<{ data: T | null; error: unknown }>;
/** my_sessions() 的一行（20261029193000） */
export interface MySessionsRow {
  orphan_count: number;
  orphan_last_at: string | null;
  signed_out_device_ids: string[];
}
interface LooseDb {
  rpc(fn: 'my_sessions'): Res<MySessionsRow[]>;
  rpc(fn: 'remove_device', args: { p_device_id: string }): Res;
  from(table: 'devices'): {
    select(cols: string): { is(col: 'deleted_at', v: null): Res<unknown[]> };
    delete(): { eq(col: 'id', v: string): Res };
  };
  from(table: 'profiles'): { update(v: { ui_locale: UiLocale }): { eq(col: 'user_id', v: string): Res } };
}
const loose = (db: Db): LooseDb => db as unknown as LooseDb;

const DEVICE_COLS = 'id,label,platform,last_seen_at,created_at,session_id';

function toRow(v: unknown): DeviceRow | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || typeof o['platform'] !== 'string') return null;
  const opt = (k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);
  return {
    id: o['id'],
    platform: o['platform'],
    label: opt('label'),
    last_seen_at: opt('last_seen_at'),
    created_at: opt('created_at'),
    session_id: opt('session_id'),
  };
}

const OK: Result = { ok: true, value: undefined };
/** sid：这次请求用的会话的 session_id（见文件头） */
const fail = (e: unknown, sid: string | null): Failure => failWith(mapSettingsError(e), sid);

/** 读列表、移除、退出其他设备、改语言最多等多久（appFetch 没有超时，网络卡住时请求可能几十秒不返回） */
export const API_TIMEOUT_MS = 8000;

const OFFLINE: Failure = { ok: false, error: 'offline' };

/**
 * clearLocalSessionIf：兜底删本机会话（设置页传 ExitDeps.clearLocalSessionIf）。dropLocalSession(sid) 把 session_id 原样转给它，
 * 只在本机会话还是那一个时才删（K6-sugg3 ①；参数必填，K6-sugg4 ②）。
 * readSid：同步读本机会话的 session_id（默认 platform/session.ts 的 readSessionId；只在 getSession 本身出错时用）
 */
export function createSettingsApi(
  getDb: () => Promise<Db>,
  clearLocalSessionIf: (sessionId: string | null) => void,
  timeoutMs: number = API_TIMEOUT_MS,
  readSid: () => string | null = () => readSessionId(),
): SettingsApi {
  /** 超时按断网处理（只提示，不清本机） */
  const timed = <T>(run: () => Promise<Result<T>>): Promise<Result<T>> => withTimeout(run, timeoutMs, () => OFFLINE);

  /**
   * 先确认本机有会话（没有就是 signed_out），再执行。fn 里的失败用 session.sessionId 组（fail(e, s.sessionId)），
   * 这样 revoked 带回的是发请求时那个会话，不是回包时本机的会话（K6-sugg4 ①）
   */
  async function run<T>(fn: (db: Db, session: { userId: string; sessionId: string | null }) => Promise<Result<T>>): Promise<Result<T>> {
    let sid: string | null = null;
    try {
      const db = await getDb();
      sid = safeSid();   // getSession 出错（刷新令牌被拒等）时，出错的就是这时本机的会话
      const { data, error } = await db.auth.getSession();
      if (error) return fail(error, sid);
      const s = data.session;
      if (!s) return failWith('signed_out', null);
      sid = sessionIdOfToken(s.access_token);
      return await fn(db, { userId: s.user.id, sessionId: sid });
    } catch (e) {
      return fail(e, sid);
    }
  }

  function safeSid(): string | null {
    try {
      return readSid();
    } catch {
      return null;
    }
  }

  /** signOut({scope: 'local'})；不是 ok 就兜底删本机会话。不先查 getSession（令牌过期、断网时那一步本身会失败） */
  async function dropLocal(db: Db | null, sessionId: string | null): Promise<LocalSignOut> {
    const clear = (): void => clearLocalSessionIf(sessionId);
    if (!db) {
      clear();
      return { serverDone: false };
    }
    try {
      const { error } = await db.auth.signOut({ scope: 'local' });
      if (!error) return { serverDone: true };
      clear();
      const kind = mapSettingsError(error);
      // 服务器说会话本来就不在了：不用再吊销
      return { serverDone: kind === 'revoked' || kind === 'signed_out' };
    } catch {
      clear();
      return { serverDone: false };
    }
  }

  async function dbOrNull(): Promise<Db | null> {
    try {
      return await getDb();
    } catch {
      return null;
    }
  }

  return {
    loadDevices: () =>
      timed(() =>
        run(async (db, s) => {
          const [dev, ses] = await Promise.all([loose(db).from('devices').select(DEVICE_COLS).is('deleted_at', null), loose(db).rpc('my_sessions')]);
          if (dev.error) return fail(dev.error, s.sessionId);
          // my_sessions 读不出来不挡设备列表；但会话被吊销要照样处理
          if (ses.error && mapSettingsError(ses.error) === 'revoked') return failWith('revoked', s.sessionId);
          const rows = (dev.data ?? []).map(toRow).filter((r): r is DeviceRow => r !== null);
          return { ok: true, value: { rows, sessions: ses.error ? null : ses.data, session: s.sessionId } };
        }),
      ),

    removeDevice: (id) =>
      timed(() =>
        run(async (db, s) => {
          const { error } = await loose(db).rpc('remove_device', { p_device_id: id });
          return error ? fail(error, s.sessionId) : OK;
        }),
      ),

    signOutOthers: () =>
      timed(() =>
        run(async (db, s) => {
          const { error } = await db.auth.signOut({ scope: 'others' });
          return error ? fail(error, s.sessionId) : OK;
        }),
      ),

    deleteOwnDevice: async (currentDeviceId) => {
      if (!currentDeviceId) return;
      const db = await dbOrNull();
      if (!db) return;
      try {
        await loose(db).from('devices').delete().eq('id', currentDeviceId);
      } catch {
        // 断网、已被删都不挡退出
      }
    },

    dropLocalSession: async (sessionId) => dropLocal(await dbOrNull(), sessionId),

    saveLocale: (locale) =>
      timed(() =>
        run(async (db, s) => {
          const p = await loose(db).from('profiles').update({ ui_locale: locale }).eq('user_id', s.userId);
          if (p.error) return fail(p.error, s.sessionId);
          const { error } = await db.auth.updateUser({ data: { locale } });
          return error ? fail(error, s.sessionId) : OK;
        }),
      ),
  };
}
