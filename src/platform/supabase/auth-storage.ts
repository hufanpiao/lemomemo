// supabase-js 会话用的存储（接手清单 K6-signout-lib，架构师 10-30 结论：不改成直接调 /logout，加一个低成本的存储保护）
// • 就是包了一层的 localStorage：getItem / setItem 直接透传，键名不变（还是 supabase-js 默认的 sb-<ref>-auth-token），
//   写的是真 localStorage，别的标签页照样收到 storage 事件（session.ts 的 onSessionStorageChange、core/account.ts 的 watchAccount 不受影响）
// • 平时 removeItem 也直接透传；只有退出流程（platform/sign-out.ts 的 signOutThisDevice）挂上 guardSessionRemoval 的那段时间里，
//   删键前先问一句 mayRemove(key)，答“不能删”就不删（判断写在 session.ts 的 mayRemoveSessionKey，按 readSessionId 的口径核对 session_id）
// • 原因：auth-js 2.118 的 _signOut 先读本机会话、拿它的令牌调 /logout，最后 _removeSession 无条件删会话键（默认不加锁）；
//   那几秒里别的标签页登录的新会话会被本页删掉
// • 浏览器里 localStorage 用不了（隐私模式写不进等）时不给适配器（返回 undefined），auth-js 照旧退回它自己的内存存储
// 这个文件不 import 任何东西：session.ts 引 supabase/client.ts，client.ts 引这里，不能再绕回 session.ts

/** 退出期间的删键判断：返回 false 就不删 */
export type RemoveGuard = (key: string) => boolean;

interface ActiveGuard {
  mayRemove: RemoveGuard;
  until: number;
}

let active: ActiveGuard | null = null;

/** 当前有效的判断；过期的顺手清掉 */
function current(now: number): ActiveGuard | null {
  if (active && now >= active.until) active = null;
  return active;
}

/**
 * 挂上删键判断，返回撤掉它的函数（只撤自己挂的那一个；后挂的顶替先挂的）。
 * ttlMs 是上限：调用方忘了撤、或请求一直不回来，到点也自动失效，不会一直挡着以后的删除
 */
export function guardSessionRemoval(mayRemove: RemoveGuard, ttlMs: number, now: number = Date.now()): () => void {
  const g: ActiveGuard = { mayRemove, until: now + ttlMs };
  active = g;
  return () => {
    if (active === g) active = null;
  };
}

/** 测试用：现在有没有挂着判断 */
export function isRemovalGuarded(now: number = Date.now()): boolean {
  return current(now) !== null;
}

/** auth-js 的 storage 选项（SupportedStorage 的同步写法） */
export interface AuthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 包了 localStorage 的适配器：每次调用时才取 globalThis.localStorage */
export const guardedLocalStorage: AuthStorage = {
  getItem: (key) => globalThis.localStorage.getItem(key),
  setItem: (key, value) => {
    globalThis.localStorage.setItem(key, value);
  },
  removeItem: (key) => {
    const g = current(Date.now());
    if (g) {
      let ok = true;
      try {
        ok = g.mayRemove(key);
      } catch {
        // 判断本身出错：按原来的行为删
      }
      if (!ok) return;
    }
    globalThis.localStorage.removeItem(key);
  },
};

/**
 * 给 clientOptions 用：浏览器里 localStorage 能写才返回适配器，否则 undefined（auth-js 退回内存存储，和不传 storage 时一样）。
 * 探测方法同 auth-js 的 supportsLocalStorage（写一个随机键再删掉）
 */
export function authStorage(): AuthStorage | undefined {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const s = globalThis.localStorage;
    if (typeof s !== 'object' || s === null) return undefined;
    const k = `lemo-lswt-${Math.random()}`;
    s.setItem(k, k);
    s.removeItem(k);
    return guardedLocalStorage;
  } catch {
    return undefined;
  }
}
