// db-probe（预览专用、一次性的数据库探测函数；supabase/functions/_preview/db-probe/，说明见 docs/09-路线图/B0-P6数据库探测函数.md）
// 证明：只在预览项目生效；过期回 410；只收 POST 和固定格式的请求体；限频（同实例冷却 + 跨实例锁）；
// 各步骤按假数据库的结果如实判通过 / 不通过（RLS 放错行、app.uid 跨事务串、TLS 校验失败、不加密被接受都判不通过）；
// 超总预算报 deadline 并关掉自开的连接；响应里不回显连接串、密码、主机名、报错原文。
// index.ts 要 Deno 和 npm:postgres，这里不测；它和 _shared/db.ts 的连接参数是否一致，在最后一组用文本核对。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COOLDOWN_MS, EXPIRES_AT, type Guard, handle, type HandlerDeps, isPreview } from '../../supabase/functions/_preview/db-probe/handler.ts';
import {
  caFingerprint,
  connUrl,
  errCode,
  PREVIEW_REF,
  type ProbeDeps,
  type ProbeReport,
  type Query,
  ROUNDS,
  type Session,
  type Tls,
  TEST_UID,
  TOTAL_BUDGET_MS,
  UID_PLACEHOLDER,
  urlFacts,
} from '../../supabase/functions/_preview/db-probe/probe.ts';

const ROOT = join(__dirname, '..', '..');
const A = '11111111-2222-4333-8444-555555555555';
const B = '99999999-8888-4777-8666-555555555555';
const PREVIEW_URL = `https://${PREVIEW_REF}.supabase.co`;
const T0 = Date.parse('2026-10-29T03:00:00Z');
// 假连接串：密码、主机名都是编的，只用来证明它们不进响应
const SECRET_PW = 'Sup3rS3cretPw_do-not-echo';
const POOL_HOST = 'aws-9-ap-northeast-2.pooler.supabase.com';
const FAKE_URL = `postgresql://fn_ai.${PREVIEW_REF}:${SECRET_PW}@${POOL_HOST}:6543/postgres?sslmode=require`;

// ---------- 假数据库 ----------

interface DbOpts {
  /** notes 表的行（只要 user_id） */
  notes?: string[];
  /** private.scan_embed_queue 的行（user_id） */
  queue?: string[];
  /** RLS 坏了：不管 app.uid，notes 全部可见 */
  rlsBroken?: boolean;
  /** app.uid 跨事务串：同一条自开连接上，上一个事务设的值下一个事务还在 */
  leak?: boolean;
  /** 各种连接方式连不上时抛的错（withUser / withScan 走 require） */
  fail?: Partial<Record<Tls | 'user' | 'scan', unknown>>;
  /** 永远不返回（测超时） */
  hang?: Partial<Record<Tls | 'user', true>>;
  /** current_user 返回什么（默认 fn_ai） */
  user?: string;
}

