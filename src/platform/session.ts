// 本机会话的轻量读取（架构 4.1 第 0.38 第 17 条、2.6 首屏不加载 supabase-js）
// • 启动时不加载 supabase-js，直接读它存在 localStorage 里的会话，拿当前 user_id（离线也能读）
// • 键名和 supabase-js 的默认值一致：`sb-<supabaseUrl 主机名第一段>-auth-token`（官网首页、E2E 也按这个名字找）
// • 换账号的判断时机里，“别的标签页”走 storage 事件（onSessionStorageChange），“登录 / 刷新令牌”走 onAuthStateChange（onAuthUser）
// • 本标签页的 SIGNED_OUT（刷新失败、被移除、被退出）也走这同一个 onAuthStateChange（onAuthUser 的第二个回调，接手清单 K6-signedout）；
//   自己点“退出登录”的那一次由退出流程先 markSelfSignOut()，这里见到标记就不往上报（K8、各功能页不各自监听 SIGNED_OUT）。
//   全仓只有这个文件能写 onAuthStateChange、认 'SIGNED_OUT'：ESLint 规则 lemo/auth-events-in-session（架构 2.3 A30）
// • 官网首页（site/）和 App 同源，能读写这里用的 localStorage 键（会话、lemo.self_signout）：首页不加第三方脚本（架构 16.1）
// • Cache Storage 的清理也在这里（caches 只在 platform 用）：只删运行时缓存，SW 预缓存保留（0.38 第 36 条）
// • 删本机会话分两个函数（接手清单 K6-sugg4 ②）：clearLocalSessionIf(sid) 只删“还是那一个”的会话（sid 必填，退出流程一律用它）；
//   clearAnyLocalSession() 不管是谁的都删（名字里写明，只给 takeLocalSession 和测试用）。不再有“给不给参数决定删不删”的写法
// 只读 user.id、user.email 和令牌 payload 里的 session_id（sessionIdOfToken），不校验、不记录、不打印令牌
import { buildInfo } from './env.ts';
import { readExitNotice, setExitNotice, type ExitNotice } from './exit-notice.ts';
import { getSupabase, onClientReady } from './supabase/client.ts';

const KEY_RE = /^sb-.+-auth-token$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** 会话键：supabaseUrl 能解析就只认那一个键（K6 审查 L8）；解析不出来（开发、测试没配环境变量）才按格式扫 */
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
    return typeof id === 'string' && UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** 本机会话里的 user_id；没登录、读不到（隐私模式）、格式不对都返回 null */
export function readSessionUserId(storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): string | null {
  try {
    const s = storage ?? localStorage;
    const key = findKey(s, supabaseUrl);
    return key ? userIdOfSession(s.getItem(key)) : null;
  } catch {
    return null;
  }
}

/**
 * 本机会话里的邮箱（登录页“当前已登录 <邮箱>，要换账号请先退出”用，架构 4.1、0.38 第 35 条）；
 * 只读 user.email，键名取法同 readSessionUserId。没登录、读不到、不像邮箱（没有 @、超过 254 个字符）都返回 null
 */
