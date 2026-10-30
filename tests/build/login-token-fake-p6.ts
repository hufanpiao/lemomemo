// login-token-fake.ts 里 -Only P6 用的两条只读假路由（10-31 加 admins 条数时从那个文件拆出来，免得超过 300 行，W1）：
//   GET /auth/v1/admin/users?page=1&per_page=1  GoTrue 管理端，只报 x-total-count（账号总数）；
//   GET /rest/v1/admins?select=user_id&limit=1  PostgREST，Accept-Profile: private、Prefer: count=exact，只报 Content-Range 的总数。
// 两条都只认 service key（apikey 头）；依次取 userTotals / adminTotals（最后一个用到底），adminTotals 里的 null 表示回 500
import type { IncomingMessage } from 'node:http';

export type P6Totals = { userTotals?: number[] | undefined; adminTotals?: (number | null)[] | undefined };
export type P6Reply = [status: number, body: unknown, headers?: Record<string, string>];

/** 是 P6 的两条路径就回假响应，否则 null；counts 记每条路由已被调几次 */
export function p6Route(req: IncomingMessage, p: string, o: P6Totals, service: string, uid: string, counts: { users: number; admins: number }): P6Reply | null {
  if (req.method !== 'GET') return null;
  if (p === '/auth/v1/admin/users?page=1&per_page=1') {
    if (req.headers.apikey !== service) return [401, { code: 401, error_code: 'bad_jwt' }];
    const totals = o.userTotals ?? [7];
    const t = totals[Math.min(counts.users++, totals.length - 1)] ?? 7;
    return [200, { users: [{ id: uid }] }, { 'x-total-count': String(t) }];
  }
  if (p === '/rest/v1/admins?select=user_id&limit=1') {
    if (req.headers.apikey !== service || req.headers['accept-profile'] !== 'private') return [401, { code: '42501' }];
    const totals = o.adminTotals ?? [0];
    const at = Math.min(counts.admins++, totals.length - 1);
    const t = at in totals ? totals[at] : 0;   // 不用 ??：null 要保留
    if (t === null) return [500, { code: 'PGRST000' }];
    return [200, t ? [{ user_id: uid }] : [], { 'content-range': t ? `0-0/${t}` : '*/0' }];
  }
  return null;
}
