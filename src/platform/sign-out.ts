// 退出这台设备的清理步骤（架构 4.1）：登录页“退出并换账号”和设置页“退出登录 / 被移除”共用；不经 core/device-exit.ts
// 顺序：① 删本会话的 devices 行 ② 清本机库（主 App 传 wipe；没传、库不能用、出错、超时都按库名删）③ 清运行时缓存 ④ signOut local ⑤ 会话删掉后再按库名删一次库
// 不变量：会话放在 ④（被打断最坏“有会话、没库”）；兜底删会话只删退出前那一个 sid；①④ 合计最多 SIGN_OUT_TIMEOUT_MS，②③⑤ 各有上限，超时照样清本机
// 不变量：一开头 markSelfSignOut，本页 SIGNED_OUT 不再按被移除处理；② 同一步删 lemo.reauth，lemo.authloss 只在本人主动退出时删
// 为什么这样排（⑤ 的原因、SW 写库、supabase-js 删键保护、④ 前再读 sid）见 docs/10-架构/历史版本/文件头原文-2026-11-11退出链路整改.md
import { buildInfo, isTauri } from './env.ts';
import { clearAuthLoss, clearReauth } from './auth-loss-store.ts';
import { appFetch } from './http.ts';
import { clearLogQueue } from './log-store.ts';
import { disconnectPushLazy } from './push-disconnect.ts';
import {
  clearCacheStorage,
  clearLocalSessionIf,
  markSelfSignOut,
  mayRemoveSessionKey,
  readSessionAccessToken,
  readSessionId,
  readSessionUserId,
  SELF_SIGN_OUT_TTL_MS,
} from './session.ts';
import { guardSessionRemoval } from './supabase/auth-storage.ts';
import { CACHES_TIMEOUT_MS, deleteLocalDb, WIPE_TIMEOUT_MS, withTimeout } from './exit-basics.ts';

// 本机库名、删库、超时、withTimeout 在 platform/exit-basics.ts（首屏只引那里）；这里原样转出
export { CACHES_TIMEOUT_MS, DELETE_WAIT_MS, deleteLocalDb, LOCAL_DB_NAME, WIPE_TIMEOUT_MS, withTimeout, type DeleteDbResult } from './exit-basics.ts';

/** ①④ 服务器部分的总超时 */
export const SIGN_OUT_TIMEOUT_MS = 8000;

/** 清本机的几步（测试换掉） */
export interface ExitSteps {
  /**
   * 主 App：先设闸再清空本机库（core 的 sealForExit + wipeLocal）；返回 false = 库不能用（没启动、已关、version_too_new…），
   * 改按库名删库。登录页不跑 boot，不传
   */
  wipe?(): Promise<boolean>;
  /** 按库名删库（默认 deleteLocalDb） */
  deleteDb(): Promise<unknown>;
  clearCacheStorage(): Promise<void>;
  /**
   * 同步删本机会话：本机会话的 session_id 还是 sessionId 才删（默认 session.ts 的 clearLocalSessionIf，K6-sugg3 ①）。
   * sessionId 必填（K6-sugg4 ②）；null = 那时本机没有会话 / 读不出，只在本机仍没有会话时删。
   * 返回删没删成（A-1：exe 里删凭据管理器失败为 false；不是那个会话、不删也是 true）
   */
  clearLocalSessionIf(sessionId: string | null): Promise<boolean>;
  /** 本机会话 access token 里的 session_id（默认 session.ts 的 readSessionId）；读不出为 null */
  readSessionId(): string | null;
  /**
   * 断开浏览器推送（B2 安全审查 FE-2）：关掉本 App 已显示的通知、退订推送（默认 platform/push-disconnect.ts 的 disconnectPushLazy，按需下载 push.ts 的 disconnectBrowserPush，
   * 自带上限、不抛）。在 ② 设闸清库之后、按库名删库之前调；不传就不做（测试、没有推送的环境）
   */
  disconnectPush?(): Promise<void>;
}

export const defaultExitSteps: ExitSteps = {
  deleteDb: () => deleteLocalDb(),
  clearCacheStorage,
  clearLocalSessionIf: (sid) => clearLocalSessionIf(sid),
  readSessionId: () => readSessionId(),
  disconnectPush: () => disconnectPushLazy(),
};

