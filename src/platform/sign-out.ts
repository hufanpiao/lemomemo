// 退出这台设备的清理步骤：登录页“退出并换账号”和设置页“退出登录 / 被移除”共用；不经 core/device-exit.ts
// 顺序：① 删本会话的 devices 行 ② 清本机库并按库名删 ③ 清运行时缓存（②③ 即 exit-basics.ts 的 wipeThisDevice） ④ signOut local ⑤ 再按库名删一次库
// 不变量：会话放在 ④（被打断最坏“有会话、没库”）；兜底删会话只删退出前那一个 sid；①④ 合计最多 SIGN_OUT_TIMEOUT_MS，②③⑤ 各有上限，超时照样清本机
// 不变量：一开头 markSelfSignOut，本页 SIGNED_OUT 不再按被移除处理；发请求之前先删 lemo.reauth（wipeThisDevice 里还会删一次），
// lemo.authloss 只在本人主动退出时删
// 不变量：清本机只有 wipeThisDevice 一个入口、一套超时（core/account.ts wipeLocal 只给它配上本页的库）
// 为什么这样排见 docs/10-架构/历史版本/文件头原文-2026-11-11退出链路整改.md
import { buildInfo, isTauri } from './env.ts';
import { clearAuthLoss, clearReauth } from './auth-loss-store.ts';
import { appFetch } from './http.ts';
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
import { DELETE_WAIT_MS, deleteLocalDb, withinLimit, wipeThisDevice, withTimeout, type WipeSteps } from './exit-basics.ts';
import { rlog } from './run-log-api.ts';

/** ①④ 服务器部分的总超时 */
export const SIGN_OUT_TIMEOUT_MS = 8000;

/** 退出用的几步：清本机（WipeSteps）加上删本机会话、读 session_id */
export interface ExitSteps extends WipeSteps {
  /**
   * 同步删本机会话：session_id 还是 sessionId 才删。sessionId 必填；null = 那时本机没有会话，只在仍没有会话时删。
   * 返回删没删成（exe 里删凭据管理器失败为 false；不是那个会话、不删也是 true）
   */
  clearLocalSessionIf(sessionId: string | null): Promise<boolean>;
  /** 本机会话的 session_id；读不出为 null */
  readSessionId(): string | null;
}

export const defaultExitSteps: ExitSteps = {
  deleteDb: () => deleteLocalDb(),
  clearCacheStorage,
  clearLocalSessionIf: (sid) => clearLocalSessionIf(sid),
  readSessionId: () => readSessionId(),
  disconnectPush: () => disconnectPushLazy(),
};

/**
 * 删本机会话（同步生效），不抛错；只在本机会话还是 sessionId 时才删。返回删没删成：同步抛错、异步失败一律 false
 */
