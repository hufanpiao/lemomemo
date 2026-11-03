// login-token-fake.ts 里 -Only P6、P6A 用的只读假路由（10-31 加 admins 条数时从那个文件拆出来，免得超过 300 行，W1；11-03 加 P6A 两条）：
//   GET /auth/v1/admin/users?page=1&per_page=1    GoTrue 管理端，只报 x-total-count（P6 数账号总数）；
//   GET /auth/v1/admin/users?page=N&per_page=200  GoTrue 管理端，一页账号（P6A 找 e2e-admin@lemomemo.test 的 id；p6aNoUser 时没有它）；
//   GET /rest/v1/admins?select=user_id&limit=1    PostgREST，Accept-Profile: private、Prefer: count=exact，只报 Content-Range 的总数；
//   GET /rest/v1/admins?select=user_id&user_id=eq.<P6A_UID>&limit=1  同上，只数 e2e-admin 那一行（P6A 判断第几次）。
// 都只认 service key（apikey 头）；依次取 userTotals / adminTotals / p6aMember（最后一个用到底），adminTotals、p6aMember 里的 null 表示回 500
import type { IncomingMessage } from 'node:http';

export type P6Totals = {
  userTotals?: number[] | undefined;
  adminTotals?: (number | null)[] | undefined;
  p6aNoUser?: boolean | undefined;            // P6A：预览里还没有 e2e-admin@lemomemo.test
  p6aMember?: (number | null)[] | undefined;  // P6A：e2e-admin 在 admins 里的行数，依次报（默认一直是 0）
  p6aGateway401?: boolean | string | undefined; // P6A：找账号那一页回网关样式的 401（只有 message，没有错误码）；给字符串就用它当 message
};
export type P6Reply = [status: number, body: unknown, headers?: Record<string, string>];
export const P6A_EMAIL = 'e2e-admin@lemomemo.test';
export const P6A_UID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const pick = <T>(seq: T[], i: number, dflt: T): T => (seq.length === 0 ? dflt : (seq[Math.min(i, seq.length - 1)] as T));
const range = (t: number | null): P6Reply => (t === null ? [500, { code: 'PGRST000' }] : [200, t ? [{ user_id: 'x' }] : [], { 'content-range': t ? `0-0/${t}` : '*/0' }]);

/** 是 P6、P6A 的路径就回假响应，否则 null；counts 记每条路由已被调几次 */
export function p6Route(
  req: IncomingMessage,
  p: string,
  o: P6Totals,
  service: string,
  uid: string,
  counts: { users: number; admins: number; member?: number },
): P6Reply | null {
  if (req.method !== 'GET') return null;
  const page = /^\/auth\/v1\/admin\/users\?page=(\d+)&per_page=200$/.exec(p);
  const total = p === '/rest/v1/admins?select=user_id&limit=1';
  const member = p === `/rest/v1/admins?select=user_id&user_id=eq.${P6A_UID}&limit=1`;
  // 只管这几条精确路径（P2 用登录令牌读 /rest/v1/admins?select=*… 走 login-token-fake.ts 自己的路由）
  if (!(p === '/auth/v1/admin/users?page=1&per_page=1' || page || total || member)) return null;
  // 照 Supabase 的做法：浏览器样式的 User-Agent（含 Mozilla，PS 5.1 Invoke-WebRequest 的默认 UA 就是）带 sb_secret_ 一律 401，正文只有 message
  // （https://supabase.com/docs/guides/api/api-keys；11-03 负责人跑 -Only P6A 实际遇到）
  if (/mozilla/i.test(String(req.headers['user-agent'] ?? '')) && String(req.headers.apikey ?? '').startsWith('sb_secret_')) {
    return [401, { message: 'secret API key used from a browser' }];
  }
  if (req.headers.apikey !== service) return [401, { code: 401, error_code: 'bad_jwt' }];
  if (page && o.p6aGateway401) {
    return [401, { message: typeof o.p6aGateway401 === 'string' ? o.p6aGateway401 : 'Invalid API key', hint: 'Double check your API key.' }];
  }
  if ((total || member) && req.headers['accept-profile'] !== 'private') return [401, { code: '42501' }];
  if (p === '/auth/v1/admin/users?page=1&per_page=1') {
    const t = pick(o.userTotals ?? [], counts.users++, 7);
    return [200, { users: [{ id: uid }] }, { 'x-total-count': String(t) }];
  }
  if (page) {
    const all = [{ id: uid, email: 'hufanp+lemotest@gmail.com' }, ...(o.p6aNoUser ? [] : [{ id: P6A_UID, email: P6A_EMAIL }])];
    return [200, { users: page[1] === '1' ? all : [] }, { 'x-total-count': String(all.length) }];
  }
  if (total) return range(pick(o.adminTotals ?? [], counts.admins++, 0));
  counts.member = (counts.member ?? 0) + 1;
  return range(pick(o.p6aMember ?? [], counts.member - 1, 0));
}
