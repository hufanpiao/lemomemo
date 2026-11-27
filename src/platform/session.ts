// 本机会话的轻量读取（首屏不加载 supabase-js，离线也能读当前 user_id）
// • 键名同 supabase-js 默认：`sb-<supabaseUrl 主机名第一段>-auth-token`（官网首页、E2E 也按这个名字找）
// • 别的标签页换会话走 storage 事件（onSessionStorageChange）；本页登录、刷新、SIGNED_OUT 走 onAuthStateChange（onAuthUser）。
//   自己退出时退出流程先 markSelfSignOut()，这里见到标记就不上报；各功能页不各自监听 SIGNED_OUT。
//   全仓只有这个文件能写 onAuthStateChange、认 'SIGNED_OUT'：ESLint 规则 lemo/auth-events-in-session（架构 2.3 A30）
// • 官网首页（site/）和 App 同源，能读写这里的 localStorage 键：首页不加第三方脚本
// • Cache Storage 清理也在这里（caches 只在 platform 用）：只删运行时缓存，SW 预缓存保留
// • 删会话：clearLocalSessionIf(sid) 只删“还是那一个”的（退出流程一律用它）；clearAnyLocalSession() 不管是谁都删（只给 takeLocalSession 和测试）
// • 会话存在哪由 session-store.ts 定（网页版 localStorage，exe 是凭据管理器），读删都经 sessionStore()；
//   “自己退出”标记、退出原因不是会话，照旧在 localStorage
// 只读 user.id、user.email 和令牌 payload 里的 session_id，不校验、不记录、不打印令牌
import { isUuid } from '../../shared/core/uuid.ts';
import { buildInfo, isTauri } from './env.ts';
import { readExitNotice, setExitNotice, type ExitNotice } from './exit-notice.ts';
import { afterAppPainted } from './root-paint.ts';
import { openAuth } from './native-bridge.ts';
import { collectRemovals, SESSION_KEY_FAMILY_RE, sessionDropState, sessionRemovalsSettled, sessionStore, showExitIncomplete } from './session-store.ts';
import { reloadPage } from './sw-register.ts';
import { getSupabase, onClientReady } from './supabase/client.ts';
import { recentRefreshFailure, setRefreshSessionReader, type RefreshFailure } from './supabase/refresh-failure.ts';

const KEY_RE = /^sb-.+-auth-token$/;

/** supabase-js 默认的会话键；supabaseUrl 读不出主机名时返回 null（再按格式找） */
export function sessionStorageKey(supabaseUrl: string = buildInfo.supabaseUrl): string | null {
  try {
    const host = new URL(supabaseUrl).hostname;
    const first = host.split('.')[0];
    return first ? `sb-${first}-auth-token` : null;
  } catch {
    return null;
  }
}

/** 会话键：supabaseUrl 能解析就只认那一个键；解析不出来（没配环境变量）才按格式扫 */
function findKey(storage: Storage, supabaseUrl: string): string | null {
  const k = sessionStorageKey(supabaseUrl);
  if (k) return storage.getItem(k) !== null ? k : null;
  for (let i = 0; i < storage.length; i++) {
    const name = storage.key(i);
    if (name && KEY_RE.test(name)) return name;
  }
  return null;
}

/** 从会话 JSON 里取 user.id；格式不对返回 null */
export function userIdOfSession(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { user?: { id?: unknown } } | null;
    const id = o?.user?.id;
    return isUuid(id, true) ? id : null;
  } catch {
    return null;
  }
}

/** 本机会话里的 user_id；没登录、读不到（隐私模式）、格式不对都返回 null */
export function readSessionUserId(storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): string | null {
  try {
    const s = storage ?? sessionStore();
    const key = findKey(s, supabaseUrl);
    return key ? userIdOfSession(s.getItem(key)) : null;
  } catch {
    return null;
  }
}

