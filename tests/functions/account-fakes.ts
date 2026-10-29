// account、account-purge 测试共用的假数据库（B1 K3）：按迁移 20261029150000 的两个函数和 service role 的表操作写的内存版，
// 两个函数的 core.ts 都接它，所以“申请 → 冷静期 → 彻底删除”能在一个进程里串起来（TC-B1-98、101、107、TC-B0-117）。
// 语义以 SQL 为准（supabase/tests/rls/11_account_deletion.test.sql 测真函数），这里只照着做，不另发明规则。
import type { AccountStore, ActiveUser, AuthResult, Deps as AccountDeps } from '../../supabase/functions/account/core.ts';
import { DbError } from '../../supabase/functions/account/core.ts';
import type { Backups, Deps as PurgeDeps, PurgeStore, R2 } from '../../supabase/functions/account-purge/core.ts';
import { BackupsSubdirError } from '../../supabase/functions/account-purge/core.ts';
import type { Mail } from '../../supabase/functions/_shared/account-mail.ts';

export const A = 'aaaaaaaa-0000-4000-8000-000000000001';
export const B = 'bbbbbbbb-0000-4000-8000-000000000002';
export const C = 'cccccccc-0000-4000-8000-000000000003';
export const T0 = Date.parse('2026-10-29T03:00:00Z');   // 首尔 12:00
export const DAY = 86_400_000;
export const H = 3_600_000;
export const CRON = 'test-cron-secret-0123456789abcdef-xyz';   // ≥ 32 字节
export const HASH_SECRET = 'test-signup-hash-secret';

export interface Profile { disabled_at: string | null; disabled_reason: string | null; ui_locale: string; current_tz: string }
export interface Pending { purge_after: string; notice_sent: boolean; purge_started_at: string | null }

export class Clock {
  ms: number;
  constructor(ms = T0) { this.ms = ms; }
  readonly now = () => this.ms;
  advance(ms: number) { this.ms += ms; }
}

