// 本机会话的轻量读取（架构 4.1 第 0.38 第 17 条、2.6 首屏不加载 supabase-js）
// • 启动时不加载 supabase-js，直接读它存在 localStorage 里的会话，拿当前 user_id（离线也能读）
// • 键名和 supabase-js 的默认值一致：`sb-<supabaseUrl 主机名第一段>-auth-token`（官网首页、E2E 也按这个名字找）
// • 换账号的判断时机里，“别的标签页”走 storage 事件（onSessionStorageChange），“登录 / 刷新令牌”走 onAuthStateChange（onAuthUser）
// • 本标签页的 SIGNED_OUT（刷新失败、被移除、被退出）也走这同一个 onAuthStateChange（onAuthUser 的第二个回调，接手清单 K6-signedout）；
//   自己点“退出登录”的那一次由退出流程先 markSelfSignOut()，这里见到标记就不往上报（K8、各功能页不各自监听 SIGNED_OUT）
// • Cache Storage 的清理也在这里（caches 只在 platform 用）：只删运行时缓存，SW 预缓存保留（0.38 第 36 条）
// • clearLocalSession：signOut 失败时的兜底，同步删掉本机的 supabase 会话键
// 只读 user.id、user.email 和令牌 payload 里的 session_id（sessionIdOfToken），不校验、不记录、不打印令牌
import { buildInfo } from './env.ts';
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

/** 本机会话 access token 里的 session_id（键名取法同 readSessionUserId，同步读、离线也能读）；没登录、读不到、格式不对都返回 null */
export function readSessionId(storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): string | null {
  try {
    const s = storage ?? localStorage;
    const key = findKey(s, supabaseUrl);
    const raw = key ? s.getItem(key) : null;
    if (!raw) return null;
    const o = JSON.parse(raw) as { access_token?: unknown } | null;
    return sessionIdOfToken(o?.access_token);
  } catch {
    return null;
  }
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
 * 全 App 只有这一处订阅 onAuthStateChange（K6-signedout）。
 * • 订阅在客户端一建好时就同步挂上（supabase/client.ts 的 onClientReady，审查 M1）：谁先 getSupabase()（同步的 ensureSession 往往更早）都一样，
 *   initialize 里刷新被拒发的 SIGNED_OUT 一定收得到
 * • 没人用 supabase-js 时，等首屏画完、浏览器空闲才加载它（whenIdle，K6 审查 L6）。返回取消函数
 */
export function onAuthUser(fn: (userId: string) => void, onSignedOut?: () => void): () => void {
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

/**
 * onAuthStateChange 的事件分发（单独导出给测试；不加载 supabase-js）。
 * INITIAL_SESSION 为 null 也当 SIGNED_OUT（审查 M1：订阅晚于 initialize 时只收得到它），但要本机会话键已经没了（sessionGone）：
 * 离线冷启动、令牌又过期时 supabase-js 也给 INITIAL_SESSION null，那时会话键还在，不能当成被移除去清库（会丢没上传的改动）
 */
export function authEventHandler(
  fn: (userId: string) => void,
  onSignedOut?: () => void,
  selfSignOut: () => boolean = () => isSelfSignOut(),
  sessionGone: () => boolean = () => readSessionUserId() === null,
): (event: string, session: { user: { id: string } } | null) => void {
  return (event, session) => {
    if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session?.user.id) fn(session.user.id);
    else if (!onSignedOut || selfSignOut()) return;
    else if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && session === null && sessionGone())) onSignedOut();
  };
}

// ───────── 自己退出的标记（K6-signedout）─────────
// 退出流程（platform/sign-out.ts 的 signOutThisDevice、设置页被移除时的 onSessionLost）一开头调 markSelfSignOut()，
// 之后它自己调 signOut 引起的 SIGNED_OUT 不再按“被移除”处理。
// • 存 localStorage（各标签页共用）：supabase-js 会把本页的 SIGNED_OUT 转给别的标签页，别的标签页见到标记也不按“被移除”提示，
//   那边由 storage 事件（会话变 null）走普通的“别的标签页退出了”。只存时间戳，不存账号
// • 另记一份在本页内存里（localStorage 写不进时兜底）
// • 只认 SELF_SIGN_OUT_TTL_MS 以内的：退出流程最坏约 19 秒，过期的标记读到时删掉，不会挡住以后真的被移除

const SELF_SIGN_OUT_KEY = 'lemo.self_signout';
/** 标记的有效期 */
export const SELF_SIGN_OUT_TTL_MS = 60_000;
let selfSignOutAt: number | null = null;

function fresh(at: number, now: number): boolean {
  return Number.isFinite(at) && now - at >= 0 && now - at < SELF_SIGN_OUT_TTL_MS;
}