/** 本机会话里的邮箱（登录页“当前已登录”提示用）；没登录、读不到、不像邮箱（没有 @、超过 254 字符）返回 null */
export function readSessionEmail(storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): string | null {
  try {
    const s = storage ?? sessionStore();
    const key = findKey(s, supabaseUrl);
    const raw = key ? s.getItem(key) : null;
    if (!raw) return null;
    const o = JSON.parse(raw) as { user?: { email?: unknown } } | null;
    const email = o?.user?.email;
    return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
  } catch {
    return null;
  }
}

/**
 * 从 access token 的 payload 里读 session_id；不校验签名、不记录令牌。格式不对返回 null。
 * 只用来在设备列表标“本机”、认出本会话的 devices 行，真正的判断在服务器
 */
export function sessionIdOfToken(token: unknown): string | null {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='))) as { session_id?: unknown } | null;
    const sid = json?.session_id;
    return typeof sid === 'string' && sid ? sid : null;
  } catch {
    return null;
  }
}

/**
 * 本机会话的 access token 原文（同步读）；读不到返回 null。
 * 只给退出流程留在内存里、会话被别的标签页换掉时直接调 /logout（sign-out.ts）；不记录、不写回存储
 */
export function readSessionAccessToken(storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): string | null {
  try {
    const s = storage ?? sessionStore();
    const key = findKey(s, supabaseUrl);
    const raw = key ? s.getItem(key) : null;
    if (!raw) return null;
    const t = (JSON.parse(raw) as { access_token?: unknown } | null)?.access_token;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
}

/** 本机会话 access token 里的 session_id（同步读）；读不到返回 null */
export function readSessionId(storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): string | null {
  return sessionIdOfToken(readSessionAccessToken(storage, supabaseUrl));
}

// refresh-observer.ts 记的 sid 从这里挂上（client.ts 不能 import 本文件，免得循环）
setRefreshSessionReader(() => readSessionId());

/** 别的标签页改了会话（登录、换账号、退出）：回调新的 user_id（没有会话为 null）。返回取消函数 */
export function onSessionStorageChange(
  fn: (userId: string | null) => void,
  target: Window = window,
  supabaseUrl: string = buildInfo.supabaseUrl,
): () => void {
  const key = sessionStorageKey(supabaseUrl);
  const handler = (e: StorageEvent): void => {
    if (e.key === null || (key ? e.key === key : KEY_RE.test(e.key))) fn(readSessionUserId(undefined, supabaseUrl));
  };
  target.addEventListener('storage', handler);
  return () => target.removeEventListener('storage', handler);
}

/** 没有 requestIdleCallback（Safari）时等多久（requestAnimationFrame 只许 src/motion 用） */
const IDLE_FALLBACK_MS = 300;

/** 等浏览器空闲：requestIdleCallback（最多等 2 秒）；没有时延后 IDLE_FALLBACK_MS */
export function whenIdle(fn: () => void): void {
  const w = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, IDLE_FALLBACK_MS);
}

/**
 * 本页的 SIGNED_IN、TOKEN_REFRESHED：回调会话里的 user_id。
 * onSignedOut：SIGNED_OUT（含 supabase-js 从别的标签页转来的），以及“INITIAL_SESSION 为 null 且本机会话键已经没了”；自己退出的不回调。
 * • 订阅在客户端一建好就同步挂上（onClientReady）：不管谁先 getSupabase()，initialize 里刷新被拒发的 SIGNED_OUT 都收得到
 * • 没人用 supabase-js 时，等第一个功能页真画出来（root-paint.ts）再等空闲才加载：只等空闲不够，分包还在下载时浏览器就已“空闲”。
 *   返回取消函数
 */
export function onAuthUser(fn: (userId: string) => void, onSignedOut?: SignedOutFn): () => void {
  let off: (() => void) | null = null;
  let cancelled = false;
  const offReady = onClientReady((db) => {
    if (cancelled) return;
    const { data } = db.auth.onAuthStateChange(authEventHandler(fn, onSignedOut));
    off = () => data.subscription.unsubscribe();
  });
  // 没配环境变量（开发、测试）、分包加载失败：不订阅
  afterAppPainted(() => whenIdle(() => void (cancelled ? undefined : getSupabase().catch(() => undefined))));
  return () => {
    cancelled = true;
    offReady();
    off?.();
  };
}

