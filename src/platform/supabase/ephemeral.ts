// 不保存会话的一次性 supabase 客户端（B5 S3；架构 0.29 续第 104 条 ①）：重新验证邮箱时发验证码、verifyOtp 拿新会话 S2 用
// • persistSession: false、autoRefreshToken: false：S2 只在这个对象的内存里，不写 localStorage / 凭据管理器，交接成功后才由
//   主客户端 setSession(S2) 换上；交接失败时 signOut({scope: 'local'}) 丢掉（TC-B1-86：S2 从没写进本机存储）
// • storageKey 换一个名字：和主客户端（同一个 URL）同时存在时 auth-js 不会认成同一份存储、互相广播
// • 和主客户端一样带 X-App-Version、经 appFetch
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildInfo } from '../env.ts';
import { APP_VERSION_HEADER, appFetch } from '../http.ts';
import type { Database } from './database.ts';

export type EphemeralDb = SupabaseClient<Database>;

export function ephemeralOptions(version: string = buildInfo.version) {
  return {
    global: { headers: { [APP_VERSION_HEADER]: version }, fetch: appFetch },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'lemo-reverify' },
  } as const;
}

export async function createEphemeralDb(): Promise<EphemeralDb> {
  const { createClient } = await import('@supabase/supabase-js');
  if (!buildInfo.supabaseUrl || !buildInfo.anonKey) throw new Error('supabase_env_missing');
  return createClient<Database>(buildInfo.supabaseUrl, buildInfo.anonKey, ephemeralOptions());
}
