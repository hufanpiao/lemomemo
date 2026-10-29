// invite-admin 测试共用的替身（invite-admin.test.ts、invite-admin-e2e.test.ts 引用）：假库、模仿 requireActiveUser 的鉴权、请求。
// 假 take_rate 和迁移同一个口径（先计数再判断），假 invites 带 note 的 check 约束（char_length(note) <= 40）和 code_hash 主键。
import { handle, type AuthResult, type Deps, type InsertResult, type InviteInsert, type InviteListRow, type InviteStore } from '../../supabase/functions/invite-admin/core.ts';
import { randomInviteCode } from '../../supabase/functions/_shared/invite-code.ts';

export const NOW = Date.parse('2026-10-29T12:00:00Z');
export const ADMIN = 'aaaaaaaa-0000-4000-8000-0000000000ad';
export const USER = 'bbbbbbbb-0000-4000-8000-000000000001';
// 0001 的 counters 键约束（附录 A：每个写键处一条单元测试断言生成的键过得了它）
export const COUNTER_KEY = /^[a-z][a-z0-9_-]*:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|global|ip|mail):[^:]+$/;

export class FakeStore implements InviteStore {
  admins = new Set<string>([ADMIN]);
  invites = new Map<string, InviteInsert>();
  counters = new Map<string, number>();
  minVersion: string | null = null;
  calls: string[] = [];
  /** 并发测试用：每次调用先让出一次，让多个请求真的交错 */
  yieldEachCall = false;
  private async tick() { if (this.yieldEachCall) await new Promise((r) => setTimeout(r, 0)); }

  async isAdmin(userId: string) { this.calls.push('isAdmin'); await this.tick(); return this.admins.has(userId); }
  async takeRate(key: string, limit: number) {
    this.calls.push('takeRate');
    await this.tick();
    if (!COUNTER_KEY.test(key)) throw new Error('23514 counters_key_check');
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return n <= limit;
  }
  async insertInvite(row: InviteInsert): Promise<InsertResult> {
    this.calls.push('insertInvite');
    await this.tick();
    if (row.note !== null && [...row.note].length > 40) throw new Error('23514 invites_note_check');
    if (this.invites.has(row.code_hash)) return 'duplicate';
    this.invites.set(row.code_hash, { ...row });
    return 'ok';
  }
  async listInvites(createdBy: string, notExpiredAt: string, limit: number): Promise<InviteListRow[]> {
    this.calls.push('listInvites');
    return [...this.invites.values()]
      .filter((r) => r.created_by === createdBy && Date.parse(r.expires_at) > Date.parse(notExpiredAt))
      .sort((a, b) => Date.parse(b.expires_at) - Date.parse(a.expires_at))
      .slice(0, limit)
      .map(({ note, max_uses, used_count, expires_at }) => ({ note, max_uses, used_count, expires_at }));
  }
  async minClientVersion() { this.calls.push('minClientVersion'); return this.minVersion; }
}

type Profile = { disabled: boolean; revoked: boolean };

/** authenticate 模仿 requireActiveUser：没带 JWT 401 unauthorized；停用 403 account_disabled；会话吊销 401 session_revoked */
export function deps(store: FakeStore, over: Partial<Deps> & { user?: string; profile?: Partial<Profile>; codes?: string[] } = {}): Deps & { logs: string[] } {
  const uid = over.user ?? ADMIN;
  const prof: Profile = { disabled: false, revoked: false, ...over.profile };
  const logs: string[] = [];
  const codes = over.codes ? [...over.codes] : null;
  const authenticate = async (req: Request): Promise<AuthResult> => {
    const deny = (code: string, status: number) => ({ ok: false as const, response: new Response(JSON.stringify({ error: code }), { status }) });
    if (!/^Bearer\s+\S+$/i.test(req.headers.get('authorization') ?? '')) return deny('unauthorized', 401);
    if (prof.disabled) return deny('account_disabled', 403);
    if (prof.revoked) return deny('session_revoked', 401);
    return { ok: true, user: { userId: uid, sessionId: 's1', jwt: 'jwt' } };
  };
  const { user: _u, profile: _p, codes: _c, ...rest } = over;
  return {
    authenticate,
    store,
    now: () => NOW,
    ...(codes ? { newCode: () => codes.shift() ?? randomInviteCode() } : {}),
    log: (c) => { logs.push(c); },
    logs,
    ...rest,
  };
}

export function req(body: unknown, headers: Record<string, string> = {}, method = 'POST'): Request {
  const init: RequestInit = { method, headers: { authorization: 'Bearer x', 'content-type': 'application/json', ...headers } };
  if (method !== 'GET' && method !== 'HEAD') init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('https://x.supabase.co/functions/v1/invite-admin', init);
}

export async function call(store: FakeStore, body: unknown, over: Parameters<typeof deps>[1] = {}, headers: Record<string, string> = {}) {
  const d = deps(store, over);
  const res = await handle(req(body, headers), d);
  return { res, logs: d.logs };
}