/** authEventHandler 的可换部分（测试用；默认都读 localStorage） */
export interface AuthEventOptions {
  /** 这次 SIGNED_OUT 是不是自己退出的（按本页最后见到的 session_id 核对标记）；默认 isSelfSignOut */
  selfSignOut?: (sessionId: string | null) => boolean;
  /** 本机会话键已经没了；默认 readSessionUserId() === null */
  sessionGone?: () => boolean;
  /** 挂上监听时本机会话的 session_id；默认同步读 readSessionId() */
  initialSessionId?: string | null;
  /** SIGNED_IN：新会话不是标记里那个就清掉标记；默认 forgetSelfSignOut */
  onSignedIn?: (sessionId: string | null) => void;
  /** 收到 SIGNED_OUT 那一刻本机会话的 session_id；默认同步读 readSessionId() */
  localSessionId?: () => string | null;
  /** 最近 120 秒内刷新令牌失败的那条；默认 recentRefreshFailure */
  refreshFailure?: () => RefreshFailure | null;
}

/** 本页的 SIGNED_OUT 回调：deadSessionId 是本页最后见到的 session_id；failure 是最近 120 秒内刷新失败的记录（没有为 null，按 code 'none'） */
export type SignedOutFn = (deadSessionId?: string | null, failure?: RefreshFailure | null) => void;

/** onAuthStateChange 回调里用到的会话字段（supabase-js 的 Session 的子集） */
export type AuthEventSession = { user: { id: string }; access_token?: unknown } | null;

/**
 * onAuthStateChange 的事件分发（导出给测试）。
 * INITIAL_SESSION 为 null 也当 SIGNED_OUT（订阅晚于 initialize 时只收得到它），但要本机会话键已经没了：
 * 离线冷启动、令牌过期时也会给 INITIAL_SESSION null，那时键还在，不能当被移除去清库（会丢没上传的改动）。
 * 记住本页最后见到的 session_id，SIGNED_OUT 时拿它核对“自己退出”标记，只滤掉标记里那个会话的。
 * • 本机会话已是另一个（两边 session_id 都知道且不同）：这次 SIGNED_OUT 说的是本页原来的会话，本机现在是别的标签页刚登录的——
 *   不回调（不删、不清库、不跳登录页），本页改认新会话；换账号由 storage 事件那一路（watchAccount）管
 * • onSignedOut 带上本页最后见到的 session_id：auth-js 先删键再通知，调用方读不出了，回登录页前按它再删一次（防晚到的刷新写回旧会话）
 * • 本机会话还在且就是本页认的那个：删键被 auth-storage.ts 的保护拦下了，不回调、会话保留
 */
export function authEventHandler(
  fn: (userId: string) => void,
  onSignedOut?: SignedOutFn,
  o: AuthEventOptions = {},
): (event: string, session: AuthEventSession) => void {
  const selfSignOut = o.selfSignOut ?? ((sid: string | null) => isSelfSignOut(undefined, undefined, sid));
  const sessionGone = o.sessionGone ?? (() => readSessionUserId() === null);
  const onSignedIn = o.onSignedIn ?? ((sid: string | null) => forgetSelfSignOut(sid));
  const localSessionId = o.localSessionId ?? (() => readSessionId());
  let sid = o.initialSessionId !== undefined ? o.initialSessionId : readSessionId();
  return (event, session) => {
    if (session) sid = sessionIdOfToken(session.access_token);
    if (event === 'SIGNED_IN') onSignedIn(sid);
    if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session?.user.id) fn(session.user.id);
    else if (!onSignedOut || selfSignOut(sid)) return;
    else if (event === 'SIGNED_OUT') {
      const local = localSessionId();
      if (sid !== null && local !== null && local !== sid) {
        sid = local;   // 本机已是别的标签页刚登录的新会话：这次 SIGNED_OUT 不归它
        return;
      }
      // 键还在且就是本页认的那个：删除被存储保护拦下了，忽略
      if (local !== null && local === sid) return;
      onSignedOut(sid, (o.refreshFailure ?? recentRefreshFailure)());
    } else if (event === 'INITIAL_SESSION' && session === null && sessionGone()) onSignedOut(sid, (o.refreshFailure ?? recentRefreshFailure)());
  };
}