export function readSessionEmail(storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): string | null {
  try {
    const s = storage ?? localStorage;
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
 * 从 access token 的 payload 里读 session_id（base64url）；只解这一个字段，不校验签名、不记录、不打印令牌。
 * 用途：设置 › 设备标“本机”、认出本会话的 devices 行（真正的判断都在服务器，0.29 续第 99 条）。格式不对返回 null
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
 * 本机会话的 access token 原文（键名取法同 readSessionUserId，同步读、不联网）；没登录、读不到、不是字符串都返回 null。
 * 只给退出流程留在内存里、会话被别的标签页换掉时拿它直接调 /logout（sign-out.ts，K6-signout-lib）；不记录、不打印、不写回存储
 */
export function readSessionAccessToken(storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): string | null {
  try {
    const s = storage ?? localStorage;
    const key = findKey(s, supabaseUrl);
    const raw = key ? s.getItem(key) : null;
    if (!raw) return null;
    const t = (JSON.parse(raw) as { access_token?: unknown } | null)?.access_token;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
}

/** 本机会话 access token 里的 session_id（键名取法同 readSessionUserId，同步读、离线也能读）；没登录、读不到、格式不对都返回 null */
export function readSessionId(storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): string | null {
  return sessionIdOfToken(readSessionAccessToken(storage, supabaseUrl));
}

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

/** 没有 requestIdleCallback（Safari）时等多久：首屏一般已经画完（requestAnimationFrame 只许 src/motion 用，A25） */
const IDLE_FALLBACK_MS = 300;

/** 等浏览器空闲：requestIdleCallback（最多等 2 秒）；没有时延后 IDLE_FALLBACK_MS */
export function whenIdle(fn: () => void): void {
  const w = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, IDLE_FALLBACK_MS);
}

/**
 * 本页的登录、刷新令牌事件（onAuthStateChange 的 SIGNED_IN、TOKEN_REFRESHED）：回调会话里的 user_id。
 * onSignedOut：同一个监听里的 SIGNED_OUT（刷新失败、被移除、被退出；也包括 supabase-js 从别的标签页转来的），
 * 以及“INITIAL_SESSION 为 null 且本机会话键已经没了”（见 authEventHandler）；自己退出（isSelfSignOut()）的不回调。
 * 全 App 只有这一处订阅 onAuthStateChange（K6-signedout；ESLint lemo/auth-events-in-session 守着，架构 2.3 A30）。
 * • 订阅在客户端一建好时就同步挂上（supabase/client.ts 的 onClientReady，审查 M1）：谁先 getSupabase()（同步的 ensureSession 往往更早）都一样，
 *   initialize 里刷新被拒发的 SIGNED_OUT 一定收得到
 * • 没人用 supabase-js 时，等首屏画完、浏览器空闲才加载它（whenIdle，K6 审查 L6）。返回取消函数
 */
export function onAuthUser(fn: (userId: string) => void, onSignedOut?: (deadSessionId?: string | null) => void): () => void {
  let off: (() => void) | null = null;
  let cancelled = false;
  const offReady = onClientReady((db) => {
    if (cancelled) return;
    const { data } = db.auth.onAuthStateChange(authEventHandler(fn, onSignedOut));
    off = () => data.subscription.unsubscribe();
  });
  whenIdle(() => {
    if (!cancelled) void getSupabase().catch(() => undefined);   // 没配环境变量（开发、测试）、分包加载失败：不订阅
  });
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
}

/** onAuthStateChange 回调里用到的会话字段（supabase-js 的 Session 的子集） */
export type AuthEventSession = { user: { id: string }; access_token?: unknown } | null;

/**
 * onAuthStateChange 的事件分发（单独导出给测试；不加载 supabase-js）。
 * INITIAL_SESSION 为 null 也当 SIGNED_OUT（审查 M1：订阅晚于 initialize 时只收得到它），但要本机会话键已经没了（sessionGone）：
 * 离线冷启动、令牌又过期时 supabase-js 也给 INITIAL_SESSION null，那时会话键还在，不能当成被移除去清库（会丢没上传的改动）。
 * 记住本页最后见到的 session_id（挂上时读一次，之后每个带会话的事件更新）：SIGNED_OUT 时拿它核对“自己退出”的标记，
 * 只滤掉标记里那个会话的 SIGNED_OUT（K6-signedout-sugg ①）。
 * • SIGNED_OUT 时本机会话已经是另一个（本页最后见到的 session_id 和本机会话的都知道、且不同；接手清单 K6-sugg4 ④）：
 *   这次 SIGNED_OUT 说的是本页原来那个会话（多半是 supabase-js 从别的标签页转来的），本机现在那个是别的标签页刚登录的新会话——
 *   不回调 onSignedOut（不删它、不清库、不跳登录页），本页改认这个新会话（之后它的 SIGNED_OUT 照常处理）；
 *   新会话若是别的账号，换账号由 storage 事件那一路（watchAccount）管。本机没有会话、或任一边不知道 session_id 时照旧回调
 * • onSignedOut 带上本页最后见到的 session_id（作废的那个，K6-signout-lib）：auth-js 先删键再通知，回调时本机键多半已经没了，
 *   调用方删不出 session_id，回登录页前按它再删一次（晚到的刷新把旧会话写回时用得上）
 * • SIGNED_OUT 时本机会话还在、而且就是本页认的那个（K6-signout-lib）：删键被 auth-storage.ts 的保护拦下了
 *   （典型是别的标签页退出旧会话时 auth-js 转来的 SIGNED_OUT，本页是刚登录的新会话），不回调、会话保留
 */
export function authEventHandler(
  fn: (userId: string) => void,
  onSignedOut?: (deadSessionId?: string | null) => void,
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
        sid = local;   // 本机已是别的标签页刚登录的新会话：这次 SIGNED_OUT 不归它（K6-sugg4 ④）
        return;
      }
      // 本机会话还在、就是本页认的那个：auth-js 先删键再通知，键还在只说明删除被存储保护拦下了（K6-signout-lib，见上）。忽略
      if (local !== null && local === sid) return;
      onSignedOut(sid);
    } else if (event === 'INITIAL_SESSION' && session === null && sessionGone()) onSignedOut(sid);
  };
}

