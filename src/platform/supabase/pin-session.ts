// 把这次请求用的令牌定死：同步传输层发请求前读出会话、显式设 Authorization，失败时带回它的 session_id；
// supabase-js 的 fetchWithAuth 见到请求已带 Authorization 就不再换成它自己读到的令牌
import type { SupabaseClient } from '@supabase/supabase-js';
import { sessionIdOfToken } from '../session.ts';

/**
 * 这次请求用哪个会话的令牌：失败时把它的 session_id 带回（SendFailure.sid），send.ts 按真正发出去的那个会话删，
 * 没有“读 sid 到带上令牌”之间的间隙。读不了会话返回 undefined：不设、不带
 */
export async function pinSession(db: Pick<SupabaseClient, 'auth'>): Promise<{ token: string | null; sid: string | null } | undefined> {
  try {
    const { data } = await db.auth.getSession();
    const token = data.session?.access_token ?? null;
    return { token, sid: token ? sessionIdOfToken(token) : null };
  } catch {
    return undefined;
  }
}

/** 给 PostgREST 的请求定死令牌；builder 没有 setHeader（测试的假客户端）时返回 false */
export function pinAuth(b: PromiseLike<unknown>, token: string): boolean {
  const set = (b as { setHeader?: (name: string, value: string) => unknown }).setHeader;
  if (typeof set !== 'function') return false;
  set.call(b, 'Authorization', `Bearer ${token}`);
  return true;
}
