// 调 RPC files_authorize（架构 3.3 G“R2 起”、14.2 第 11 点）：把用户的 JWT 原样带去，PostgREST 验签，SQL 判断能不能传、能不能看。
// Pages 里不放 Supabase 的 JWT 密钥和 service key（0.32 第 3 条），所以这里不自己验 JWT。
//
// 接口（和后端 BE-2 对的；改动要两边同意、同一个 PR 改架构）：
//   POST <SUPABASE_UPSTREAM>/rest/v1/rpc/files_authorize   apikey: anon；Authorization: 用户的 Bearer
//   请求 {p_op: 'put' | 'get', p_items: [{bucket, path}]}（put 只许 1 项，get 最多 100 项）
//   成功 200 {uid, items: [{i, ok, reason?}]}，i 是 p_items 的下标（从 0 起）
//   整批不过：200 {uid, error: 'account_disabled' | 'session_revoked' | 'rate_limited', items: []}（后端 0004 的写法），
//     或者 raise 成 PostgREST 的错误（4xx，{code, message}），message 就是这几个错误码之一——两种都认
//   入参不对：raise 22023（message 是 bad_op、bad_items、put_one_item、too_many_items）→ 400 bad_path
//   JWT 无效或过期：PostgREST 回 401
// 2 秒超时回 503 try_later（14.2 第 11 点）；没过授权的请求一律不碰 R2。

export type AuthzOp = 'put' | 'get';

export interface AuthzItem {
  bucket: string;
  path: string;
}

export interface AuthzItemResult {
  i: number;
  ok: boolean;
  reason: string | null;
}

export type AuthzResult =
  | { kind: 'ok'; uid: string; items: AuthzItemResult[] }
  | { kind: 'error'; status: number; code: string; reason?: string; log: string };

export interface AuthzConfig {
  upstream: string;
  anonKey: string;
  fetch: (req: Request) => Promise<Response>;
  timeoutMs?: number;
}

const CODE_RE = /^[a-z_]{1,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// HTTP 映射按后端 BE-2 的建议（10-28）：account_disabled → 403 forbidden；session_revoked → 401 unauthorized（带 reason，
// src/platform/files.ts 按 reason 交给会话处理）；rate_limited → 429；入参不对（22023）→ 400 bad_path
function batchError(code: string, log: string): AuthzResult {
  if (code === 'rate_limited') return { kind: 'error', status: 429, code: 'rate_limited', log };
  if (code === 'unauthorized') return { kind: 'error', status: 401, code: 'unauthorized', log };
  if (code === 'session_revoked') return { kind: 'error', status: 401, code: 'unauthorized', reason: code, log };
  return { kind: 'error', status: 403, code: 'forbidden', reason: code, log };
}

function parseOk(body: unknown, n: number): AuthzResult | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  if (typeof o.error === 'string') return CODE_RE.test(o.error) ? batchError(o.error, 'authz_batch_denied') : null;
  if (typeof o.uid !== 'string' || !UUID_RE.test(o.uid) || !Array.isArray(o.items) || o.items.length !== n) return null;
  const seen = new Set<number>();
  const items: AuthzItemResult[] = [];
  for (const raw of o.items as unknown[]) {
    if (!raw || typeof raw !== 'object') return null;
    const it = raw as Record<string, unknown>;
    if (typeof it.i !== 'number' || !Number.isInteger(it.i) || it.i < 0 || it.i >= n || seen.has(it.i) || typeof it.ok !== 'boolean') return null;
    seen.add(it.i);
    const reason = typeof it.reason === 'string' && CODE_RE.test(it.reason) ? it.reason : it.ok ? null : 'denied';
    items.push({ i: it.i, ok: it.ok, reason });
  }
  return { kind: 'ok', uid: o.uid, items };
}

export async function filesAuthorize(cfg: AuthzConfig, bearer: string, op: AuthzOp, items: readonly AuthzItem[]): Promise<AuthzResult> {
  const url = new URL('/rest/v1/rpc/files_authorize', cfg.upstream).toString();
  const req = new Request(url, {
    method: 'POST',
    headers: {
      apikey: cfg.anonKey,
      authorization: bearer,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ p_op: op, p_items: items }),
  });
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
      ctl.abort();
    }, cfg.timeoutMs ?? 2000);
  });
  try {
    const r = await Promise.race([cfg.fetch(new Request(req, { signal: ctl.signal })), timeout]);
    if (r === 'timeout') return { kind: 'error', status: 503, code: 'try_later', log: 'authz_timeout' };
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    if (r.status === 401) return { kind: 'error', status: 401, code: 'unauthorized', log: 'authz_401' };
    if (r.ok) {
      return parseOk(body, items.length) ?? { kind: 'error', status: 503, code: 'try_later', log: 'authz_bad_response' };
    }
    const errBody = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    // 入参不对：后端 raise 22023（bad_op、bad_items、put_one_item、too_many_items）
    if (errBody.code === '22023') return { kind: 'error', status: 400, code: 'bad_path', log: 'authz_bad_items' };
    // raise 出来的错误：message 是错误码
    const msg = errBody.message;
    if (typeof msg === 'string' && CODE_RE.test(msg) && r.status < 500) return batchError(msg, 'authz_batch_denied');
    if (r.status === 403) return { kind: 'error', status: 401, code: 'unauthorized', log: 'authz_403' };
    return { kind: 'error', status: 503, code: 'try_later', log: `authz_http_${r.status}` };
  } catch {
    return { kind: 'error', status: 503, code: 'try_later', log: 'authz_unreachable' };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
