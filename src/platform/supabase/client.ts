// Supabase 客户端（架构 2.5、0.27 第 1 点、2.6）
// - createClient<Database>()：表名、列名有类型
// - global.headers 带 X-App-Version：REST、Storage、Functions 都会带上；转发层按它挡旧版本的写入
// - supabase-js 约 40 KB，不进首屏：调用 getSupabase() 时才动态 import（先用 IndexedDB 画出上次的内容）
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildInfo } from '../../app/build-info.ts';
import { APP_VERSION_HEADER, appFetch } from '../http.ts';
import type { Database } from './database.ts';

export type Db = SupabaseClient<Database>;

let pending: Promise<Db> | null = null;

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
      return createClient<Database>(buildInfo.supabaseUrl, buildInfo.anonKey, clientOptions());
    });
  }
  return pending;
}