// ───────── 自己退出的标记 ─────────
// 退出流程（sign-out.ts 的 signOutThisDevice）一开头调 markSelfSignOut()，之后它引起的 SIGNED_OUT 不按“被移除”处理。
// • 存 localStorage（各标签页共用）：supabase-js 会把 SIGNED_OUT 转给别的标签页，那边见到标记也不按“被移除”提示
// • 存 `{"at":…,"sid":…}`（不存账号、令牌）：只滤掉那个会话的 SIGNED_OUT，退出后在别处登录的新会话被移除照样提示。
//   旧格式纯时间戳只看时间；本页读不出 session_id 时只认旧格式，不认带 sid 的
// • SIGNED_IN 时新会话不是标记里那个就清掉标记（forgetSelfSignOut）
// • 另记一份在本页内存里（localStorage 写不进时兜底）
// • 只认 SELF_SIGN_OUT_TTL_MS 以内的：退出流程最坏约 19 秒，过期的读到时删掉，不挡住以后真的被移除

const SELF_SIGN_OUT_KEY = 'lemo.self_signout';
/** 标记的有效期 */
export const SELF_SIGN_OUT_TTL_MS = 60_000;

interface SelfMark {
  at: number;
  sid: string | null;
}
let selfMark: SelfMark | null = null;

function fresh(at: number, now: number): boolean {
  return Number.isFinite(at) && now - at >= 0 && now - at < SELF_SIGN_OUT_TTL_MS;
}

/**
 * 标记和这个会话对得上：
 * • sid 为 undefined（不核对会话）：只看时间
 * • sid 为 null（本页不知道）：只认同样不知道 session_id 的标记；带 sid 的分不清是不是本页这次，不认
 * • 本页知道 sid：标记不知道 session_id 时只看时间，知道就要相同
 */
function sameSession(m: SelfMark, sid: string | null | undefined): boolean {
  if (sid === undefined) return true;
  if (sid === null) return m.sid === null;
  return m.sid === null || m.sid === sid;
}

/** 读 localStorage 里的标记；旧格式（纯时间戳）按 sid 未知；认不出返回 null */
function parseMark(v: string): SelfMark | null {
  if (/^\d+$/.test(v)) return { at: Number(v), sid: null };
  try {
    const o = JSON.parse(v) as { at?: unknown; sid?: unknown } | null;
    if (typeof o?.at !== 'number') return null;
    return { at: o.at, sid: typeof o.sid === 'string' && o.sid ? o.sid : null };
  } catch {
    return null;
  }
}

/** 自己退出：在调 signOut（以及任何可能引起 SIGNED_OUT 的请求）之前调；sessionId 默认读本机会话的。不抛错 */
export function markSelfSignOut(storage?: Storage, now: number = Date.now(), sessionId: string | null = readSessionId(storage)): void {
  selfMark = { at: now, sid: sessionId };
  try {
    (storage ?? localStorage).setItem(SELF_SIGN_OUT_KEY, JSON.stringify(selfMark));
  } catch {
    // 写不进：本页内存里那份照样管用
  }
}

/**
 * 最近 SELF_SIGN_OUT_TTL_MS 内有没有自己退出（本页或别的标签页打的标记）；给了 sessionId 时还要是同一个会话。
 * 过期、认不出的标记顺手删掉；会话对不上的不删（它不归这个会话管）
 */
export function isSelfSignOut(storage?: Storage, now: number = Date.now(), sessionId?: string | null): boolean {
  if (selfMark !== null && fresh(selfMark.at, now) && sameSession(selfMark, sessionId)) return true;
  try {
    const s = storage ?? localStorage;
    const v = s.getItem(SELF_SIGN_OUT_KEY);
    if (v === null) return false;
    const m = parseMark(v);
    if (m && fresh(m.at, now)) return sameSession(m, sessionId);
    s.removeItem(SELF_SIGN_OUT_KEY);
  } catch {
    // 读不到：按没有标记
  }
  return false;
}

