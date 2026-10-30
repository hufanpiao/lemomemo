// account export 的 E 组 P0 补测之一（B1 QA 报告 6.2 节；TC-B1-130 ①④⑤，架构 0.47 第 5 条、0.47 续 ①）：
//   ①⑤ 取片之间被停用、会话吊销、退出登录、密码会话——用真的 requireActiveUser（_shared/auth.ts）接一个按假库状态回答的 supabase-js 替身，
//   和 account/index.ts 一样包成 authenticate；④ 函数日志和 /sb 转发都不带响应体。其余缺口在 account-export-p0-gaps.test.ts。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ActiveUser, type AuthResult, handle, keys } from '../../supabase/functions/account/core.ts';
import { handleSb } from '../../functions/sb/[[path]].ts';
import { logCode } from '../../functions/_lib/gate.ts';
import { A, accountDeps, accountReq, accountSetup as setup, B, type FakeDb, type Outbox } from './account-fakes.ts';
import { NEXT, part, runExport, TABLES, uid } from './account-export-harness.ts';
import { E1, recorded, S1, SMALL, startId, todos } from './account-export-p0-harness.ts';
import { ENV, req as sbReq, setup as sbSetup } from './sb-harness.ts';

// ---------------- 130 ①⑤：真的 requireActiveUser ----------------
interface AuthModule {
  requireActiveUser(req: Request, admin: unknown, opts?: { allowPendingDeletion?: boolean }): Promise<ActiveUser>;
  AuthError: new (...a: never[]) => Error & { code: string; toResponse(h?: HeadersInit): Response };
}
// _shared/auth.ts 顶上有 `import type … from 'npm:…'`（只有 Deno 认）：Vitest 运行时类型导入会被去掉，能直接加载；
// 路径放在变量里，tsc（tsconfig.functions.json）不去解析 npm: 写法
const AUTH_PATH = '../../supabase/functions/_shared/auth.ts';
const auth = (await import(/* @vite-ignore */ AUTH_PATH)) as AuthModule;

/** 会话：sub、session_id、amr 写进 JWT payload（签名不验，getUser 由替身回答） */
function jwtOf(sub: string, sid: string, amr: unknown): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256' })}.${b({ sub, session_id: sid, amr })}.sig`;
}

/**
 * service role 的 supabase-js 替身，按假库的状态回答 requireActiveUser 用到的几样：
 * auth.getUser（会话已退出登录 = auth.sessions 里没有这一行 → GoTrue 回 403 session_not_found）、
 * private.account_usable（profile 在、disabled_at 为空）、profiles.disabled_reason、pending_deletions、private.session_alive（在 sessions 里且没被吊销）
 */
function fakeAdmin(db: FakeDb) {
  const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as { sub: string; session_id: string };
  const q = (table: string) => ({
    select: () => ({ eq: (_c: string, v: string) => ({ maybeSingle: async () => {
      if (table === 'profiles') { const p = db.profiles.get(v); return { data: p ? { disabled_reason: p.disabled_reason } : null, error: null }; }
      if (table === 'pending_deletions') { const d = db.pending.get(v); return { data: d ? { purge_after: d.purge_after } : null, error: null }; }
      return { data: null, error: { message: 'x' } };
    } }) }),
  });
  const rpc = async (fn: string, args: Record<string, string>) => {
    if (fn === 'account_usable') { const p = db.profiles.get(args.p_user ?? ''); return { data: Boolean(p && p.disabled_at === null), error: null }; }
    if (fn === 'session_alive') { const s = args.p_session ?? ''; return { data: db.sessions.has(s) && !db.revoked.has(s), error: null }; }
    return { data: null, error: { message: 'x' } };
  };
  return {
    auth: {
      getUser: async (jwt: string) => {
        const c = claims(jwt);
        if (!db.users.has(c.sub)) return { data: { user: null }, error: { status: 401 } };
        if (!db.sessions.has(c.session_id) && !db.revoked.has(c.session_id)) return { data: { user: null }, error: { status: 403 } };   // 退出登录
        return { data: { user: { id: c.sub } }, error: null };
      },
    },
    schema: () => ({ rpc, from: q }),
    from: q,
  };
}