export function dropSession(steps: Pick<ExitSteps, 'clearLocalSessionIf'>, sessionId: string | null): Promise<boolean> {
  try {
    return Promise.resolve(steps.clearLocalSessionIf(sessionId)).catch(() => false);   // 同步调：删除当场生效
  } catch {
    return Promise.resolve(false);
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

/** 退出一开头记下的旧会话（④ 交给 server.signOut）：只在内存里，不记录、不打印 */
export interface PriorSession {
  sid: string | null;
  token: string | null;
  /** ④ 剩下的等待预算：封装里直接 logout 时按它 abort */
  budgetMs: number;
}

/** 服务器那一半（调用方实现） */
export interface SignOutServer {
  /** ① 删本会话那一行 devices；出错也 resolve。signOut 里已经删了就不传 */
  deleteOwnDevice?(): Promise<void>;
  /**
   * ④ signOut({scope: 'local'})；serverDone = 这次登录已吊销（或本来就不在了）。
   * 封装紧贴 db.auth.signOut 之前再判断一次 sessionReplaced(prior.sid)，换了就改 logoutReplaced
   */
  signOut(prior: PriorSession): Promise<{ serverDone: boolean }>;
}

export interface SignOutOptions {
  server: SignOutServer;
  steps?: ExitSteps;
  /** 本机会话里的 user_id（晚到处理用） */
  readUserId?: () => string | null;
  markSelf?: () => void;
  /** 挂上 supabase-js 删会话键的保护，返回撤掉的函数 */
  guardRemoval?: (sid: string | null) => () => void;
  readToken?: () => string | null;
  /** ④ 前会话已被换掉时，用旧令牌直接 /logout */
  logoutWithToken?: (token: string, timeoutMs: number) => Promise<{ serverDone: boolean }>;
  timeoutMs?: number;
  wipeMs?: number;
  cachesMs?: number;
  /** exe 里服务器退成了也兜底删一次 */
  inTauri?: () => boolean;
}

/** ⑤ 会话删掉以后再按库名删一次库（出错也 resolve）；删不掉的残留由冷启动时清掉 */
export async function deleteDbAgain(steps: Pick<ExitSteps, 'deleteDb'>): Promise<void> {
  await withinLimit(() => steps.deleteDb(), DELETE_WAIT_MS);
}

/**
 * 用旧令牌直接吊销那一次登录（同 auth-js admin.signOut）。非 2xx、断网、超时都算没退成；不刷新令牌、不碰存储。永远 resolve
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
 * 本机会话已换成别的标签页的新会话。重读为 null 不算：auth-js 读到没有会话本来就不发 /logout。不抛错
 */
export function sessionReplaced(sid: string | null, read: () => string | null = () => readSessionId()): boolean {
  const now = readSafe(read);
  return now !== null && now !== sid;
}

/**
 * 会话被换掉时代替 supabase-js 的 signOut。没有旧令牌 = 本来就没有会话，**有意**算退成（不提示一次不存在的“没能吊销”）
 */
export function logoutReplaced(
  token: string | null,
  timeoutMs: number = SIGN_OUT_TIMEOUT_MS,
  logout: (token: string, timeoutMs: number) => Promise<{ serverDone: boolean }> = logoutWithToken,
): Promise<{ serverDone: boolean }> {
  if (token === null) return Promise.resolve({ serverDone: true });
  return logout(token, timeoutMs);
}

/** ④ 的预算扣掉已用掉的时间：外层超时以后，里面直接 logout 的请求也跟着停 */
export function budgetLeft(budgetMs: number, t0: number, now: number = Date.now()): number {
  return Math.max(budgetMs - Math.max(now - t0, 0), 0);
}

function readSafe(read: () => string | null): string | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** 退出期间 supabase-js 只能删“还是 sid 那一个”的会话键 */
export function defaultGuardRemoval(sid: string | null): () => void {
  return guardSessionRemoval((key) => mayRemoveSessionKey(key, sid), SELF_SIGN_OUT_TTL_MS);
}

/**
 * 退出这台设备：本机一定清空、会话删掉；serverDone = false 时调用方提示“没能吊销”。
 * localDone 只代表最后兜底那一次删除，生产代码没人读（界面看 session-store 的删除状态）。
 * 服务器退成了时 supabase-js 自己删键但不写“待删除”标记，所以 exe 里再显式兜底删一次；网页版不兜底（localStorage 同步删）
 */
export async function signOutThisDevice(o: SignOutOptions): Promise<{ serverDone: boolean; localDone: boolean }> {
  const steps = o.steps ?? defaultExitSteps;
  const readUserId = o.readUserId ?? (() => readSessionUserId());
  const timeoutMs = o.timeoutMs ?? SIGN_OUT_TIMEOUT_MS;
  // 先打标记再发任何请求：① 删行也可能因刷新令牌失败引起 SIGNED_OUT
  (o.markSelf ?? (() => markSelfSignOut()))();
  // lemo.reauth 在发请求之前先删：中途 SIGNED_OUT 或关页都不会把本人退出当成“登录过期”留下本机库
  clearAuthLoss();
  clearReauth();
  const before = readUserId();
  // 兜底只删退出前的会话，别的标签页刚登录的新会话不删
  const sid = sessionIdOf(steps);
  const token = readSafe(o.readToken ?? (() => readSessionAccessToken()));
  // supabase-js 删会话键前先核对 sid：挂到本函数结束、且 ④ 的请求回来（晚到也等）为止
  const release = (o.guardRemoval ?? defaultGuardRemoval)(sid);
  let req: Promise<unknown> = Promise.resolve();
  const onLate = (): void => {
    if (before !== null && readUserId() === before) void dropSession(steps, sid);   // 晚到：结果由 session-store 的标记兜着
  };
  try {
    const t0 = Date.now();
    const { deleteOwnDevice } = o.server;
    if (deleteOwnDevice) await withTimeout(deleteOwnDevice, Math.floor(timeoutMs / 2), () => undefined);
    // 删行用掉多少，signOut 就少等多少（清本机另有上限）
    const rest = Math.max(timeoutMs - (Date.now() - t0), 0);
    await wipeThisDevice(steps, before, o.wipeMs, o.cachesMs);   // 这个账号没传完的日志也在这里清（不再传）
    const signOut = (): Promise<{ serverDone: boolean }> => {
      // ④ 前再读一次 sid（中间不再有 await）：换成别的会话就不调 supabase-js（它会拿新会话的令牌去吊销），也不碰存储。
      // 封装紧贴 db.auth.signOut 之前还会按 prior 再判断一次
      const p = sessionReplaced(sid, () => steps.readSessionId())
        ? logoutReplaced(token, rest, o.logoutWithToken)
        : o.server.signOut({ sid, token, budgetMs: rest });
      req = p;
      return p;
    };
    const r = await withTimeout(signOut, rest, () => ({ serverDone: false }), onLate);
    const localDone = r.serverDone && !(o.inTauri ?? isTauri)() ? true : await dropSession(steps, sid);
    await deleteDbAgain(steps);
    rlog(`signout server=${r.serverDone} local=${localDone}`);
    return { serverDone: r.serverDone, localDone };
  } finally {
    // supabase-js 删会话键发生在 ④ 的请求 resolve 之前，等它回来再撤
    void req.then(release, release);
  }
}
