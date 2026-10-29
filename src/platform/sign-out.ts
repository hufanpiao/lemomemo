// 退出这台设备（架构 4.1、0.38 第 35～37 条；接手清单 K-signout-merge）：登录页“退出并换账号”（K4）和设置页“退出登录 / 被移除”（K9）共用这一份
// 顺序：① 删本会话那一行 devices ② 清本机库 ③ 清 Cache Storage（只删运行时缓存，保留 workbox-precache，见 session.ts）
//   ④ signOut({scope: 'local'})，不是 ok 就 clearLocalSessionIf(退出前的 session_id) 兜底 ⑤ 会话删掉以后再按库名删一次库。
//   会话放在 ④：中途被打断最坏是“有会话、没库”，下次打开能自愈
// • ⑤ 的原因（K-signout-merge 复审 M2）：②③ 那几秒会话还在；按库名删库会让别的主 App 标签页收到 versionchange 立即 reload，
//   它用还在的旧会话 coldStart、重建库并开始同步旧账号的数据。会话删掉以后再删一次，库就不会留在硬盘上（共用电脑）。
//   主 App 那边“会话变 null 时先删库”交 K6（core/account.ts）
// • 本机库：主 App 传 wipe（core 的 sealForExit 设闸 + clearAll；platform 不能引 core，登录页也不能带进 core——它经 manifests 带进 zod，
//   zod 4 的 allowsEval 探测在登录页的严格 CSP 下报 eval 违规）。没传 wipe、wipe 说库不能用、出错或超时：按库名直接删 planner-v4。
//   主 App 的 deleteDb 先关本页连接再删（设置页 data/local.ts），免得本页自己收到 versionchange 而 reload
// • 超时：appFetch 没有超时，令牌过期时 supabase-js 先刷新再退避重试，网络卡住时请求几十秒不返回。①④ 一共最多 SIGN_OUT_TIMEOUT_MS（① 最多一半）；
//   ②③⑤ 各有上限。超时按“服务器没退成”处理：照样清本机、删本机会话。
//   最坏耗时：登录页约 16 秒（删库 3 + 缓存 2 + ①④ 8 + ⑤ 3）；主 App 约 19 秒（再加 wipe 3 秒超时）。一般网络下一两秒
// • 登录页没传 ①：它的 api.signOutHere() 自己先删行再 signOut（auth-api.ts，不归这里改），两步合在 ④ 里，共用 ④ 的等待时间
// • 晚到：④ 超时以后才回来、本机会话又是退出前那个 user_id（令牌刷新把旧会话写回）就再删一次；别的账号或没有会话不动。
//   只挂在 ④ 上：① 晚到时本机会话本来就还在（④ 还没做），挂上会把会话提前删掉，之后 signOut 拿不到会话、误报成功
// • 封存挡不住 Service Worker：以后 SW 收到通知按键会直接写 pending_actions（core/pending-actions.ts，推送从 B2 起），不经本页的 cache，
//   sealForExit 管不到；退出过程中写进去的会被 ⑤ 删库带走，但 ⑤ 之后、离开页面之前写进去的会留下。
//   K-sw-seal 结论（10-29）：B1 的 SW 不碰 IndexedDB，运行时缓存只有公共的导航 HTML、节假日、字体（tests/build/sw-no-user-data.test.ts 钉住）；
//   B2 的 SW：⑴ 只往已存在、owner 仓有 user_id 的库里写（遇到要新建库就中止），且推送带的 user_id 和 owner 一致才写，不一致丢掉（不能直接用 owner 的值，防串号）；
//   ⑵ 开库后监听 versionchange、收到立刻关连接，否则 ⑤ 删库被挡、退出卡住；⑶ 退出、换账号时退掉推送订阅或由服务器换绑，旧账号的通知不再推来。
//   ⑤ 删库以后 SW 写不进去。不靠“通知 SW 停写”：SW 随时被浏览器停掉重启，内存里的标记会丢
// • 一开头先 markSelfSignOut()（K6-signedout）：之后 ④ signOut、① 删行时刷新令牌失败等引起的本页 SIGNED_OUT，
//   会话层（session.ts 的 onAuthUser → core/account.ts 的 watchAccount）见到标记就不再按“被移除”重复处理
// • 兜底删本机会话只删“退出前那一个”（接手清单 K6-sugg3 ①）：一开头记下本机会话的 session_id，④ 不是 ok、④ 晚到时都按它
//   clearLocalSessionIf(sid)（= session.ts 的 clearLocalSessionIf），退出那几秒里别的标签页刚登录的新会话不删。
//   ExitSteps 只有这一个删会话的方法、sid 必填（K6-sugg4 ②）：没有“不给参数就直接删”的写法，桩忽略参数也不会让生产代码变成无条件删
// • ④ 里 supabase-js 自己删会话键也只删“退出前那一个”（接手清单 K6-signout-lib，架构师 10-30：不改成直接调 /logout，加存储保护）：
//   auth-js 2.118 的 _signOut 先读本机会话、拿它的令牌调 /logout，最后 _removeSession 无条件删会话键（默认不加锁）。
//   client.ts 给 auth 传的是包了 localStorage 的适配器（supabase/auth-storage.ts），这里从一开头到 ④ 的请求回来（晚到也算，
//   最多 SELF_SIGN_OUT_TTL_MS）挂上删键判断：session.ts 的 mayRemoveSessionKey(key, sid)，本机会话已不是 sid 就不删它和它的附属键。
//   平时适配器和直接用 localStorage 一样，键名、storage 事件都不变
// • ④ 前再读一次 sid（K6-signout-lib 收窄，架构师 10-30 更正）：supabase-js 调 /logout 用的令牌是它在 ④ 里从本机读的，
//   ①②③ 那几秒里别的标签页登录的新会话会被它读到、在服务器上吊销。所以一开头和 sid 一起把旧会话的 access token 记在内存里（不记录、不写回），
//   ④ 前再读一次 sid：还是那一个或读到 null 就照旧调 supabase-js（存储保护照旧）；已经换成别的会话就不调 supabase-js、也不碰存储，
//   用记下的旧令牌经 appFetch 直接 POST <supabaseUrl>/auth/v1/logout?scope=local（logoutWithToken；版本门对它放行）：
//   2xx（一般 204）算 serverDone，401（令牌过期）、断网、超时都算没退成，过期也不刷新令牌；等待用 ④ 剩下的预算
//   剩下的已知问题：服务器上可能吊销了新会话——只剩“再读 sid”到 supabase-js 自己读本机会话之间几个微任务
//   （signOut 先等 initializePromise 再 _useSession 读存储），这时别的标签页正好写进新会话才会碰到；后果是那个标签页要重新登录。不再处理
// • localStorage 里的 install_id、pv-locale 不清；日志上传队列 lemo.logq.<user_id>（log-store.ts，架构 0.38 第 68 条）在 ② 清本机时一起清
//   （读不到是谁时清全部 lemo.logq.*）
import { buildInfo } from './env.ts';
import { appFetch } from './http.ts';
import { clearLogQueue } from './log-store.ts';
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