/** 和 account/index.ts 一样把 requireActiveUser 包成 authenticate */
function realAuth(db: FakeDb) {
  const admin = fakeAdmin(db);
  return async (r: Request, opts: { allowPendingDeletion: boolean }): Promise<AuthResult> => {
    try {
      return { ok: true, user: await auth.requireActiveUser(r, admin, opts) };
    } catch (e) {
      if (e instanceof auth.AuthError) return { ok: false, response: e.toResponse({ 'cache-control': 'no-store' }), code: e.code };
      throw e;
    }
  };
}

async function partWith(db: FakeDb, box: Outbox[], jwt: string, exportId: string, cursor: unknown, over: Parameters<typeof accountDeps>[2] = {}) {
  const deps = accountDeps(db, box, { exportTables: TABLES, authenticate: realAuth(db), ...over });
  const r = await handle(accountReq({ action: 'export', step: 'part', export_id: exportId, cursor }, { authorization: `Bearer ${jwt}` }), deps);
  await Promise.all(deps.bg);
  return r;
}

describe('TC-B1-130 ①⑤：取片之间账号停用、会话吊销、退出登录，密码会话（真的 requireActiveUser）', () => {
  const OTP = [{ method: 'otp', timestamp: 1 }];

  /** A 开始导出、取到第 1 片（还没完），返回 export_id 和下一个游标 */
  async function midway() {
    const w = setup();
    w.db.tables.set('todos', todos(60));
    const jwt = jwtOf(A, S1, OTP);
    const id = await startId(w.db, w.box, { ...SMALL, authenticate: realAuth(w.db), newId: () => E1 }, { authorization: `Bearer ${jwt}` });
    const r1 = await partWith(w.db, w.box, jwt, id, null, SMALL);
    expect(r1.status).toBe(200);
    const next = r1.headers.get(NEXT);
    expect(next).not.toBe('done');
    return { ...w, jwt, id, next };
  }

  /** 被拒的那一次：照 requireActiveUser 原样回、不是 gzip、没有游标头；没扣 export-part、没碰任务行、没读数据 */
  async function expectDenied(w: Awaited<ReturnType<typeof midway>>, jwt: string, status: number, code: string) {
    const partsBefore = w.db.count(keys.exportPart(A, w.clock.ms));
    const jobBefore = w.db.count(keys.exportJob(A, w.id, 'omitted', S1));
    const readsBefore = w.db.pageReads.length;
    const seq: string[] = [];
    const r = await partWith(w.db, w.box, jwt, w.id, w.next, { ...SMALL, store: recorded(w.db.accountStore(), seq) });
    expect(r.status).toBe(status);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get(NEXT)).toBeNull();
    expect(await r.json()).toEqual({ error: code });
    expect(seq).toEqual([]);   // 鉴权没过，store 一次都没碰
    expect(w.db.count(keys.exportPart(A, w.clock.ms))).toBe(partsBefore);
    expect(w.db.count(keys.exportJob(A, w.id, 'omitted', S1))).toBe(jobBefore);
    expect(w.db.pageReads.length).toBe(readsBefore);
  }

  it('管理员停用：下一片 403 account_disabled，不再回数据', async () => {
    const w = await midway();
    const p = w.db.profiles.get(A);
    if (!p) throw new Error('没有 A');
    p.disabled_at = new Date(w.clock.ms).toISOString();
    p.disabled_reason = 'admin';
    await expectDenied(w, w.jwt, 403, 'account_disabled');
  });

  it('这台设备被另一台设备移除（会话吊销）：下一片 401 session_revoked', async () => {
    const w = await midway();
    w.db.revoked.set(S1, A);
    await expectDenied(w, w.jwt, 401, 'session_revoked');
    // 同一账号的另一个会话照常能用（只吊销了 S1）；但拿 S1 的任务取片是 410（任务键带会话，M3）
    const other = await partWith(w.db, w.box, jwtOf(A, 'aaaaaaaa-s2', OTP), w.id, w.next, SMALL);
    expect(other.status).toBe(410);
  });

  it('退出登录（auth.sessions 里这一行没了，getUser 回 403）：下一片 401 unauthorized', async () => {
    const w = await midway();
    w.db.sessions.delete(S1);
    await expectDenied(w, w.jwt, 401, 'unauthorized');
  });

  it('⑤ 密码会话（amr 含 password，对象写法和裸字符串写法）取片：401 unauthorized，和 TC-B1-111 同口径', async () => {
    const w = await midway();
    await expectDenied(w, jwtOf(A, S1, [{ method: 'password', timestamp: 1 }]), 401, 'unauthorized');
    await expectDenied(w, jwtOf(A, S1, ['password']), 401, 'unauthorized');
    await expectDenied(w, jwtOf(A, S1, [{ method: 'otp', timestamp: 1 }, { method: 'password', timestamp: 2 }]), 401, 'unauthorized');
    // 对照：同一会话 otp 令牌照常取下一片
    const ok = await partWith(w.db, w.box, w.jwt, w.id, w.next, SMALL);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('application/gzip');
  });
});