/** 一个 JWT（不验签名：requireActiveUser 由测试替身代替；core 只读 payload 里的 amr） */
export function jwtWith(amr: unknown): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: A, session_id: 'x', amr })}.sig`;
}

export class FakeDb {
  users = new Map<string, string>();                  // auth.users：id → email
  sessions = new Map<string, string>();               // auth.sessions：id → user_id
  revoked = new Map<string, string>();                // private.revoked_sessions
  profiles = new Map<string, Profile>();
  pending = new Map<string, Pending>();
  admins = new Set<string>();
  counters = new Map<string, number>();               // key|window → count
  pendingSignups = new Set<string>();                 // email_hash
  deleted = new Set<string>();                        // private.deleted_accounts
  heartbeat: Record<string, number> | null = null;
  logs: { id: number; user_id: string; act: string; device: string | null; t: number; code?: string }[] = [];
  private logSeq = 0;
  devices = new Map<string, { user_id: string; label: string | null }>();
  tables = new Map<string, Record<string, unknown>[]>();   // 导出读的 public 表
  /** readPage 每次调用的（表、after），测试核对按主键翻页 */
  pageReads: { table: string; after: string | number | null }[] = [];
  /** 故障注入：方法名 → 抛错 */
  fail = new Set<string>();
  /** account-purge 的 stillClaimed 被调时先跑一下（模拟“写 deleted_accounts 前这一行被删”） */
  beforeStillClaimed: (() => void) | null = null;

  readonly clock: Clock;
  constructor(clock: Clock) { this.clock = clock; }

  addUser(id: string, email: string, p: Partial<Profile> = {}) {
    this.users.set(id, email);
    this.profiles.set(id, { disabled_at: null, disabled_reason: null, ui_locale: 'zh-CN', current_tz: 'Asia/Seoul', ...p });
    this.sessions.set(`${id.slice(0, 8)}-s1`, id);
    this.sessions.set(`${id.slice(0, 8)}-s2`, id);
  }

  private nowIso() { return new Date(this.clock.ms).toISOString(); }
  private guard(name: string) { if (this.fail.has(name)) throw new Error(`fake_${name}`); }

  /** 级联：auth.users 删行时，带外键的都跟着删（profiles、pending_deletions、revoked_sessions、sessions、各表），deleted_accounts 留着 */
  deleteUserCascade(id: string) {
    this.users.delete(id);
    this.profiles.delete(id);
    this.pending.delete(id);
    this.admins.delete(id);
    for (const [s, u] of [...this.sessions]) if (u === id) this.sessions.delete(s);
    for (const [s, u] of [...this.revoked]) if (u === id) this.revoked.delete(s);
    for (const [k, rows] of this.tables) this.tables.set(k, rows.filter((r) => r.user_id !== id));
    for (const [d, v] of [...this.devices]) if (v.user_id === id) this.devices.delete(d);
    this.logs = this.logs.filter((l) => l.user_id !== id);
  }

  takeRate(key: string, limit: number, windowS: number): boolean {
    if (!/^[a-z][a-z0-9_-]*:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|global|ip|mail):[^:]+$/.test(key)) throw new Error('23514');
    const w = Math.floor(this.clock.ms / 1000 / windowS);
    const k = `${key}|${w}`;
    const n = (this.counters.get(k) ?? 0) + 1;
    this.counters.set(k, n);
    return n <= limit;
  }

  /** = private.account_request_deletion */
  requestDeletion(uid: string): string {
    if (this.admins.has(uid)) throw new DbError('admin_cannot_delete');
    const p = this.profiles.get(uid);
    if (!p || (p.disabled_at !== null && p.disabled_reason !== 'deletion')) throw new DbError('account_disabled');
    if (p.disabled_at !== null) throw new DbError('account_pending_deletion');
    const pa = new Date(this.clock.ms + 7 * DAY).toISOString();
    this.pending.set(uid, { purge_after: pa, notice_sent: false, purge_started_at: null });
    p.disabled_at = this.nowIso();
    p.disabled_reason = 'deletion';
    for (const [s, u] of [...this.sessions]) if (u === uid) { this.revoked.set(s, u); this.sessions.delete(s); }
    return pa;
  }

  /** = private.account_restore */
  restore(uid: string): string {
    const d = this.pending.get(uid);
    if (!d) return 'not_pending';
    if (d.purge_started_at !== null) return 'purge_started';
    if (Date.parse(d.purge_after) <= this.clock.ms) return 'expired';
    const p = this.profiles.get(uid);
    if (p?.disabled_reason !== 'deletion') return 'account_disabled';
    this.pending.delete(uid);
    p.disabled_at = null;
    p.disabled_reason = null;
    return 'ok';
  }

  accountStore(): AccountStore {
    return {
      isAdmin: async (u) => { this.guard('isAdmin'); return this.admins.has(u); },
      takeRate: async (k, l, w) => { this.guard('takeRate'); return this.takeRate(k, l, w); },
      refundRate: async (k) => {
        this.guard('refundRate');
        const ws = [...this.counters.keys()].filter((x) => x.split('|')[0] === k).sort((x, y) => Number(x.split('|')[1]) - Number(y.split('|')[1]));
        const last = ws[ws.length - 1];
        const n = last === undefined ? 0 : (this.counters.get(last) ?? 0);
        if (last !== undefined && n > 0) this.counters.set(last, n - 1);
      },
      requestDeletion: async (u) => { this.guard('requestDeletion'); return this.requestDeletion(u); },
      restore: async (u) => { this.guard('restore'); return this.restore(u); },
      profile: async (u) => { const p = this.profiles.get(u); return p ? { ui_locale: p.ui_locale, current_tz: p.current_tz } : null; },
      deviceLabel: async (u, d) => { const v = this.devices.get(d); return v && v.user_id === u ? v.label : null; },
      insertLog: async (u, row) => {
        this.guard(`insertLog:${row.act}`);
        this.logs.push({ id: ++this.logSeq, user_id: u, act: row.act, device: row.device, t: row.t, ...(row.code === undefined ? {} : { code: row.code }) });
      },
      // = select * from <t> where user_id = u [and keyCol > after] order by keyCol limit n（和 PostgREST 一样按主键往后翻）
      readPage: async (t, keyCol, u, after, limit) => {
        this.guard('readPage');
        this.pageReads.push({ table: t, after });
        const src: Record<string, unknown>[] = t === 'logs' ? this.logs.map((l) => ({ ...l })) : (this.tables.get(t) ?? []);
        const key = (r: Record<string, unknown>) => r[keyCol] as string | number;
        return src.filter((r) => r.user_id === u && (after === null || key(r) > after))
          .sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0)).slice(0, limit);
      },
    };
  }

  purgeStore(): PurgeStore {
    return {
      listRemind: async (nowIso, untilIso) => {
        this.guard('listRemind');
        return [...this.pending].filter(([, d]) => !d.notice_sent && d.purge_after > nowIso && d.purge_after <= untilIso)
          .map(([user_id, d]) => ({ user_id, purge_after: d.purge_after }));
      },
      casNotice: async (u, from, to) => {
        this.guard('casNotice');
        const d = this.pending.get(u);
        if (!d || d.notice_sent !== from) return false;
        d.notice_sent = to;
        return true;
      },
      listDue: async (nowIso, staleIso) => {
        this.guard('listDue');
        return [...this.pending].filter(([, d]) => d.purge_after <= nowIso && (d.purge_started_at === null || d.purge_started_at < staleIso))
          .sort((x, y) => (x[1].purge_after < y[1].purge_after ? -1 : 1)).map(([user_id, d]) => ({ user_id, purge_after: d.purge_after }));
      },
      claim: async (u, nowIso, staleIso) => {
        this.guard('claim');
        const d = this.pending.get(u);
        if (!d || d.purge_after > nowIso || !(d.purge_started_at === null || d.purge_started_at < staleIso)) return false;
        d.purge_started_at = nowIso;
        return true;
      },
      release: async (u, iso) => { const d = this.pending.get(u); if (d && d.purge_started_at === iso) d.purge_started_at = null; },
      stillClaimed: async (u, iso) => { this.beforeStillClaimed?.(); return this.pending.get(u)?.purge_started_at === iso; },
      isAdmin: async (u) => this.admins.has(u),
      profile: async (u) => { const p = this.profiles.get(u); return p ? { ...p } : null; },
      deletePendingSignup: async (h) => { this.guard('deletePendingSignup'); this.pendingSignups.delete(h); },
      deleteCounterKey: async (key) => { for (const k of [...this.counters.keys()]) if (k.split('|')[0] === key) this.counters.delete(k); },
      deleteUserCounters: async (u) => {
        this.guard('deleteUserCounters');
        for (const k of [...this.counters.keys()]) if (k.split('|')[0]?.split(':')[1] === u) this.counters.delete(k);
      },
      insertDeletedAccount: async (u) => { this.guard('insertDeletedAccount'); this.deleted.add(u); },
      remainingRows: async (u) => (this.profiles.has(u) ? 1 : 0) + (this.pending.has(u) ? 1 : 0),
      writeHeartbeat: async (d) => { this.guard('writeHeartbeat'); this.heartbeat = { ...d }; },
    };
  }
}

/** backups 桶的内存版：路径 <日期>/<user_id>/<表>.json.gz */
export class FakeBackups implements Backups {
  files = new Set<string>();
  removeKeepsOne = false;   // 故障注入：remove 少删一个（删完再列不为 0）
  async listDates() { return [...new Set([...this.files].map((f) => f.split('/')[0] ?? ''))].sort(); }
  /** 和 index.ts 一样：<日期>/<user_id>/ 下出现子目录就抛 BackupsSubdirError */
  async listUserFiles(date: string, uid: string) {
    const fs = [...this.files].filter((f) => f.startsWith(`${date}/${uid}/`)).sort();
    if (fs.some((f) => f.slice(`${date}/${uid}/`.length).includes('/'))) throw new BackupsSubdirError();
    return fs;
  }
  async remove(paths: readonly string[]) {
    const ps = this.removeKeepsOne ? paths.slice(1) : paths;
    for (const p of ps) this.files.delete(p);
  }
  count(uid: string) { return [...this.files].filter((f) => f.split('/')[1] === uid).length; }
}

export interface Outbox { to: string; mail: Mail }

export function mailer(box: Outbox[], ok = () => true) {
  return async (to: string, mail: Mail) => {
    if (!ok()) return false;
    box.push({ to, mail });
    return true;
  };
}

/** account 的 deps：authenticate 按 FakeDb 的状态模仿 requireActiveUser（冷静期只放行 restore；管理员停用一律 account_disabled；会话吊销） */
export function accountDeps(db: FakeDb, box: Outbox[], over: Partial<AccountDeps> & { user?: string; session?: string; amr?: unknown } = {}): AccountDeps & { bg: Promise<unknown>[] } {
  const bg: Promise<unknown>[] = [];
  const uid = over.user ?? A;
  const session = over.session ?? `${uid.slice(0, 8)}-s1`;
  const jwt = jwtWith(over.amr ?? [{ method: 'otp', timestamp: Math.floor(db.clock.ms / 1000) - 60 }]);
  const authenticate = async (_req: Request, opts: { allowPendingDeletion: boolean }): Promise<AuthResult> => {
    const deny = (code: string, status: number, extra: Record<string, unknown> = {}) =>
      ({ ok: false as const, response: new Response(JSON.stringify({ error: code, ...extra }), { status }), code });
    const p = db.profiles.get(uid);
    if (!p || (p.disabled_at !== null && p.disabled_reason !== 'deletion')) return deny('account_disabled', 403);
    if (p.disabled_at !== null && !opts.allowPendingDeletion) return deny('account_pending_deletion', 403, { purge_after: db.pending.get(uid)?.purge_after });
    if (!db.sessions.has(session) || db.revoked.has(session)) return deny('session_revoked', 401);
    // 冷静期放行时带 pendingDeletion（和 requireActiveUser 一样：取不到 pending_deletions 行就是 null）
    const user: ActiveUser = p.disabled_at !== null
      ? { userId: uid, sessionId: session, jwt, pendingDeletion: { purgeAfter: db.pending.get(uid)?.purge_after ?? null } }
      : { userId: uid, sessionId: session, jwt };
    return { ok: true, user };
  };
  const base: AccountDeps & { bg: Promise<unknown>[] } = {
    authenticate,
    store: db.accountStore(),
    userEmail: async (u) => db.users.get(u) ?? null,
    sendMail: mailer(box),
    verifyVaultToken: async () => 'vault_locked',
    exportTables: [],
    proxySecret: 'proxy-secret',
    background: (p) => { bg.push(p); },
    now: db.clock.now,
    bg,
  };
  const { user: _u, session: _s, amr: _a, ...rest } = over;
  return { ...base, ...rest };
}

export function purgeDeps(db: FakeDb, r2: R2, backups: FakeBackups, box: Outbox[], over: Partial<PurgeDeps> = {}): PurgeDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    cronSecret: CRON,
    store: db.purgeStore(),
    r2,
    backups,
    userEmail: async (u) => db.users.get(u) ?? null,
    deleteUser: async (u) => { if (db.fail.has('deleteUser')) throw new Error('auth'); db.deleteUserCascade(u); },
    sendMail: mailer(box),
    hashSecret: HASH_SECRET,
    now: db.clock.now,
    log: (c) => logs.push(c),
    logs,
    ...over,
  };
}

export function accountReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://x.supabase.co/functions/v1/account', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer x', ...headers },
    body: JSON.stringify(body),
  });
}

export function cronReq(secret: string | null = CRON): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (secret !== null) headers.set('x-cron-secret', secret);
  return new Request('https://x.supabase.co/functions/v1/account-purge', { method: 'POST', headers, body: '{}' });
}