/**
 * 本页见到 SIGNED_IN：登录的不是标记里那个会话（两边都知道且不同）就清掉标记（内存和 localStorage）。不抛错。
 * 已知边界（暂不处理）：A 页退出流程没走完时别的标签页登录新会话，会清掉 A 的标记，
 * A 的 signOut 引起的 SIGNED_OUT 在其他标签页按“被移除”处理（多一次清库和提示；同账号时新会话也被 takeLocalSession 删掉）
 */
export function forgetSelfSignOut(sessionId: string | null, storage?: Storage): void {
  if (sessionId === null) return;
  if (selfMark?.sid && selfMark.sid !== sessionId) selfMark = null;
  try {
    const s = storage ?? localStorage;
    const v = s.getItem(SELF_SIGN_OUT_KEY);
    const m = v === null ? null : parseMark(v);
    if (m?.sid && m.sid !== sessionId) s.removeItem(SELF_SIGN_OUT_KEY);
  } catch {
    // 读不到：没有可清的
  }
}

/** 测试用：清掉本页内存里那份标记 */
export function resetSelfSignOutForTest(): void {
  selfMark = null;
}

/**
 * SW 预缓存的缓存名前缀（Workbox 默认 `workbox-precache-v2-<scope>`）。只有 App 外壳，不含账号数据；sw.ts 改 cacheNames 时这里要一起改
 */
export const PRECACHE_PREFIX = 'workbox-precache';

/**
 * 清 Cache Storage 的运行时缓存（可能带账号数据的全删）；SW 预缓存保留：删了以后换账号重新载入时正好离线，外壳就打不开。不抛错
 */
export async function clearCacheStorage(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    for (const k of await caches.keys()) {
      if (!k.startsWith(PRECACHE_PREFIX)) await caches.delete(k);
    }
  } catch {
    // 拿不到 caches（隐私模式等）：本机库已清
  }
}

/**
 * 同步删掉本机的 supabase 会话，**不管是谁的**（退出流程一律用 clearLocalSessionIf / takeLocalSession）。
 * 删 `sb-<ref>-auth-token`、`…-code-verifier`、`…-user`；supabaseUrl 解析不出来时按格式删所有 `sb-*-auth-token` 及附属键。
 * `-user` 是 auth-js 配过 userStorage 时单独存的 user，本项目一般没有，删了无害；PKCE 分流程键不删（登录走邮箱验证码，不用 PKCE）。
 * 不抛错。删除马上生效；返回的 Promise 说删没删成：网页版马上 resolve，exe 里等 Rust 的 session_remove 都回来，有一个失败就是 false
 */
export function clearAnyLocalSession(storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): Promise<boolean> {
  return collectRemovals(() => {
    let ok = true;
    try {
      const s = storage ?? sessionStore();
      const key = sessionStorageKey(supabaseUrl);
      const keys: string[] = [];
      if (key) keys.push(key);
      else {
        for (let i = 0; i < s.length; i++) {
          const name = s.key(i);
          if (name && KEY_RE.test(name)) keys.push(name);
        }
      }
      for (const k of keys) {
        for (const name of [k, `${k}-code-verifier`, `${k}-user`]) {
          try {
            s.removeItem(name);
          } catch {
            ok = false;   // 单个键删不掉：接着删别的，结果报失败
          }
        }
      }
    } catch {
      // 拿不到存储（隐私模式等）：没有可删的
    }
    return ok;
  });
}

/**
 * 拿走本机会话：同步读出 session_id 再删掉，返回删之前的 session_id（读不出为 null）。不抛错。
 * watchAccount 收到本页 SIGNED_OUT 时用：和判断“会话里现在是谁”在同一同步段里做，之后清库期间别的标签页登录的新会话不会被删。
 * “会话被吊销”来自请求回包时不要用它（回包前可能已写进新会话）：用发请求前记下的 sid 调 clearLocalSessionIf
 */
