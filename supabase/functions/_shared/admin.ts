// 服务器函数的 service role 客户端只在这里建（代码结构审查 11-25 第 4 条：原来 25 个 index.ts 各抄一份读环境变量 + createClient）。
// 不变量：只读 SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（平台注入）；supabase-js 一律经 timedFetch（tests/edge/shared-net.test.ts 守）；
//   不引 db.ts（F2 按角色连坐，这里和直连库无关）。超时按函数传：默认 STORE_TIMEOUT_MS，account 20 秒、account-purge 30 秒各自传。
// 两种用法：
//   serviceAdmin(log)：缺配置记 misconfigured、给 500 响应——index.ts 里 `if (admin instanceof Response) return admin;`；
//   serviceAdminOrNull()：缺配置返回 null，鉴权之后再由 core.ts 回 misconfigured（没带对密钥的调用方看不出配没配）。
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import { json } from './http.ts';
import { timedFetch } from './net.ts';
import { STORE_TIMEOUT_MS } from './store-timeout.ts';

/** 配齐了返回客户端；缺 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 返回 null */
export function serviceAdminOrNull(timeoutMs: number = STORE_TIMEOUT_MS): SupabaseClient | null {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: timedFetch(fetch, timeoutMs) } });
}

/** 缺配置：记 misconfigured，返回 500 响应（调用方原样返回） */
export function serviceAdmin(log: (code: string) => void, timeoutMs: number = STORE_TIMEOUT_MS): SupabaseClient | Response {
  const admin = serviceAdminOrNull(timeoutMs);
  if (admin) return admin;
  log('misconfigured');
  return json(500, { error: 'misconfigured' });
}