function fakeDb(o: DbOpts = {}) {
  const notes = o.notes ?? [A, A, B];
  const queue = o.queue ?? [A, B, B];
  const log: string[] = [];
  const ended: Tls[] = [];
  const opened: Tls[] = [];
  const visible = (uid: string | null) => (o.rlsBroken ? notes : uid ? notes.filter((u) => u === uid) : []);

  // 一个事务：uid 是本事务的 app.uid
  const makeQuery = (state: { uid: string | null; onSet?: (u: string) => void }): Query => async (strings, ...values) => {
    const text = strings.join('$');
    log.push(text.replace(/\s+/g, ' ').trim());
    if (text.includes("set_config('statement_timeout'")) return [];
    if (text.includes("set_config('app.uid'")) {
      state.uid = String(values[0]);
      state.onSet?.(state.uid);
      return [];
    }
    if (text.includes('uid_set')) {
      const uid = String(values[0]);
      return [{ u: o.user ?? 'fn_ai', uid_set: state.uid === uid, n: visible(state.uid).length, other: visible(state.uid).filter((x) => x !== uid).length }];
    }
    if (text.includes('scan_embed_queue')) {
      return [{ u: o.user ?? 'fn_ai', uid_empty: !state.uid, q: queue.length, qu: new Set(queue).size, n: visible(state.uid).length }];
    }
    if (text.includes('uid_empty')) return [{ uid_empty: !state.uid, n: visible(state.uid).length }];
    if (text.includes('as n')) return [{ n: visible(state.uid).length }];
    if (text.includes('current_user::text as u')) return [{ u: o.user ?? 'fn_ai' }];
    if (text.includes('select 1 as one')) return [{ one: 1 }];
    throw new Error(`假数据库不认识这条 SQL：${text}`);
  };

  const never = new Promise<never>(() => undefined);

  const deps = (extra: Partial<ProbeDeps> = {}): ProbeDeps => ({
    url: urlFacts(FAKE_URL).facts,
    lemoProbePresent: false,
    withUser: async (uid, fn) => {
      if (o.hang?.user) return never;
      if (o.fail?.user) throw o.fail.user;
      return fn(makeQuery({ uid }));
    },
    withScan: async (fn) => {
      if (o.fail?.scan) throw o.fail.scan;
      return fn(makeQuery({ uid: null }));
    },
    open: (tls): Session => {
      opened.push(tls);
      let sticky: string | null = null;
      return {
        tx: async (fn) => {
          if (o.hang?.[tls]) return never;
          if (o.fail?.[tls]) throw o.fail[tls];
          return fn(makeQuery({ uid: o.leak ? sticky : null, onSet: (u) => (sticky = u) }));
        },
        end: async () => {
          ended.push(tls);
        },
      };
    },
    caFingerprint: null,
    clock: () => Date.now(),
    ...extra,
  });
  return { deps, log, opened, ended };
}

// ---------- 假 HTTP 依赖 ----------

interface Setup {
  wall?: number;
  supabaseUrl?: string | undefined;
  db?: DbOpts;
  probe?: Partial<ProbeDeps>;
  guard?: 'ok' | 'busy' | { throws: unknown };
  makeThrows?: boolean;
  /** 注入的测试账号 uid（默认 A，和假数据库对上）；传 UID_PLACEHOLDER 测占位值 */
  testUid?: string;
}

function setup(s: Setup = {}) {
  const db = fakeDb(s.db);
  let wall = s.wall ?? T0;
  const made: number[] = [];
  const guarded: number[] = [];
  const g = s.guard ?? 'ok';
  const guard: Guard = async (fn) => {
    guarded.push(1);
    if (g === 'busy') return { got: false };
    if (typeof g === 'object') throw g.throws;
    return { got: true, value: await fn() };
  };
  const deps: HandlerDeps = {
    supabaseUrl: 'supabaseUrl' in s ? s.supabaseUrl : PREVIEW_URL,
    region: 'ap-northeast-2',
    makeProbe: () => {
      made.push(1);
      if (s.makeThrows) throw new Error(`FN_AI_DB_URL 未设置 ${FAKE_URL}`);
      return db.deps(s.probe);
    },
    guard,
    limiter: { last: null },
    now: () => wall,
    instance: { id: 'abc123abc123', bootAt: T0 - 5_000 },
    testUid: s.testUid ?? A,
  };
  return { deps, db, made, guarded, advance: (ms: number) => (wall += ms) };
}

const post = (body: unknown = { action: 'run' }, init: RequestInit = {}) =>
  new Request('https://x/functions/v1/db-probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });

type Body = ProbeReport & { region: string | null; instance: { id: string; age_s: number }; guard?: { ok: boolean; code: string } };
const run = async (s: ReturnType<typeof setup>, body?: unknown) => {
  const r = await handle(post(body), s.deps);
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) as Body, headers: r.headers };
};

/** 响应里不能出现的东西：密码、主机名、整条连接串、报错原文里常见的词 */
const NO_LEAK = [SECRET_PW, POOL_HOST, 'postgresql://', 'pooler.supabase.com', 'sslmode=require', 'password authentication failed'];
const expectNoLeak = (text: string) => {
  for (const s of NO_LEAK) expect(text, s).not.toContain(s);
};