export function takeLocalSession(storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): string | null {
  const sid = readSessionId(storage, supabaseUrl);
  void clearAnyLocalSession(storage, supabaseUrl);
  return sid;
}

/**
 * 本机会话还是 sessionId 那一个（按 session_id 比）才删。sessionId 为 null 表示当时读不出，只在本机仍读不出时删。不抛错。
 * 返回值同 clearAnyLocalSession；不删时为 true
 */
export function clearLocalSessionIf(sessionId: string | null, storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): Promise<boolean> {
  if (readSessionId(storage, supabaseUrl) === sessionId) return clearAnyLocalSession(storage, supabaseUrl);
  return Promise.resolve(true);   // 不是那一个：不删，也没有失败
}

/**
 * 退出期间 supabase-js 要删 key 时能不能删（supabase/auth-storage.ts 用，sign-out.ts 挂上）：
 * • 不是会话键或其附属键 `<会话键>-…`：照删
 * • 会话的键：本机没有会话键、或 session_id 还是 sessionId 才删，别的标签页这时写进来的新会话连同附属键都留着
 * 不抛错（读不到存储时按能删）
 */
export function mayRemoveSessionKey(key: string, sessionId: string | null, storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): boolean {
  try {
    const main = sessionStorageKey(supabaseUrl);
    const related = main ? key === main || key.startsWith(`${main}-`) : SESSION_KEY_FAMILY_RE.test(key);
    if (!related) return true;
    const s = storage ?? sessionStore();
    return findKey(s, supabaseUrl) === null || readSessionId(s, supabaseUrl) === sessionId;
  } catch {
    return true;
  }
}

/**
 * 没登录：去登录页（不建本机库）。带 notice 时先记下退出原因，登录页据此提示；会话没了由 core/device-exit.ts 调这里。
 * • 带 removed / expired 时先删本机会话（否则登录页同时显示“当前已登录”和“被移除”），但只在本机会话还是 deadSessionId 那一个时删
 * • 已记下退出原因（disabled、pending_deletion 等）时，不拿 removed、expired 覆盖
 */
export function goToAuth(...args: GoToAuthArgs): void {
  const [notice] = args;
  if (args[0] === 'removed' || args[0] === 'expired') void clearLocalSessionIf(args[1]);
  // removed、expired 不覆盖已记下的原因（已停用优先）
  if (notice && !((notice === 'removed' || notice === 'expired') && readExitNotice() !== null)) setExitNotice(notice);
  // exe 里账号界面画出来过：主窗口不会因开登录小窗口而卸载，旧内容会一直显示。等会话真删掉（最多 3 秒）再整页重新载入。
  // 删不掉：不重新载入（会带着会话回到已登录界面），改显示“退出没完成，点重试”；之后删成了再重新载入
  if (isTauri() && accountUiShown) {
    void sessionRemovalsSettled().then(() => {
      if (sessionDropState() === 'ok') reloadPage();
      else showExitIncomplete();
    });
    return;
  }
  // 网页版 location.replace('/app/auth/')；exe 主窗口不许导航到登录页，改开登录小窗口（native-bridge.ts 的 openAuth）
  void openAuth();
}

let accountUiShown = false;


/** main 入口画出账号界面以后调一次（exe 里之后的 goToAuth 先整页重新载入） */
export function markAccountUiShown(): void {
  accountUiShown = true;
}

/** 测试用 */
export function resetAccountUiShownForTest(): void {
  accountUiShown = false;
}

/** goToAuth 的参数：带 removed 或 expired 时必须给作废的那个 session_id */
export type GoToAuthArgs = [] | [notice: Exclude<ExitNotice, 'removed' | 'expired'>] | [notice: 'removed' | 'expired', deadSessionId: string | null];

// ───────── 退出原因在 exit-notice.ts，这里原样转出 ─────────
export { clearExitNotice, EXIT_NOTICE_TTL_MS, exitNoticeOf, isExitNotice, readExitNotice, setExitNotice, type ExitNotice } from './exit-notice.ts';
