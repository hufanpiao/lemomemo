// supabase-js 错误归类共用的一份：断网正则、会话失效码表只在这里，各功能只补自己特有的码
// • errParts：各种 supabase 错误、抛出的异常 → 读得出的四项（不是对象为 null）
// • 会话失效码分两组，口径有意不同：
//   - SESSION_GONE_CODES：会话已不在，各处都要查服务器（session_fate）再定被移除还是登录过期
//   - REFRESH_DEAD_CODES：同步一路按登录过期（只退出）；设置页、告知页按“被移除”交给 exitDevice（同样先查服务器才清库）
// 纯 TS，只引 shared 的读列小工具
import { str } from '../../../shared/core/field.ts';

export interface ErrParts {
  code: string;
  msg: string;
  name: string;
  /** HTTP 状态；没有为 -1 */
  status: number;
}

export function errParts(e: unknown): ErrParts | null {
  if (typeof e !== 'object' || e === null) return null;
  const x = e as Record<string, unknown>;
  return { code: str(x['code']), msg: str(x['message']), name: str(x['name']), status: typeof x['status'] === 'number' ? x['status'] : -1 };
}

/** fetch 本身失败（断网、DNS、被拦、超时中止）的几种说法：Chrome、Safari、Firefox、AbortSignal.timeout */
export const FETCH_FAILED = /failed to fetch|load failed|networkerror|network request failed|network error|fetcherror|aborterror|timeout/i;

/** 会话已不在（刷新令牌回的码，code 或 message 里含） */
export const SESSION_GONE_CODES: readonly string[] = ['session_not_found', 'refresh_token_not_found'];
/** 刷新令牌已失效的另两种（见文件头） */
export const REFRESH_DEAD_CODES: readonly string[] = ['refresh_token_already_used', 'session_expired'];

/**
 * 设置页、告知页的请求：会话已被吊销或不在了（交给“被移除”，exitDevice 先查服务器）。
 * PostgREST 把 raise exception 'session_revoked' 变成 400 + message；401 一律当没登录
 */
export function isRevokedErr(p: ErrParts): boolean {
  if (/\bsession_revoked\b|\bunauthorized\b/.test(p.msg) || p.code === 'session_revoked' || p.code === 'unauthorized') return true;
  return SESSION_GONE_CODES.includes(p.code) || REFRESH_DEAD_CODES.includes(p.code) || p.status === 401;
}
/** 服务器忙（503 try_later） */
export function isTryLaterErr(p: ErrParts): boolean {
  return /\btry_later\b/.test(p.msg) || p.code === 'try_later' || p.status === 503;
}

/** 没连上服务器：supabase-js 的可重试 fetch 错误、状态 0、fetch 本身失败的原文 */
export function isOfflineErr(p: ErrParts): boolean {
  return p.name === 'AuthRetryableFetchError' || p.status === 0 || FETCH_FAILED.test(p.msg);
}