// ───────── 自己退出的标记（K6-signedout）─────────
// 退出流程（platform/sign-out.ts 的 signOutThisDevice、设置页被移除时的 onSessionLost）一开头调 markSelfSignOut()，
// 之后它自己调 signOut 引起的 SIGNED_OUT 不再按“被移除”处理。
// • 存 localStorage（各标签页共用）：supabase-js 会把本页的 SIGNED_OUT 转给别的标签页，别的标签页见到标记也不按“被移除”提示，
//   那边由 storage 事件（会话变 null）走普通的“别的标签页退出了”
// • 存“时间戳 + 退出前的 session_id”（K6-signedout-sugg ①，JSON `{"at":…,"sid":…}`；不存账号、不存令牌）：
//   只滤掉那个会话的 SIGNED_OUT——退出后马上在别处登录了新会话、新会话随即被移除，照样按“被移除”提示。
//   标记读不出 session_id（旧格式的纯时间戳）时退回只看时间；本页读不出 session_id 时只认这种旧格式的，不认带 sid 的（K6-sugg3 ③）
// • SIGNED_IN 时，新会话不是标记里那个就把标记清掉（forgetSelfSignOut）
// • 另记一份在本页内存里（localStorage 写不进时兜底）
// • 只认 SELF_SIGN_OUT_TTL_MS 以内的：退出流程最坏约 19 秒，过期的标记读到时删掉，不会挡住以后真的被移除

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
 * • sid 为 undefined（调用方不核对会话）：只看时间
 * • 本页的 sid 未知（null：挂监听时已没有会话、令牌坏了，K6-sugg3 ③）：只认同样不知道 session_id 的标记（旧格式纯时间戳等），
 *   带 sid 的新格式标记是某个具体会话的，分不清是不是本页这次，不认（按“被移除”处理）
 * • 本页知道 sid：标记不知道 session_id（旧格式）时只看时间，知道就要相同
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
 * 只在本页内存里打标记，不写 localStorage（审查建议 4）：设置页自己处理“被移除”时用——那是真的被移除，
 * 别的标签页收到转来的 SIGNED_OUT 仍要提示“被移除”
 */