afterEach(() => {
  vi.useRealTimers();
});

describe('db-probe：只在预览项目生效、到期失效、只收固定格式的 POST', () => {
  it.each([
    ['没设', undefined],
    ['正式项目', 'https://abcdefghijklmnopqrst.supabase.co'],
    ['预览 ref 当子串', `https://x${PREVIEW_REF}.supabase.co`],
    ['预览 ref 换了域名', `https://${PREVIEW_REF}.supabase.co.evil.example`],
    ['http', `http://${PREVIEW_REF}.supabase.co`],
    ['不是 URL', PREVIEW_REF],
    ['带路径', `${PREVIEW_URL}/functions/v1`],
    ['带端口', `${PREVIEW_URL}:443`],
    ['带用户名', `https://u@${PREVIEW_REF}.supabase.co`],
    ['带查询串', `${PREVIEW_URL}/?x=1`],
    ['两个斜杠', `${PREVIEW_URL}//`],
    ['大写', PREVIEW_URL.toUpperCase()],
  ])('SUPABASE_URL %s → 404，不建依赖、不连库', async (_, url) => {
    const s = setup({ supabaseUrl: url });
    const r = await handle(post(), s.deps);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not_found' });
    expect(s.made).toEqual([]);
    expect(s.guarded).toEqual([]);
    expect(s.db.log).toEqual([]);
  });

  it('isPreview 一字不差：只认 https://<预览 ref>.supabase.co，只许末尾多一个斜杠', () => {
    expect(isPreview(PREVIEW_URL)).toBe(true);
    expect(isPreview(`${PREVIEW_URL}/`)).toBe(true);
    expect(isPreview('')).toBe(false);
    expect(isPreview(`${PREVIEW_URL}/functions/v1`)).toBe(false);
    expect(isPreview(`${PREVIEW_URL}:443`)).toBe(false);
  });

  it('过了 EXPIRES_AT（2026-11-10T15:00:00Z）→ 410 expired，不建依赖、不连库；GET 也是 410；正式环境照旧 404', async () => {
    expect(EXPIRES_AT).toBe(Date.parse('2026-11-10T15:00:00Z'));
    for (const wall of [EXPIRES_AT, EXPIRES_AT + 86_400_000]) {
      const s = setup({ wall });
      const r = await handle(post(), s.deps);
      expect(r.status).toBe(410);
      expect(await r.json()).toEqual({ error: 'expired' });
      expect((await handle(new Request('https://x/', { method: 'GET' }), s.deps)).status).toBe(410);
      expect(s.made).toEqual([]);
      expect(s.db.log).toEqual([]);
    }
    expect((await handle(post(), setup({ wall: EXPIRES_AT + 1, supabaseUrl: undefined }).deps)).status).toBe(404);
    expect((await handle(post(), setup({ wall: EXPIRES_AT - 1 }).deps)).status).toBe(200);
  });

  it('只收 POST：GET、PUT、DELETE、OPTIONS → 405，不连库', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
      const s = setup();
      const r = await handle(new Request('https://x/functions/v1/db-probe', { method }), s.deps);
      expect(r.status, method).toBe(405);
      expect(r.headers.get('allow')).toBe('POST');
      expect(s.made).toEqual([]);
    }
  });

  it.each([
    ['不是 JSON', 'run'],
    ['没有 action', {}],
    ['带 uid（不再由调用方传）', { action: 'run', uid: A }],
    ['带 uid 和 plaintext', { action: 'run', uid: B, plaintext: true }],
    ['未知 action', { action: 'release' }],
    ['多余的字段', { action: 'run', role: 'fn_vault' }],
    ['plaintext 不是布尔', { action: 'run', plaintext: 'yes' }],
    ['数组', ['run']],
    ['超过 256 字节', { action: 'run', plaintext: false, pad: 'x'.repeat(300) }],
  ])('请求体%s → 400，不建依赖、不占限频名额', async (_, body) => {
    const s = setup();
    const r = await handle(post(body), s.deps);
    expect(r.status).toBe(400);
    expect(s.made).toEqual([]);
    expect(s.deps.limiter.last).toBeNull();
  });

  it('content-length 超过 256 → 400，不读请求体', async () => {
    const s = setup();
    const r = await handle(post({ action: 'run' }, { headers: { 'content-type': 'application/json', 'content-length': '9999' } }), s.deps);
    expect(r.status).toBe(400);
  });

  it('TEST_UID 写的是预览测试账号 A 的 uid（10-29 主持人在控制台核对），不是占位值', () => {
    expect(TEST_UID).toBe('7aa8c4cb-11ba-4e9e-aa6f-72196dfe3f8b');
    expect(TEST_UID).not.toBe(UID_PLACEHOLDER);
  });

  it('测试账号 uid 还是全 0 的占位值（注入假常量）→ 500 misconfigured，不建依赖、不连库、不占限频名额', async () => {
    const s = setup({ testUid: UID_PLACEHOLDER });
    const r = await handle(post(), s.deps);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'misconfigured' });
    expect(s.made).toEqual([]);
    expect(s.guarded).toEqual([]);
    expect(s.deps.limiter.last).toBeNull();
  });

  it('缺连接串（建依赖抛错，错误里带连接串）→ 500 misconfigured，响应里没有原文', async () => {
    const s = setup({ makeThrows: true });
    const { status, text } = await run(s);
    expect(status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: 'misconfigured' });
    expectNoLeak(text);
  });
});

