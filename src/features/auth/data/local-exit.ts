// 登录页上“退出并换账号”的本机一半（架构 4.1、0.38 第 35 条）
// • clearLocalSession：服务器退出不是 ok 时（断网、令牌过期、超时、客户端拿不到）兜底删本机会话，确保本机不再算“已登录”。
//   用 platform/session.ts 的 clearLocalSession（K6：按 supabaseUrl 算键名，code-verifier 一起删）
// • 本机库：直接删掉整个 IndexedDB 库 planner-v4（和 core/boot 的 wipeLocal 一样是全清，drafts 也清）。
//   不 import core/cache.ts：它经 manifests 带进 zod，zod 4 的 allowsEval 探测在登录页的严格 CSP 下会报 eval 违规（K4 第三轮复审）。
//   库名和 core/cache.ts 的 DB_NAME 必须一致，local-exit.test.ts 守着
// • 别的标签页开着主 App 时：删库会先触发它的 onversionchange（core/cache.ts 写好草稿再关库），关了才真正删掉；
//   最多等 DELETE_WAIT_MS，等不到也往下走（删库请求留在浏览器里，那边一关就删）
// • Cache Storage：platform/session.ts 的 clearCacheStorage（和设置页退出同一个）
// • localStorage 里的 install_id、pv-locale 不清（同设置页的退出，K9 data/local.ts）
import { clearCacheStorage, clearLocalSession } from '../../../platform/session.ts';

/** 本机库名（= core/cache.ts 的 DB_NAME） */
export const LOCAL_DB_NAME = 'planner-v4';

/** 删库最多等多久（毫秒） */
export const DELETE_WAIT_MS = 3000;

const SESSION_KEY_RE = /^sb-.+-auth-token$/;

export type DeleteDbResult = 'deleted' | 'blocked' | 'error' | 'unavailable';

/** 删掉本机库；永远 resolve */
export function deleteLocalDb(
  factory: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB,
  name: string = LOCAL_DB_NAME,
  waitMs: number = DELETE_WAIT_MS,
): Promise<DeleteDbResult> {
  if (!factory) return Promise.resolve('unavailable');
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: DeleteDbResult) => {
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
      // blocked：别的标签页还没关库，继续等 onsuccess，到时还没删完就按 blocked 往下走
    } catch {
      finish('error');
    }
  });
}

/** 本机存着的 access token（只读 localStorage，不联网、不加载 supabase-js）；找本会话那一行 devices 用，没有为 null */
export function readStoredAccessToken(storage?: Storage): string | null {
  try {
    const s = storage ?? localStorage;
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || !SESSION_KEY_RE.test(k)) continue;
      const o = JSON.parse(s.getItem(k) ?? 'null') as { access_token?: unknown } | null;
      if (typeof o?.access_token === 'string' && o.access_token) return o.access_token;
    }
  } catch {
    // 同上
  }
  return null;
}

export interface LocalExitDeps {
  /** 服务器退出不是 ok 时兜底删本机会话 */
  clearLocalSession(): void;
  deleteDb(): Promise<DeleteDbResult>;
  clearCacheStorage(): Promise<void>;
}

export const defaultLocalExitDeps: LocalExitDeps = {
  clearLocalSession: () => clearLocalSession(),
  deleteDb: () => deleteLocalDb(),
  clearCacheStorage,
};

/** 清本机库和运行时缓存；某一步失败不挡后面的步骤 */
export async function wipeLocal(deps: LocalExitDeps = defaultLocalExitDeps): Promise<void> {
  try {
    await deps.deleteDb();
  } catch {
    // 库打不开：Cache Storage 照样清
  }
  try {
    await deps.clearCacheStorage();
  } catch {
    // 同上
  }
}