export function markSelfSignOutThisTab(now: number = Date.now(), sessionId: string | null = readSessionId()): void {
  selfMark = { at: now, sid: sessionId };
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
 * 本页见到 SIGNED_IN：登录的不是标记里那个会话（两边都知道 session_id 且不同）就清掉标记（本页内存和 localStorage）。不抛错。
 * 已知边界（接手清单 K6-sugg3 ⑧，只记不改）：A 页自己退出、退出流程还没走完（最坏十几秒）时，别的标签页收到新会话的 SIGNED_IN，
 * 会把 A 打在 localStorage 里的标记清掉（supabase-js 把这次 SIGNED_IN 转给 A 页时，A 页内存里那份也会清）；
 * 之后 A 的 signOut 引起的那次 SIGNED_OUT 就不再被认成“自己退出”，按“被移除”处理、提示。
 * （A 页自己已在退出流程里，boot.switching 挡着；受影响的是收到转来的 SIGNED_OUT 的其他标签页：多一次清库、一句“被移除”提示，
 * 新登录的若是同一个账号，那个新会话也会被 takeLocalSession 删掉，要再登录一次）。
 * 要在一个标签页退出的同时在另一个标签页登录才碰得到，暂不处理
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
 * SW 预缓存的缓存名前缀（Workbox 默认 `workbox-precache-v2-<scope>`；src/sw/sw.ts 没改 cacheNames）。
 * 预缓存只有 App 外壳（HTML、JS、CSS、字体、图标），不含账号数据；sw.ts 将来若改预缓存的名字，这里要一起改
 */
export const PRECACHE_PREFIX = 'workbox-precache';

/**
 * 清 Cache Storage 的运行时缓存（退出登录、换账号、被移除，4.1、0.38 第 36 条）：图片、附件、接口响应等可能带账号数据的缓存全删，
 * SW 预缓存（PRECACHE_PREFIX 开头）保留——删了以后换账号重新载入时如果正好离线，外壳就打不开。不支持时什么也不做，不抛错
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
 * 同步删掉本机的 supabase 会话，**不管是谁的**（K6-sugg4 ② 起改名，名字里写明；退出流程一律用 clearLocalSessionIf / takeLocalSession）。
 * 删 `sb-<ref>-auth-token`、`…-code-verifier` 和 `…-user` 三个键，键名取法同 sessionStorageKey()；
 * supabaseUrl 解析不出来时按格式删所有 `sb-*-auth-token`（及其两个附属键）。
 * `-user`（K6-sugg4 ⑥）：supabase-js 2.118 的 auth-js 在配了 userStorage、或以前配过时把 user 单独存在 `<storageKey>-user`
 * （node_modules/@supabase/auth-js/dist/module/GoTrueClient.js 的 _removeSession 也删它）；本项目没配 userStorage，一般不存在，删了无害。
 * PKCE 的分流程键（`<storageKey>-code-verifier-<flowId>` 一类，lib/helpers.js 的 removeAllPKCEVerifiers）不在这里删：本项目登录走邮箱验证码，不用 PKCE。
 * 不读、不记录令牌内容，不抛错
 */
export function clearAnyLocalSession(storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): void {
  try {
    const s = storage ?? localStorage;
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
      try {
        s.removeItem(k);
        s.removeItem(`${k}-code-verifier`);
        s.removeItem(`${k}-user`);
      } catch {
        // 单个键删不掉：接着删别的
      }
    }
  } catch {
    // 拿不到 localStorage（隐私模式等）：没有可删的
  }
}

/**
 * 拿走本机会话：同步读出 session_id 再删掉（clearAnyLocalSession），返回删之前的 session_id（读不出为 null）。
 * watchAccount 收到本页的 SIGNED_OUT 时用（K6-signedout-sugg2 ①）：和判断“会话里现在是谁”在同一个同步段里做，
 * 之后清库那几秒里别的标签页登录的新会话不会被删（本机会话已经不是本页那个时不会走到这里，见 authEventHandler，K6-sugg4 ④）。
 * 发现“会话被吊销”来自某个请求的回包时不要用它（回包前别的标签页可能已写进新会话）：用发请求前记下的 sid 调 clearLocalSessionIf（K6-sugg4 ①）。
 * 不抛错
 */