describe('db-probe：限频', () => {
  it(`同一个实例 ${COOLDOWN_MS / 1000} 秒内第二次 → 429 带 Retry-After，不连库；过了冷却期照常`, async () => {
    const s = setup();
    expect((await run(s)).status).toBe(200);
    const logged = s.db.log.length;
    s.advance(10_000);
    const r = await handle(post(), s.deps);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('50');
    expect(await r.json()).toEqual({ error: 'busy', retry_after_s: 50 });
    expect(s.db.log.length).toBe(logged);
    expect(s.made.length).toBe(1);
    s.advance(COOLDOWN_MS - 10_000);
    expect((await run(s)).status).toBe(200);
  });

  it('失败的一次也占名额（不能靠连不上的请求刷）', async () => {
    const s = setup({ guard: { throws: Object.assign(new Error('x'), { code: '28P01' }) } });
    expect((await run(s)).status).toBe(200);
    expect((await handle(post(), s.deps)).status).toBe(429);
  });

  it('跨实例的锁拿不到 → 429，不跑任何步骤', async () => {
    const s = setup({ guard: 'busy' });
    const r = await handle(post(), s.deps);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('30');
    expect(s.db.log).toEqual([]);
    expect(s.db.opened).toEqual([]);
  });
});

describe('db-probe：P6 各项', () => {
  it('全部正常：ok，checks 必过项全为 true；withUser 读到 A 的 2 行、别人 0 行；withScan 读到队列 3 行 2 个用户、notes 0 行；下一个事务不串', async () => {
    const s = setup();
    const { status, body, text } = await run(s);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.region).toBe('ap-northeast-2');
    expect(body.instance).toEqual({ id: 'abc123abc123', age_s: 5 });
    expect(body.checks).toEqual({
      login_fn_ai_ref: true,
      tls_require: true,
      with_user: true,
      with_scan: true,
      next_tx_isolated: true,
      tls_ca: false, // 没放证书
    });
    expect(body.config).toEqual({
      url_present: true,
      user_is_fn_ai_ref: true,
      host_is_pooler: true,
      port_6543: true,
      sslmode_require: true,
      has_password: true,
      lemo_probe_present: false,
    });
    expect(body.user_read).toMatchObject({ ok: true, current_user_ok: true, uid_set: true, notes: 2, other_users_notes: 0 });
    expect(body.scan_read).toMatchObject({ ok: true, current_user_ok: true, uid_empty: true, queue_rows: 3, queue_users: 2, notes: 0 });
    expect(body.next_tx).toMatchObject({ ok: true });
    expect((body.next_tx as { rounds: unknown[] }).rounds).toEqual(Array.from({ length: ROUNDS }, () => ({ notes_in: 2, uid_after_empty: true, notes_after: 0 })));
    expect(body.tls_ca).toEqual({ ok: false, code: 'skipped_no_ca', ms: 0 });
    expect(body.plaintext).toEqual({ skipped: true });
    // 自开的连接：只开了 require 那一条，用完关掉；没放证书时不开 ca 那条；没要求时不开 disable 那条
    expect(s.db.opened).toEqual(['require']);
    expect(s.db.ended).toEqual(['require']);
    // 每个自开连接的事务都先设 statement_timeout（和 db.ts 一样）
    const setTimeouts = s.db.log.filter((l) => l.includes("set_config('statement_timeout', '4min', true)")).length;
    expect(setTimeouts).toBe(ROUNDS * 2);
    expectNoLeak(text);
  });

  it('A 没有随手记时 notes 为 0，照样判通过（行数照实报，由人看是不是测到了）', async () => {
    const { body } = await run(setup({ db: { notes: [B], queue: [] } }));
    expect(body.ok).toBe(true);
    expect(body.user_read).toMatchObject({ notes: 0, other_users_notes: 0 });
    expect(body.scan_read).toMatchObject({ queue_rows: 0, queue_users: 0 });
  });

  it('RLS 放错行（看得到别人的 notes）→ with_user、with_scan 不通过，ok = false', async () => {
    const { body } = await run(setup({ db: { rlsBroken: true } }));
    expect(body.ok).toBe(false);
    expect(body.checks.with_user).toBe(false);
    expect(body.checks.with_scan).toBe(false);
    expect(body.user_read).toMatchObject({ other_users_notes: 1 });
  });

  it('app.uid 跨事务串了（下一个事务还读得到 A 的行）→ next_tx_isolated 不通过，ok = false', async () => {
    const { body } = await run(setup({ db: { leak: true } }));
    expect(body.ok).toBe(false);
    expect(body.checks.next_tx_isolated).toBe(false);
    expect((body.next_tx as { rounds: { uid_after_empty: boolean; notes_after: number }[] }).rounds[0]).toEqual({ notes_in: 2, uid_after_empty: false, notes_after: 2 });
  });

  it('连接串格式不对（用户名不是 fn_ai.<ref>、端口不是 6543、没写 sslmode=require）→ 对应的 checks 不通过', async () => {
    const url = urlFacts(`postgresql://fn_ai:${SECRET_PW}@${POOL_HOST}:5432/postgres`).facts;
    const { body, text } = await run(setup({ probe: { url } }));
    expect(body.ok).toBe(false);
    expect(body.checks.login_fn_ai_ref).toBe(false);
    expect(body.checks.tls_require).toBe(false);
    expect(body.config).toMatchObject({ user_is_fn_ai_ref: false, port_6543: false, sslmode_require: false, host_is_pooler: true });
    expectNoLeak(text);
  });

  it('current_user 不是 fn_ai → login、with_user、with_scan 不通过', async () => {
    const { body } = await run(setup({ db: { user: 'postgres' } }));
    expect(body.ok).toBe(false);
    expect(body.checks).toMatchObject({ login_fn_ai_ref: false, with_user: false, with_scan: false });
  });

  it('withUser 登录失败（SQLSTATE 28P01，报错原文带主机名和密码）→ 只报 28P01，原文不进响应', async () => {
    const err = Object.assign(new Error(`password authentication failed for user "fn_ai.${PREVIEW_REF}" at ${POOL_HOST} (${SECRET_PW})`), { code: '28P01' });
    const { body, text } = await run(setup({ db: { fail: { user: err } } }));
    expect(body.ok).toBe(false);
    expect(body.user_read).toMatchObject({ ok: false, code: '28P01' });
    expect(body.checks.login_fn_ai_ref).toBe(false);
    expectNoLeak(text);
  });

  it('拿跨实例锁那一步就连不上 → 200，ok = false，guard 只带错误码，别的步骤不跑', async () => {
    const err = new Error(`connect ECONNREFUSED ${POOL_HOST}:6543 ${SECRET_PW}`);
    const s = setup({ guard: { throws: err } });
    const { status, body, text } = await run(s);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, guard: { ok: false, code: 'network' } });
    expect(s.db.log).toEqual([]);
    expectNoLeak(text);
  });

  it('放了根证书：开 ca 那条连接，报指纹；校验通过 → checks.tls_ca = true', async () => {
    const s = setup({ probe: { caFingerprint: 'ab'.repeat(32) } });
    const { body } = await run(s);
    expect(body.tls_ca).toMatchObject({ ok: true, current_user_ok: true, ca_fingerprint_sha256: 'ab'.repeat(32) });
    expect(body.checks.tls_ca).toBe(true);
    expect(s.db.opened).toEqual(['require', 'ca']);
    expect(s.db.ended).toEqual(['require', 'ca']);
  });

  it('根证书校验不过（Deno 报 UnknownIssuer，Node 报 SELF_SIGNED_CERT_IN_CHAIN）→ tls_ca 不通过、只报码；总的 ok 不受影响（有退路）', async () => {
    const deno = new Error(`invalid peer certificate: UnknownIssuer (${POOL_HOST})`);
    const a = await run(setup({ probe: { caFingerprint: 'cd'.repeat(32) }, db: { fail: { ca: deno } } }));
    expect(a.body.tls_ca).toMatchObject({ ok: false, code: 'tls_cert_untrusted' });
    expect(a.body.ok).toBe(true);
    expectNoLeak(a.text);
    const node = Object.assign(new Error('self signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
    const b = await run(setup({ probe: { caFingerprint: 'cd'.repeat(32) }, db: { fail: { ca: node } } }));
    expect(b.body.tls_ca).toMatchObject({ ok: false, code: 'SELF_SIGNED_CERT_IN_CHAIN' });
  });

  it('plaintext: true（P6 ⑪）：不加密被拒 → rejected，ok 仍为 true；被接受 → rejected = false，ok = false', async () => {
    const refused = Object.assign(new Error('SSL connection is required'), { code: '28000' });
    const a = await run(setup({ db: { fail: { disable: refused } } }), { action: 'run', plaintext: true });
    expect(a.body.plaintext).toMatchObject({ ok: true, rejected: true, inconclusive: false, code: '28000' });
    expect(a.body.ok).toBe(true);
    const s = setup();
    const b = await run(s, { action: 'run', plaintext: true });
    expect(b.body.plaintext).toMatchObject({ ok: false, rejected: false, inconclusive: false });
    expect(b.body.ok).toBe(false);
    expect(s.db.opened).toEqual(['require', 'disable']);
    expect(s.db.ended).toEqual(['require', 'disable']);
  });

  it.each([
    ['SQLSTATE 28P01', Object.assign(new Error('x'), { code: '28P01' })],
    ['认证失败的文字（归成 auth_failed）', new Error('SASL authentication failed')],
  ])('plaintext：%s = 服务器已经走到认证那一步（接受了不加密连接）→ rejected = false，不通过', async (_, err) => {
    const { body } = await run(setup({ db: { fail: { disable: err } } }), { action: 'run', plaintext: true });
    expect(body.plaintext).toMatchObject({ ok: false, rejected: false, inconclusive: false });
    expect(body.ok).toBe(false);
  });

  it.each([
    ['timeout', new Error('connection timed out')],
    ['CONNECT_TIMEOUT', Object.assign(new Error('x'), { code: 'CONNECT_TIMEOUT' })],
  ])('plaintext：%s → 说不清，ok = false、inconclusive = true', async (_, err) => {
    const { body } = await run(setup({ db: { fail: { disable: err } } }), { action: 'run', plaintext: true });
    expect(body.plaintext).toMatchObject({ ok: false, rejected: false, inconclusive: true });
    expect(body.ok).toBe(false);
  });

  it.each([
    ['28000', Object.assign(new Error('x'), { code: '28000' })],
    ['CONNECTION_CLOSED', Object.assign(new Error('x'), { code: 'CONNECTION_CLOSED' })],
  ])('plaintext 白名单：%s → 被拒，rejected = true、ok = true', async (code, err) => {
    const { body } = await run(setup({ db: { fail: { disable: err } } }), { action: 'run', plaintext: true });
    expect(body.plaintext).toMatchObject({ ok: true, rejected: true, inconclusive: false, code });
    expect(body.ok).toBe(true);
  });

  it.each([
    ['XX000（Supavisor 认证失败可能回的通用码）', Object.assign(new Error('x'), { code: 'XX000' }), 'XX000'],
    ['归不了类的报错', new Error('something odd'), 'other'],
  ])('plaintext 白名单外：%s → 不确定，inconclusive = true、ok = false，code 照实带上', async (_, err, code) => {
    const { body } = await run(setup({ db: { fail: { disable: err } } }), { action: 'run', plaintext: true });
    expect(body.plaintext).toMatchObject({ ok: false, rejected: false, inconclusive: true, code });
    expect(body.ok).toBe(false);
  });

  it('connUrl：disable 那条连接串换成随机假密码（不含真密码，其余不变）；require、ca 用原串', () => {
    const hex = 'f'.repeat(64);
    const u = connUrl(FAKE_URL, 'disable', (n) => (n === 32 ? hex : ''));
    expect(u).not.toContain(SECRET_PW);
    expect(new URL(u).password).toBe(hex);
    expect(new URL(u).username).toBe(`fn_ai.${PREVIEW_REF}`);
    expect(new URL(u).host).toBe(`${POOL_HOST}:6543`);
    expect(connUrl(FAKE_URL, 'require', () => hex)).toBe(FAKE_URL);
    expect(connUrl(FAKE_URL, 'ca', () => hex)).toBe(FAKE_URL);
    // index.ts 确实经 connUrl 建连接，三条自开连接都关掉 NOTICE
    const idx = readFileSync(join(ROOT, 'supabase/functions/_preview/db-probe/index.ts'), 'utf8');
    expect(idx).toContain('postgres(connUrl(raw, tls, randomHex), { ssl, ...BASE, onnotice: () => {} })');
  });

  it('LEMO_PROBE 在不在照实报（P6 ⑦）', async () => {
    const { body } = await run(setup({ probe: { lemoProbePresent: true } }));
    expect(body.config.lemo_probe_present).toBe(true);
  });

  it(`超总预算（${TOTAL_BUDGET_MS / 1000} 秒）：卡住的那步报 deadline，后面的报 skipped_deadline；自开的连接被关掉`, async () => {
    vi.useFakeTimers({ now: T0 });
    const s = setup({ db: { hang: { require: true } }, probe: { caFingerprint: 'ab'.repeat(32) } });
    const p = run(s, { action: 'run', plaintext: true });
    await vi.advanceTimersByTimeAsync(TOTAL_BUDGET_MS + 1);
    const { body } = await p;
    expect(body.ok).toBe(false);
    expect(body.user_read).toMatchObject({ ok: true });
    expect(body.next_tx).toMatchObject({ ok: false, code: 'deadline' });
    expect(body.tls_ca).toMatchObject({ ok: false, code: 'skipped_deadline' });
    expect(body.plaintext).toMatchObject({ ok: false, rejected: false, inconclusive: true, code: 'skipped_deadline' });
    expect(s.db.opened).toEqual(['require']);
    expect(s.db.ended).toContain('require');
  });
});