/** 本机库名（= core/cache.ts 的 DB_NAME；platform 不引 core，测试守着两边一致） */
export const LOCAL_DB_NAME = 'planner-v4';
/** 删库最多等多久（别的标签页开着库时浏览器会等它关） */
export const DELETE_WAIT_MS = 3000;
/** ①④ 服务器部分的总超时 */
export const SIGN_OUT_TIMEOUT_MS = 8000;
/** ② 主 App 清库（wipe）最多等多久，超时改走按库名删库 */
export const WIPE_TIMEOUT_MS = 3000;
/** ③ 清 Cache Storage 最多等多久 */
export const CACHES_TIMEOUT_MS = 2000;

/**
 * 到点还没返回就用 fallback() 的值；run 抛错（同步或异步）也用 fallback()。fallback 只给值，不要有副作用。
 * 原来的请求不取消：它在超时以后才回来时调一次 onLate
 */
export function withTimeout<T>(run: () => Promise<T>, ms: number, fallback: () => T, onLate?: () => void): Promise<T> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const req = Promise.resolve().then(run);
  const late = (): void => {
    if (timedOut) onLate?.();
  };
  req.then(late, late);
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(fallback());
    }, ms);
  });
  return Promise.race([req.catch(() => fallback()), timeout]).finally(() => clearTimeout(timer));
}