// ---------------- 130 ④：日志里没有响应体 ----------------
describe('TC-B1-130 ④：函数日志、/sb 转发日志都不带导出内容', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('account：整份导出（含数据导致的失败、写 export_done 失败）记的日志里没有任何一行的内容', async () => {
    const { db, box } = setup();
    const MARK = 'P0-MARK-本人数据-7f3a';
    db.tables.set('todos', todos(80).map((t, i) => ({ ...t, title: `${MARK}-${i}` })));
    db.tables.set('notes', [{ id: uid('11111111', 1), user_id: A, is_private: false, body: `${MARK}-note` }]);
    db.fail.add('insertLog:export_done');
    const logs: string[] = [];
    const run = await runExport(db, box, { ...SMALL, log: (c) => logs.push(c) });
    expect(run.raws.join('')).toContain(MARK);   // 数据确实在包里
    expect(logs).toEqual(['export_done_log_failed']);
    // 读到别人的行：只记码
    const id = await startId(db, box);
    await part(db, box, id, null, { log: (c) => logs.push(c), store: { ...db.accountStore(), readPage: async () => [{ id: uid('44444444', 1), user_id: B, title: MARK }] } });
    expect(logs.at(-1)).toBe('export_foreign_row');
    expect(logs.join('\n')).not.toContain(MARK);
    expect(logs.join('\n')).not.toContain(A);
  });

  it('/sb 转发：part 的 200（gzip）和 410（JSON）原样转回，console 上一个字都没打', async () => {
    const MARK = 'P0-MARK-sb-9c1e';
    const gz = new Uint8Array(await new Response(new Blob([`{"tables":{"todos":[{"title":"${MARK}"}]}}`]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    for (const [status, body, type] of [[200, gz, 'application/gzip'], [410, new TextEncoder().encode('{"error":"export_expired"}'), 'application/json']] as const) {
      const { deps } = sbSetup({ upstream: async () => new Response(body, { status, headers: { 'content-type': type, 'cache-control': 'no-store', [NEXT]: 'done' } }) });
      const r = await handleSb(sbReq('/sb/functions/v1/account', {
        method: 'POST', headers: { authorization: 'Bearer x', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'export', step: 'part', export_id: E1, cursor: null }),
      }), ENV, { ...deps, log: logCode });
      expect(r.status).toBe(status);
      expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(body))).toBe(true);
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