/** 自己退出：在调 signOut（以及任何可能引起 SIGNED_OUT 的请求）之前调。不抛错 */
export function markSelfSignOut(storage?: Storage, now: number = Date.now()): void {
  selfSignOutAt = now;
  try {
    (storage ?? localStorage).setItem(SELF_SIGN_OUT_KEY, String(now));
  } catch {
    // 写不进：本页内存里那份照样管用
  }
}

/**
 * 只在本页内存里打标记，不写 localStorage（审查建议 4）：设置页自己处理“被移除”时用——那是真的被移除，
 * 别的标签页收到转来的 SIGNED_OUT 仍要提示“被移除”
 */
export function markSelfSignOutThisTab(now: number = Date.now()): void {
  selfSignOutAt = now;
}

/** 最近 SELF_SIGN_OUT_TTL_MS 内有没有自己退出（本页或别的标签页打的标记）；过期的顺手删掉 */
export function isSelfSignOut(storage?: Storage, now: number = Date.now()): boolean {
  if (selfSignOutAt !== null && fresh(selfSignOutAt, now)) return true;
  try {
    const s = storage ?? localStorage;
    const v = s.getItem(SELF_SIGN_OUT_KEY);
    if (v === null) return false;
    if (fresh(Number(v), now)) return true;
    s.removeItem(SELF_SIGN_OUT_KEY);
  } catch {
    // 读不到：按没有标记
  }
  return false;
}

/** 测试用：清掉本页内存里那份标记 */
export function resetSelfSignOutForTest(): void {
  selfSignOutAt = null;
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
 * 同步删掉本机的 supabase 会话（signOut 的兜底：断网、令牌过期、supabase-js 分包加载失败时，保证本机不留会话）。
 * 删 `sb-<ref>-auth-token` 和 `sb-<ref>-auth-token-code-verifier` 两个键，键名取法同 sessionStorageKey()；
 * supabaseUrl 解析不出来时按格式删所有 `sb-*-auth-token`（及其 code-verifier）。不读、不记录令牌内容，不抛错
 */
export function clearLocalSession(storage?: Storage, supabaseUrl: string = buildInfo.supabaseUrl): void {
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
      } catch {
        // 单个键删不掉：接着删别的
      }
    }
  } catch {
    // 拿不到 localStorage（隐私模式等）：没有可删的
  }
}

/**
 * 没登录：去登录页（不建本机库）。带 notice 时先记下退出原因（setExitNotice），登录页据此提示：
 * watchAccount 收到本页的 SIGNED_OUT（不是自己退出）时调 goToAuth('removed')（K6-signedout）。
 * 带 'removed' 时先删本机会话（审查建议 5）：服务器上已经作废，留着登录页会同时显示“当前已登录”和“被移除”
 */
export function goToAuth(notice?: ExitNotice): void {
  if (notice === 'removed') clearLocalSession();
  if (notice) setExitNotice(notice);
  location.replace('/app/auth/');
}

// ───────── 退出原因（K6 复审 A：被移除、被停用、注销冷静期清本机后回登录页，登录页据此提示）─────────
// 存在本标签页的 sessionStorage（goToAuth 是同一个标签页跳转，跳过去还在）；只存原因，不存账号、邮箱等任何个人信息

/** removed：会话被吊销（session_revoked）；disabled：账号被管理员停用（account_disabled）；pending_deletion：注销冷静期（account_pending_deletion，R-192） */
export type ExitNotice = 'removed' | 'disabled' | 'pending_deletion';

const EXIT_NOTICE_KEY = 'lemo.exit_notice';
const EXIT_NOTICES: readonly ExitNotice[] = ['removed', 'disabled', 'pending_deletion'];

/** 按服务器的错误码定退出原因（不认识的一律算 removed） */
export function exitNoticeOf(code: string): ExitNotice {
  if (code === 'account_disabled') return 'disabled';
  if (code === 'account_pending_deletion') return 'pending_deletion';
  return 'removed';
}

export function setExitNotice(n: ExitNotice, storage?: Storage): void {
  try {
    (storage ?? sessionStorage).setItem(EXIT_NOTICE_KEY, n);
  } catch {
    // 拿不到 sessionStorage：登录页就不提示原因
  }
}

/** 登录页读（不删；渲染里读，StrictMode 调两次也一样）；值不认识按没有处理 */
export function readExitNotice(storage?: Storage): ExitNotice | null {
  try {
    const v = (storage ?? sessionStorage).getItem(EXIT_NOTICE_KEY);
    return EXIT_NOTICES.find((n) => n === v) ?? null;
  } catch {
    return null;
  }
}

/** 登录页显示过以后删掉（effect 里调），刷新登录页不再提示 */
export function clearExitNotice(storage?: Storage): void {
  try {
    (storage ?? sessionStorage).removeItem(EXIT_NOTICE_KEY);
  } catch {
    // 同上
  }
}