/** 清本机库和 Cache Storage（②③）；某一步失败或超时不挡后面，永远 resolve */
export async function wipeThisDevice(steps: ExitSteps, wipeMs = WIPE_TIMEOUT_MS, cachesMs = CACHES_TIMEOUT_MS): Promise<void> {
  const { wipe } = steps;
  clearReauth();
  const cleared = wipe ? await withTimeout(wipe, wipeMs, () => false) : false;
  // FE-2：通知中心不留上一个账号的标题、旧账号的推送不再到达；自带上限，这里再兜一层异常
  try {
    await steps.disconnectPush?.();
  } catch {
    // 断不开不挡退出
  }
  if (!cleared) {
    try {
      await steps.deleteDb();
    } catch {
      // 删不掉：Cache Storage 照样清
    }
  }
  await withTimeout(
    async () => {
      await steps.clearCacheStorage();
      return true;
    },
    cachesMs,
    () => false,
  );
}

/**
 * 删本机会话（删除同步生效），不抛错；只在本机会话还是 sessionId 时才删（必填，K6-sugg4 ②）。
 * 返回删没删成（A-1）：exe 里凭据管理器删失败为 false；存储不可用（本来也存不下会话）算 true
 */
export function dropSession(steps: Pick<ExitSteps, 'clearLocalSessionIf'>, sessionId: string | null): Promise<boolean> {
  try {
    return Promise.resolve(steps.clearLocalSessionIf(sessionId)).catch(() => false);
  } catch {
    return Promise.resolve(true);
  }
}

/** 同步读本机会话的 session_id，不抛错（读不出为 null） */
export function sessionIdOf(steps: Pick<ExitSteps, 'readSessionId'>): string | null {
  try {
    return steps.readSessionId();
  } catch {
    return null;
  }
}

/** 退出一开头记下的旧会话（④ 交给 server.signOut，K6-signout-lib）：只在内存里，不记录、不打印 */
export interface PriorSession {
  /** 退出前本机会话的 session_id；读不出为 null */
  sid: string | null;
  /** 退出前本机会话的 access token；读不出为 null */
  token: string | null;
  /** ④ 剩下的等待预算（毫秒）：封装里直接 logout 时按它 abort */
  budgetMs: number;
}

/** 服务器那一半（调用方用自己的接口实现） */
export interface SignOutServer {
  /** ① 删本会话那一行 devices；出错也 resolve。没有这一步（signOut 里已经删了）不传 */
  deleteOwnDevice?(): Promise<void>;
  /**
   * ④ signOut({scope: 'local'})；serverDone = 服务器上的这次登录已吊销（或本来就不在了）。
   * prior = 退出一开头记下的旧会话：封装拿到客户端以后、紧贴 db.auth.signOut 之前再判断一次 sessionReplaced(prior.sid)，
   * 换了就不调 signOut、改 logoutReplaced(prior.token, prior.budgetMs)（K6-signout-lib；删 devices 行也用 prior.sid）
   */
  signOut(prior: PriorSession): Promise<{ serverDone: boolean }>;
}

export interface SignOutOptions {
  server: SignOutServer;
  steps?: ExitSteps;
  /** 本机会话里的 user_id（晚到处理用；默认 session.ts 的 readSessionUserId） */
  readUserId?: () => string | null;
  /** 打“自己退出”的标记（默认 session.ts 的 markSelfSignOut；测试换掉） */
  markSelf?: () => void;
  /**
   * 挂上 supabase-js 删会话键的保护（K6-signout-lib），返回撤掉的函数；sid = 退出前本机会话的 session_id。
   * 默认 defaultGuardRemoval（auth-storage.ts 的 guardSessionRemoval + session.ts 的 mayRemoveSessionKey）；测试换掉
   */
  guardRemoval?: (sid: string | null) => () => void;
  /** 一开头记下旧会话的 access token（默认 session.ts 的 readSessionAccessToken）；读不出为 null */
  readToken?: () => string | null;
  /** ④ 前会话已被换掉时，用旧令牌直接 /logout（默认 logoutWithToken）；测试换掉 */
  logoutWithToken?: (token: string, timeoutMs: number) => Promise<{ serverDone: boolean }>;
  timeoutMs?: number;
  wipeMs?: number;
  cachesMs?: number;
  /** 是不是 exe（测试注入；默认 env.ts 的 isTauri）：exe 里服务器退成了也兜底删一次 */
  inTauri?: () => boolean;
}