describe('db-probe：纯函数', () => {
  it('urlFacts 只给布尔值；解析不了的串 present = true、其余 false', () => {
    const { facts, host } = urlFacts(FAKE_URL);
    expect(facts).toEqual({ present: true, userIsFnAiRef: true, hostIsPooler: true, port6543: true, sslmodeRequire: true, hasPassword: true });
    expect(host).toBe(POOL_HOST);
    expect(urlFacts(undefined).facts.present).toBe(false);
    expect(urlFacts('not a url').facts).toEqual({ present: true, userIsFnAiRef: false, hostIsPooler: false, port6543: false, sslmodeRequire: false, hasPassword: false });
    // 用户名是 postgres.<ref>（没换成 fn 角色）
    expect(urlFacts(FAKE_URL.replace('fn_ai.', 'postgres.')).facts.userIsFnAiRef).toBe(false);
  });

  it('errCode：SQLSTATE、大写错误码原样；其余按文字归类，原文不留', () => {
    expect(errCode(Object.assign(new Error('x'), { code: '42501' }))).toBe('42501');
    expect(errCode(Object.assign(new Error('x'), { code: 'CONNECT_TIMEOUT' }))).toBe('CONNECT_TIMEOUT');
    expect(errCode(Object.assign(new Error('x'), { code: 'lower case' }))).toBe('other');
    expect(errCode(new Error('invalid peer certificate: UnknownIssuer'))).toBe('tls_cert_untrusted');
    expect(errCode(new Error('invalid peer certificate: NotValidForName'))).toBe('tls_name_mismatch');
    expect(errCode(new Error('SSL routines::wrong version number'))).toBe('tls_other');
    expect(errCode(new Error('write CONNECT_TIMEOUT host:6543 timed out'))).toBe('timeout');
    expect(errCode(new Error('SASL authentication failed'))).toBe('auth_failed');
    expect(errCode(new Error('Connection refused (os error 111)'))).toBe('network');
    expect(errCode('deadline')).toBe('deadline');
    expect(errCode(null)).toBe('other');
  });

  it('caFingerprint：对 DER 求 SHA-256；不是证书格式回 null', async () => {
    const der = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7) % 256));
    const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
    const pem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
    expect(await caFingerprint(pem)).toBe(createHash('sha256').update(der).digest('hex'));
    expect(await caFingerprint('')).toBeNull();
    expect(await caFingerprint('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----')).toBeNull();
  });
});

