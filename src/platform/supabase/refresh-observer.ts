// 刷新令牌的观察（架构 4.1a 第 1 点 ①；R-382）：supabase-js 自己发的 SIGNED_OUT 不带原因，这里在 createClient 的 global.fetch 外面包一层，
// 只记“刷新令牌”那一个请求的结局，SIGNED_OUT 时交给 core/auth-loss.ts 分类
// • 只看 POST …/auth/v1/token?grant_type=refresh_token；别的请求原样放过、不读、不记
// • 回 2xx：清掉记录，回包一个字节也不读（里面有新令牌）
// • 回非 2xx：clone() 一份读 JSON 的 error_code（没有就读 code），只收 AUTH_CODE_RE 格式的码，和状态码、时刻、sid 一起记进内存 lastRefreshFailure；
//   读不出 JSON（或码不合格式）记 'unparsable'
// • fetch 本身抛错（断网、超时）记 'network'（状态 0），错误原样抛出
// • 边界（0.59 安全审建议）：不读、不解析请求体（里面有 refresh token）；sid 取本机当前会话的 session_id（setRefreshSessionReader，
//   由 platform/session.ts 挂上），不从请求或回包里取；原来那个 Response 原样交回 supabase-js，不改状态码、头和正文，读 clone 出错也不影响交回
// • 原文、令牌、URL 一律不进记录；只在内存（不落盘）
// • 钉住的 supabase-js 版本：@supabase/auth-js 2.x 的 _refreshAccessToken 发 POST `${url}/token?grant_type=refresh_token`。
//   升级 supabase-js 时必须过 refresh-observer 这一组单测（4.1a 第 7 点）
import { AUTH_CODE_RE, noteRefresh, refreshSidNow } from './refresh-failure.ts';

export {
  REFRESH_FAILURE_WINDOW_MS, recentRefreshFailure, resetRefreshObserverForTest, setRefreshSessionReader, type RefreshFailure,
} from './refresh-failure.ts';

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** 是不是刷新令牌的请求：POST、路径以 /auth/v1/token 结尾、grant_type=refresh_token。只看方法和地址，不碰请求体 */
export function isRefreshRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  try {
    const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
    if (method !== 'POST') return false;
    const u = new URL(urlOf(input), 'http://x');
    return u.pathname.endsWith('/auth/v1/token') && u.searchParams.get('grant_type') === 'refresh_token';
  } catch {
    return false;
  }
}

/** 非 2xx 回包的 clone 里的错误码：error_code，没有就 code；只收白名单格式，否则 'unparsable' */
async function codeOf(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as Record<string, unknown> | null;
    const c = body?.['error_code'] ?? body?.['code'];
    return typeof c === 'string' && AUTH_CODE_RE.test(c) ? c : 'unparsable';
  } catch {
    return 'unparsable';
  }
}

/** 包一层：刷新请求按结局记下或清掉记录，其余原样 */
export function observeRefresh(inner: typeof fetch, now: () => number = () => Date.now()): typeof fetch {
  return async (input, init) => {
    if (!isRefreshRequest(input, init)) return inner(input, init);
    const sid = refreshSidNow();
    let res: Response;
    try {
      res = await inner(input, init);
    } catch (e) {
      noteRefresh({ code: 'network', status: 0, at: now(), sid });
      throw e;
    }
    noteRefresh(res.ok ? null : { code: await codeOf(res), status: res.status, at: now(), sid });
    return res;
  };
}