export function takeLocalSession(storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): string | null {
  const sid = readSessionId(storage, supabaseUrl);
  clearAnyLocalSession(storage, supabaseUrl);
  return sid;
}

/**
 * 本机会话还是 sessionId 那一个（按 access token 的 session_id 比；没有会话也算对得上，删了无害）才删。
 * sessionId 必填（K6-sugg4 ②）：null 表示“那时本机没有会话 / 读不出”，这时只在本机仍没有会话时删（等于不删别人的）。不抛错
 */
export function clearLocalSessionIf(sessionId: string | null, storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): void {
  if (readSessionId(storage, supabaseUrl) === sessionId) clearAnyLocalSession(storage, supabaseUrl);
}

/**
 * 退出期间 supabase-js 要删 key 时能不能删（supabase/auth-storage.ts 的删键判断，接手清单 K6-signout-lib；sign-out.ts 挂上）：
 * • 不是会话的键（会话键和它的附属键 `<会话键>-…` 以外）：照删
 * • 会话的键：本机没有会话键、或本机会话的 session_id（readSessionId 的口径）还是 sessionId 才删——
 *   别的标签页这时写进来的新会话（session_id 不同）连同它的附属键都留着。sessionId 为 null 时同 clearLocalSessionIf，只认本机仍读不出的
 * 键名取法同 sessionStorageKey()；supabaseUrl 解析不出来时按格式认。不抛错（读不到存储时按能删，和原来的行为一样）
 */
export function mayRemoveSessionKey(key: string, sessionId: string | null, storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): boolean {
  try {
    const main = sessionStorageKey(supabaseUrl);
    const related = main ? key === main || key.startsWith(`${main}-`) : /^sb-.+-auth-token(-.*)?$/.test(key);
    if (!related) return true;
    const s = storage ?? localStorage;
    return findKey(s, supabaseUrl) === null || readSessionId(s, supabaseUrl) === sessionId;
  } catch {
    return true;
  }
}

/**
 * 没登录：去登录页（不建本机库）。带 notice 时先记下退出原因（setExitNotice），登录页据此提示：
 * watchAccount 收到本页的 SIGNED_OUT（不是自己退出）时调 goToAuth('removed', 删掉的那个 session_id)（K6-signedout）。
 * 带 'removed' 时先删本机会话（审查建议 5）：服务器上已经作废，留着登录页会同时显示“当前已登录”和“被移除”。
 * • 带 'removed' 时 deadSessionId 必填（K6-signedout-sugg2 ①、K6-sugg4 ②，类型 GoToAuthArgs 管着）：只在本机会话还是那一个时才删——
 *   清库那几秒里别的标签页刚登录的新会话不删。不再有“不给就直接删”的写法
 * • 已经记下了退出原因（disabled、pending_deletion 等，例如 K8 的 disabled 事件先记的）时，不拿 removed 覆盖（K6-signedout-sugg ⑤）
 */
export function goToAuth(...args: GoToAuthArgs): void {
  const [notice] = args;
  if (args[0] === 'removed') clearLocalSessionIf(args[1]);
  if (notice && !(notice === 'removed' && readExitNotice() !== null)) setExitNotice(notice);
  location.replace('/app/auth/');
}

/** goToAuth 的参数：不带原因；带 disabled / pending_deletion；带 removed 时必须给删掉的那个 session_id（K6-sugg4 ②） */
export type GoToAuthArgs = [] | [notice: Exclude<ExitNotice, 'removed'>] | [notice: 'removed', deadSessionId: string | null];

// ───────── 退出原因：搬到 platform/exit-notice.ts（10-30，session.ts 回到 300 行以内）；这里原样转出，原有的 import 不用改 ─────────
export {
  clearExitNotice, EXIT_NOTICE_TTL_MS, exitNoticeOf, isExitNotice, readExitNotice, setExitNotice, type ExitNotice,
} from './exit-notice.ts';
