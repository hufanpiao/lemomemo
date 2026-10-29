// Supabase 客户端（架构 2.5、0.27 第 1 点、2.6）
// - createClient<Database>()：表名、列名有类型
// - global.headers 带 X-App-Version：REST、Storage、Functions 都会带上；转发层按它挡旧版本的写入
// - supabase-js 约 40 KB，不进首屏：调用 getSupabase() 时才动态 import（先用 IndexedDB 画出上次的内容）
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildInfo } from '../env.ts';
import { APP_VERSION_HEADER, appFetch } from '../http.ts';
import type { Database } from './database.ts';

export type Db = SupabaseClient<Database>;

let pending: Promise<Db> | null = null;
let created: Db | null = null;
const readyFns = new Set<(db: Db) => void>();

/**
 * 客户端一建好就同步回调（K6-signedout 审查 M1）：createClient 一调就开始 initialize → _recoverAndRefresh，
 * 刷新被拒时发的 SIGNED_OUT 只给 initialize 结束时已挂上的订阅者。在这里挂 onAuthStateChange，比任何 await 都早，一定收得到。
 * 已经建好时当场回调。不触发加载（加载仍由 getSupabase 决定）。返回取消函数（只取消还没回调的）
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
  return {
    global: {
      headers: { [APP_VERSION_HEADER]: version },
      fetch: appFetch,
    },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
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
