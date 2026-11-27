// Supabase 客户端
// - global.headers 带 X-App-Version：REST、Storage、Functions 都会带上；转发层按它挡旧版本的写入
// - supabase-js 约 40 KB，不进首屏：调用 getSupabase() 时才动态 import
// - auth.storage 是 auth-storage.ts 的适配器（退出期间删会话键前先核对）；localStorage 用不了时不传
// - global.fetch 外面包一层刷新观察（refresh-observer.ts）：只记刷新令牌失败的码，Response 原样交回
// - exe 里换成 session-store.ts 的 authBackendStorage：先由入口 await installDesktopSession()
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildInfo } from '../env.ts';
import { APP_VERSION_HEADER, appFetch } from '../http.ts';
import { authBackendStorage } from '../session-store.ts';
import { authStorage } from './auth-storage.ts';
import { observeRefresh } from './refresh-observer.ts';
import type { Database } from './database.ts';

export type Db = SupabaseClient<Database>;

let pending: Promise<Db> | null = null;
let created: Db | null = null;
const readyFns = new Set<(db: Db) => void>();

/**
 * 客户端一建好就同步回调：createClient 一调就开始 initialize，刷新被拒时的 SIGNED_OUT 只给那时已挂上的订阅者，
 * 在这里挂 onAuthStateChange 比任何 await 都早，一定收得到。已建好时当场回调；不触发加载。返回取消函数
 */
export function onClientReady(fn: (db: Db) => void): () => void {
  if (created) {
    fn(created);
    return () => undefined;
  }
  readyFns.add(fn);
  return () => {
    readyFns.delete(fn);
  };
}

/** 建客户端时的选项（单独导出给测试核对） */
export function clientOptions(version: string = buildInfo.version) {
  // exe：会话存进凭据管理器，不落 WebView2 的 localStorage
  const storage = authBackendStorage() ?? authStorage();
  return {
    global: {
      headers: { [APP_VERSION_HEADER]: version },
      fetch: observeRefresh(appFetch),
    },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      ...(storage ? { storage } : {}),
    },
  } as const;
}

/** 懒加载的单例客户端 */
export function getSupabase(): Promise<Db> {
  if (!pending) {
    pending = import('@supabase/supabase-js').then(({ createClient }) => {
      if (!buildInfo.supabaseUrl || !buildInfo.anonKey) throw new Error('supabase_env_missing');
      const db = createClient<Database>(buildInfo.supabaseUrl, buildInfo.anonKey, clientOptions());
      created = db;
      const fns = [...readyFns];
      readyFns.clear();
      for (const f of fns) {
        try {
          f(db);
        } catch {
          // 一个回调出错不挡别的，也不挡客户端
        }
      }
      return db;
    });
  }
  return pending;
}