export type DeleteDbResult = 'deleted' | 'blocked' | 'error' | 'unavailable';

/** 按库名删掉本机库；永远 resolve。别的标签页没关库（blocked）时最多等 waitMs，删库请求留在浏览器里，那边一关就删 */
export function deleteLocalDb(
  factory: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB,
  name: string = LOCAL_DB_NAME,
  waitMs: number = DELETE_WAIT_MS,
): Promise<DeleteDbResult> {
  if (!factory) return Promise.resolve('unavailable');
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: DeleteDbResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => finish('blocked'), waitMs);
    try {
      const req = factory.deleteDatabase(name);
      req.onsuccess = () => finish('deleted');
      req.onerror = () => finish('error');
    } catch {
      finish('error');
    }
  });
}

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
   * sessionId 必填（K6-sugg4 ②）；null = 那时本机没有会话 / 读不出，只在本机仍没有会话时删
   */
  clearLocalSessionIf(sessionId: string | null): void;
  /** 本机会话 access token 里的 session_id（默认 session.ts 的 readSessionId）；读不出为 null */
  readSessionId(): string | null;
}

export const defaultExitSteps: ExitSteps = {
  deleteDb: () => deleteLocalDb(),
  clearCacheStorage,
  clearLocalSessionIf: (sid) => clearLocalSessionIf(sid),
  readSessionId: () => readSessionId(),
};

/** 清本机库和 Cache Storage（②③）；某一步失败或超时不挡后面，永远 resolve */
export async function wipeThisDevice(steps: ExitSteps, wipeMs = WIPE_TIMEOUT_MS, cachesMs = CACHES_TIMEOUT_MS): Promise<void> {
  const { wipe } = steps;
  const cleared = wipe ? await withTimeout(wipe, wipeMs, () => false) : false;
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

/** 同步删本机会话，不抛错；只在本机会话还是 sessionId 时才删（必填，K6-sugg4 ②） */
export function dropSession(steps: Pick<ExitSteps, 'clearLocalSessionIf'>, sessionId: string | null): void {
  try {
    steps.clearLocalSessionIf(sessionId);
  } catch {
    // 存储不可用：本来也存不下会话
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

/** 退出这台设备：①②③④⑤，本机一定清空、本机会话一定删掉；serverDone = false 时调用方提示“服务器上的这次登录暂时没能吊销” */
export async function signOutThisDevice(o: SignOutOptions): Promise<{ serverDone: boolean }> {
  const steps = o.steps ?? defaultExitSteps;
  const readUserId = o.readUserId ?? (() => readSessionUserId());
  const timeoutMs = o.timeoutMs ?? SIGN_OUT_TIMEOUT_MS;
  // 先打标记再发任何请求：① 删行也可能因刷新令牌失败引起 SIGNED_OUT
  (o.markSelf ?? (() => markSelfSignOut()))();
  const before = readUserId();
  // 退出前的会话（K6-sugg3 ①）：兜底只删它，别的标签页刚登录的新会话不删
  const sid = sessionIdOf(steps);
  // 旧会话的令牌只留在内存里：④ 前会话被换掉时用它直接 /logout（K6-signout-lib 收窄）
  const token = readSafe(o.readToken ?? (() => readSessionAccessToken()));
  // supabase-js 自己删会话键前先核对 sid（K6-signout-lib）：挂到本函数结束、且 ④ 的请求回来（晚到也等）为止
  const release = (o.guardRemoval ?? defaultGuardRemoval)(sid);
  let req: Promise<unknown> = Promise.resolve();
  const onLate = (): void => {
    if (before !== null && readUserId() === before) dropSession(steps, sid);
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
    if (!r.serverDone) dropSession(steps, sid);
    await deleteDbAgain(steps);
    return { serverDone: r.serverDone };
  } finally {
    // supabase-js 删会话键发生在 ④ 的请求 resolve 之前，等它回来再撤（没走到 ④ 时 req 是已完成的，当场撤）
    void req.then(release, release);
  }
}