/** ⑤ 会话删掉以后再按库名删一次库（自带上限，出错也 resolve） */
export async function deleteDbAgain(steps: Pick<ExitSteps, 'deleteDb'>): Promise<void> {
  try {
    await steps.deleteDb();
  } catch {
    // 删不掉：下次打开没有会话，主 App 不会用它；残留由 K6 冷启动时（无会话但库存在）清掉
  }
}

/**
 * 用记下的旧令牌直接吊销那一次登录：经 appFetch POST <supabaseUrl>/auth/v1/logout?scope=local（同 auth-js admin.signOut 的请求，
 * 带 apikey 和 Authorization: Bearer）。2xx = serverDone；401（过期）等非 2xx、断网都算没退成，不刷新令牌、不碰存储。
 * 到 timeoutMs 还没回来就 abort（复审建议 2），按没退成。永远 resolve
 */
export async function logoutWithToken(
  token: string,
  timeoutMs: number = SIGN_OUT_TIMEOUT_MS,
  supabaseUrl: string = buildInfo.supabaseUrl,
  anonKey: string = buildInfo.anonKey,
): Promise<{ serverDone: boolean }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await appFetch(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
      signal: ctl.signal,
    });
    return { serverDone: res.ok };
  } catch {
    return { serverDone: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 本机会话已换成别的标签页的新会话：重读的 session_id 不是 null、且不是 sid（K6-signout-lib）。
 * 重读为 null 不算：auth-js 读到没有会话本来就不发 /logout。sign-out.ts 的 ④ 和两个封装（紧贴 db.auth.signOut 之前）共用。不抛错
 */
export function sessionReplaced(sid: string | null, read: () => string | null = () => readSessionId()): boolean {
  const now = readSafe(read);
  return now !== null && now !== sid;
}

/**
 * 会话被换掉时代替 supabase-js 的 signOut：有旧令牌就 logoutWithToken。
 * 没有旧令牌 = 退出前本机本来就没有会话，没有要吊销的登录，**有意**算退成（serverDone = true，复审建议 3）：
 * 算没退成会多提示一句“服务器上的这次登录暂时没能吊销”，而那次登录并不存在
 */
export function logoutReplaced(
  token: string | null,
  timeoutMs: number = SIGN_OUT_TIMEOUT_MS,
  logout: (token: string, timeoutMs: number) => Promise<{ serverDone: boolean }> = logoutWithToken,
): Promise<{ serverDone: boolean }> {
  if (token === null) return Promise.resolve({ serverDone: true });
  return logout(token, timeoutMs);
}

/**
 * ④ 的预算（PriorSession.budgetMs）扣掉进入 server.signOut 以后已经用掉的时间（getDb、删 devices 行；K6-signout-lib 复审建议 ②）：
 * 外层按 budgetMs 超时以后，里面直接 logout 的请求也跟着停，不再多跑一会儿
 */
export function budgetLeft(budgetMs: number, t0: number, now: number = Date.now()): number {
  return Math.max(budgetMs - Math.max(now - t0, 0), 0);
}

/** 同步读，不抛错（读不出为 null） */
function readSafe(read: () => string | null): string | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** 默认的删键保护：退出期间 supabase-js 只能删“还是 sid 那一个”的会话键；最多挂 SELF_SIGN_OUT_TTL_MS */
export function defaultGuardRemoval(sid: string | null): () => void {
  return guardSessionRemoval((key) => mayRemoveSessionKey(key, sid), SELF_SIGN_OUT_TTL_MS);
}

/**
 * 退出这台设备：①②③④⑤，本机一定清空、本机会话删掉；serverDone = false 时调用方提示“服务器上的这次登录暂时没能吊销”。
 * localDone 目前只给测试和以后的日志用，生产代码里没人读（退出后的界面由 goToAuth 看 session-store 的删除状态决定）。
 * localDone **只代表最后兜底的那一次删除**（dropSession → clearLocalSessionIf(sid)，安全复审建议 ③）：false = 兜底删本机会话没成
 * （A-1，只在 exe 里会出现）——调用方照常 goToAuth，它看 session-store 的删除状态，不重新载入回已登录界面、改显示“退出没完成，点重试”。
 * • 服务器没退成：照旧兜底删。
 * • 服务器退成了：supabase-js 自己删会话键（它不写“待删除”标记，成败只记在本页内存状态里）。exe 里再兜底删一次（安全复核追加建议）：
 *   这是显式删除、会写标记——“服务器退成了、supabase-js 删键失败、用户不重试直接关 exe”这一路下次启动也会先删；
 *   supabase-js 已经删掉时本机会话不再是 sid，clearLocalSessionIf 不删、localDone 为 true（sid 为 null 时例外：本机仍读不出会话就照删一遍
 *   那三个本来不在的键，见 session-store.ts 文件头）。
 *   网页版不兜底（localStorage 同步删，没有这个问题），localDone 恒为 true
 */
export async function signOutThisDevice(o: SignOutOptions): Promise<{ serverDone: boolean; localDone: boolean }> {
  const steps = o.steps ?? defaultExitSteps;
  const readUserId = o.readUserId ?? (() => readSessionUserId());
  const timeoutMs = o.timeoutMs ?? SIGN_OUT_TIMEOUT_MS;
  // 先打标记再发任何请求：① 删行也可能因刷新令牌失败引起 SIGNED_OUT
  (o.markSelf ?? (() => markSelfSignOut()))();
  // 本人主动退出：会话丢失的原因码一起删（R-382 0.59 M4）；lemo.reauth 也在发任何服务器请求之前先删（安全审建议 2）：
  // 删行、signOut 引起的 SIGNED_OUT 或中途关页，都不会把本人退出当成“登录过期”留下本机库（wipeThisDevice 里还会再删一次）
  clearAuthLoss();
  clearReauth();
  const before = readUserId();
  // 退出前的会话（K6-sugg3 ①）：兜底只删它，别的标签页刚登录的新会话不删
  const sid = sessionIdOf(steps);
  // 旧会话的令牌只留在内存里：④ 前会话被换掉时用它直接 /logout（K6-signout-lib 收窄）
  const token = readSafe(o.readToken ?? (() => readSessionAccessToken()));
  // supabase-js 自己删会话键前先核对 sid（K6-signout-lib）：挂到本函数结束、且 ④ 的请求回来（晚到也等）为止
  const release = (o.guardRemoval ?? defaultGuardRemoval)(sid);
  let req: Promise<unknown> = Promise.resolve();
  const onLate = (): void => {
    if (before !== null && readUserId() === before) void dropSession(steps, sid);   // 晚到：结果由 session-store 的标记兜着（A-1）
  };
  try {
    const t0 = Date.now();
    const { deleteOwnDevice } = o.server;
    if (deleteOwnDevice) await withTimeout(deleteOwnDevice, Math.floor(timeoutMs / 2), () => undefined);
    // 删行用掉多少，signOut 就少等多少（清本机的时间另算，它自己有上限）
    const rest = Math.max(timeoutMs - (Date.now() - t0), 0);
    await wipeThisDevice(steps, o.wipeMs, o.cachesMs);
    clearLogQueue(before);   // 这个账号没传完的日志不再传（退出、换账号）
    const signOut = (): Promise<{ serverDone: boolean }> => {
      // ④ 前再读一次 sid（中间不再有 await）：读到别的会话（非 null 且不是 sid），就不调 supabase-js
      // （它会读到新会话的令牌去吊销），也不碰存储。读到 null 照常调：auth-js 读到没有会话本来就不发 /logout。
      // 封装里拿到客户端以后、紧贴 db.auth.signOut 之前还会按 prior 再判断一次（getDb、删 devices 行也要时间）
      const p = sessionReplaced(sid, () => steps.readSessionId())
        ? logoutReplaced(token, rest, o.logoutWithToken)
        : o.server.signOut({ sid, token, budgetMs: rest });
      req = p;
      return p;
    };
    const r = await withTimeout(signOut, rest, () => ({ serverDone: false }), onLate);
    const localDone = r.serverDone && !(o.inTauri ?? isTauri)() ? true : await dropSession(steps, sid);
    await deleteDbAgain(steps);
    return { serverDone: r.serverDone, localDone };
  } finally {
    // supabase-js 删会话键发生在 ④ 的请求 resolve 之前，等它回来再撤（没走到 ④ 时 req 是已完成的，当场撤）
    void req.then(release, release);
  }
}