describe('db-probe：和 _shared/db.ts、仓库其他地方对得上', () => {
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

  it('自开连接的参数和 _shared/db.ts 的 connect() 一样（只换 ssl）', () => {
    expect(read('supabase/functions/_shared/db.ts')).toContain("postgres(url, { ssl: 'require', prepare: false, max: 1, connect_timeout: 10, idle_timeout: 5 })");
    const idx = read('supabase/functions/_preview/db-probe/index.ts');
    expect(idx).toContain('const BASE = { prepare: false, max: 1, connect_timeout: 10, idle_timeout: 5 } as const;');
    // withUser / withScan 一律经 _shared/db.ts、只用 fn_ai
    expect(idx).toContain("withUser('fn_ai', uid,");
    expect(idx).toContain("withScan('fn_ai',");
    expect(idx).not.toMatch(/fn_vault|FN_VAULT_DB_URL|SUPABASE_DB_URL|console\./);
  });

  it('db-probe 的源码里不打印任何东西', () => {
    for (const f of ['index.ts', 'handler.ts', 'probe.ts', 'ca.ts']) {
      expect(read(`supabase/functions/_preview/db-probe/${f}`), f).not.toMatch(/console\.|Deno\.stdout|Deno\.stderr/);
    }
  });

  it('ca.ts 要么为空，要么是一张完整的证书（不准放私钥）', () => {
    const ca = read('supabase/functions/_preview/db-probe/ca.ts');
    expect(ca).not.toMatch(/PRIVATE KEY/);
    const m = ca.match(/SUPABASE_ROOT_CA_PEM = `([\s\S]*)`;/);
    expect(m).not.toBeNull();
    const pem = (m?.[1] ?? '').trim();
    if (pem) expect(pem).toMatch(/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/);
  });
});
