// supabase-js 会话用的存储：包了一层的 localStorage，不改成直接调 /logout
// • getItem / setItem 直接透传，键名不变；写的是真 localStorage，别的标签页照样收到 storage 事件
// • removeItem 平时也透传；只有退出流程挂上 guardSessionRemoval 的那段时间里，删键前先问 mayRemove(key)，答“不能删”就不删
// • 原因：auth-js 的 _signOut 拿本机会话的令牌调 /logout，最后无条件删会话键（不加锁）；那几秒里别的标签页登录的新会话会被本页删掉
// • localStorage 用不了时返回 undefined，auth-js 退回它自己的内存存储
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

/** 退出期间这个键能不能删（没挂判断时一律能删；判断出错按能删）。exe 的会话存储（session-store.ts）删键前也问它 */
export function removalAllowed(key: string, now: number = Date.now()): boolean {
  const g = current(now);
  if (!g) return true;
  try {
    return g.mayRemove(key);
  } catch {
    return true;
  }
}

/** 包了 localStorage 的适配器：每次调用时才取 globalThis.localStorage */
export const guardedLocalStorage: AuthStorage = {
  getItem: (key) => globalThis.localStorage.getItem(key),
  setItem: (key, value) => {
    globalThis.localStorage.setItem(key, value);
  },
  removeItem: (key) => {
    if (!removalAllowed(key)) return;
    globalThis.localStorage.removeItem(key);
  },
};

/** 给 clientOptions 用：localStorage 能写才返回适配器，否则 undefined。探测方法同 auth-js 的 supportsLocalStorage */
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
