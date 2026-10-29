// 函数侧版本门（B1 K10；架构第 6 节、0.27 第 1 点、0.31 第 13 条、0.38 第 47 条）：
// ① supabase/functions/_shared/version-gate-core.ts 本身（426 的格式、版本解析、缓存、超时、读失败放行、免查方法）；
// ② 和转发层 functions/sb/version-gate.ts 同一口径：同一份免查名单（shared/version-gate-list.ts），同样的版本得出同样的结论；
// ③ 低版本客户端逐个函数：旧版本请求 → 426（免查的除外），新版本 → 照常处理。
//    account、account-purge、usage-report 只收 POST、函数侧免 POST，所以实际不查：直接调 handle，非 POST 是 405；
//    invite-signup 的版本门在 core.ts 里（Turnstile、限流之后），直接调它的 handle；读配置经 minClientVersion 的缓存和超时（0.38 第 52 条）。
// supabase/functions/ 下每个函数都标了“查”或“免”的核对在 tests/build/fn-version-gate-coverage.test.ts（要读目录，归 Node 类型）。
import { describe, expect, it, vi } from 'vitest';
import {
  blockedMin, compareTriple, createFnVersionGate, fnNeedsVersionCheck, parseClientVersion, upgradeRequiredResponse,
  type LoadMin,
} from '../../supabase/functions/_shared/version-gate-core.ts';
import { FUNCTION_VERSION_EXEMPTIONS, isFunctionExempt } from '../../shared/version-gate-list.ts';
import {
  EXEMPT_FUNCTIONS, compareTriple as proxyCompare, needsVersionCheck, createVersionGate, parseClientVersion as proxyParse, upgradeRequiredResponse as proxy426,
} from '../../functions/sb/version-gate.ts';
import { handle as accountHandle } from '../../supabase/functions/account/core.ts';
import { handle as purgeHandle, type R2 } from '../../supabase/functions/account-purge/core.ts';
import { handle as usageHandle } from '../../supabase/functions/usage-report/core.ts';
import { handle as inviteHandle, type Deps as InviteDeps, type Store as InviteStore } from '../../supabase/functions/invite-signup/core.ts';
import { accountDeps, Clock, FakeBackups, FakeDb, A, CRON, purgeDeps, type Outbox } from './account-fakes.ts';

const MIN = '4.1.0';
const OLD = '4.0.9';
const NEW = '4.1.0';
const minOf = (v: unknown): LoadMin => async () => v;

function req(fn: string, method: string, version: string | null, extra: Record<string, string> = {}, body: unknown = {}): Request {
  const headers = new Headers({ 'content-type': 'application/json', ...extra });
  if (version !== null) headers.set('x-app-version', version);
  const init: RequestInit = method === 'GET' || method === 'HEAD' ? { method, headers } : { method, headers, body: JSON.stringify(body) };
  return new Request(`https://x.supabase.co/functions/v1/${fn}`, init);
}

function gate(over: Partial<Parameters<typeof createFnVersionGate>[0]> = {}) {
  return createFnVersionGate({ exemptions: FUNCTION_VERSION_EXEMPTIONS, ...over });
}

describe('426 的格式和转发层一致', () => {
  it('状态码、响应体、Content-Type、Cache-Control、三个安全头一样', async () => {
    const a = upgradeRequiredResponse(MIN);
    const b = proxy426(MIN);
    expect(a.status).toBe(426);
    expect(b.status).toBe(426);
    expect(await a.json()).toEqual({ code: 'upgrade_required', min: MIN });
    expect(await b.json()).toEqual({ code: 'upgrade_required', min: MIN });
    for (const h of ['content-type', 'cache-control', 'x-content-type-options', 'content-security-policy', 'referrer-policy']) {
      expect(a.headers.get(h), h).toBe(b.headers.get(h));
    }
  });
});

describe('版本比较和转发层同一口径', () => {
  const versions = [null, '', 'abc', '4', '4.1', '4.0.9', '4.1.0', '4.1.0-preview.3', '4.1.0+build.7', ' 4.1.0 ', '4.0.99', '4.10.0',
    '5.0.0', '10.0.0', '04.1.0', '4.1.0.1', '1234567.0.0', 'v4.1.0', '4.1.-1'];
  const mins: unknown[] = ['4.1.0', '0.0.0', '4.0.10', null, 'bad', '4.1.0-preview.1', 41];

  it.each(versions.map((v) => [v]))('客户端 %j：解析结果相同', (v) => {
    expect(parseClientVersion(v)).toEqual(proxyParse(v));
  });

  it('同样的 min、同样的版本头：两道检查挡或放一致（含读不到配置、格式不对放行）', async () => {
    for (const min of mins) {
      for (const v of versions) {
        const headers = new Headers();
        if (v !== null) headers.set('x-app-version', v);
        const proxy = await createVersionGate({ loadMin: async () => min }).check('POST', '/functions/v1/invite-signup', headers);
        const fn = await gate().check('invite-signup', req('invite-signup', 'POST', v), minOf(min));
        expect(fn === null ? 'pass' : 'block', `min=${String(min)} v=${String(v)}`).toBe(proxy.action);
        expect(blockedMin(min, v) === null ? 'pass' : 'block').toBe(proxy.action);
      }
    }
  });

  it('compareTriple 一致', () => {
    const t: [number, number, number][] = [[4, 1, 0], [4, 0, 9], [4, 1, 1], [5, 0, 0], [4, 1, 0]];
    for (const a of t) for (const b of t) expect(compareTriple(a, b)).toBe(proxyCompare(a, b));
  });
});

describe('免查名单：同一份来源', () => {
  it('转发层的 EXEMPT_FUNCTIONS 就是共用名单里 caller = client 的几项', () => {
    const client = FUNCTION_VERSION_EXEMPTIONS.filter((f) => f.caller === 'client');
    expect(EXEMPT_FUNCTIONS.map((f) => ({ name: f.name, methods: [...f.methods] })))
      .toEqual(client.map((f) => ({ name: f.name, methods: [...f.methods] })));
  });

  it('0.38 第 47 条：account 只免 POST；account-purge、usage-report 只免 POST（服务器调用）；invite-signup 不免', () => {
    const plan = FUNCTION_VERSION_EXEMPTIONS.map((f) => [f.name, [...f.methods], f.caller]);
    expect(plan).toEqual([
      ['account', ['POST'], 'client'],
      ['account-purge', ['POST'], 'server'],
      ['usage-report', ['POST'], 'server'],
    ]);
    expect(isFunctionExempt(FUNCTION_VERSION_EXEMPTIONS, 'invite-signup', 'POST')).toBe(false);
  });

  it('函数侧判断：OPTIONS 不查；名单里的方法不查；其余方法、名单外的函数一律查', () => {
    const ex = FUNCTION_VERSION_EXEMPTIONS;
    expect(fnNeedsVersionCheck(ex, 'account', 'POST')).toBe(false);
    expect(fnNeedsVersionCheck(ex, 'account', 'post')).toBe(false);
    for (const m of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']) expect(fnNeedsVersionCheck(ex, 'account', m), m).toBe(true);
    expect(fnNeedsVersionCheck(ex, 'account', 'OPTIONS')).toBe(false);
    expect(fnNeedsVersionCheck(ex, 'invite-signup', 'POST')).toBe(true);
    expect(fnNeedsVersionCheck(ex, 'no-such-fn', 'POST')).toBe(true);
    expect(fnNeedsVersionCheck([{ name: 'x', methods: ['*'] }], 'x', 'DELETE')).toBe(false);
  });
});

describe('缓存、超时、读失败（口径同转发层：读失败放行并缓存 10 秒）', () => {
  function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it('读成功缓存 60 秒；到期后重读', async () => {
    const c = clock();
    const g = gate({ now: c.now });
    const load = vi.fn(async () => MIN);
    expect((await g.check('invite-signup', req('invite-signup', 'POST', OLD), load))?.status).toBe(426);
    c.advance(59_999);
    expect(await g.check('invite-signup', req('invite-signup', 'POST', NEW), load)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    c.advance(1);
    await g.check('invite-signup', req('invite-signup', 'POST', NEW), load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('读失败、读到格式不对的值：放行，只记错误码，失败结果缓存 10 秒', async () => {
    const c = clock();
    const logs: string[] = [];
    const g = gate({ now: c.now, log: (x) => logs.push(x) });
    const load = vi.fn(async () => { throw new Error('db down https://secret.example'); });
    expect(await g.check('invite-signup', req('invite-signup', 'POST', '1.0.0'), load)).toBeNull();
    expect(await g.check('invite-signup', req('invite-signup', 'POST', null), load)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(g.peek()?.min).toBeNull();
    expect(logs).toEqual(['gate_config_error']);
    c.advance(10_000);
    const bad = vi.fn(async () => '4.1');
    expect(await g.check('invite-signup', req('invite-signup', 'POST', '1.0.0'), bad)).toBeNull();
    expect(logs).toEqual(['gate_config_error', 'gate_config_bad']);
  });

  it('读配置超过 1.5 秒：中止、放行、记 gate_config_timeout', async () => {
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      const g = gate({ log: (x) => logs.push(x) });
      let aborted = false;
      const hang: LoadMin = (signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; });
        void resolve;
      });
      const p = g.check('invite-signup', req('invite-signup', 'POST', '1.0.0'), hang);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await p).toBeNull();
      expect(aborted).toBe(true);
      expect(logs).toEqual(['gate_config_timeout']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('并发的请求只读一次配置', async () => {
    const g = gate();
    let release: (v: string) => void = () => {};
    const load = vi.fn(() => new Promise<string>((r) => { release = r; }));
    const ps = [1, 2, 3].map(() => g.check('invite-signup', req('invite-signup', 'POST', OLD), load));
    release(MIN);
    const out = await Promise.all(ps);
    expect(out.map((r) => r?.status)).toEqual([426, 426, 426]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('免查的请求不读配置', async () => {
    const g = gate();
    const load = vi.fn(async () => MIN);
    expect(await g.check('account', req('account', 'POST', OLD), load)).toBeNull();
    expect(await g.check('account-purge', req('account-purge', 'POST', null), load)).toBeNull();
    expect(await g.check('invite-signup', req('invite-signup', 'OPTIONS', null), load)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});

// ---------------- ③ 低版本客户端，逐个函数 ----------------
// account、account-purge、usage-report：只收 POST，函数侧免 POST，所以实际不查（index.ts 不接 versionGate，主持人定 (b)）。
// 下面直接调各自的 handle，和线上一致：旧版本 POST 照常处理，其他方法由 handle 回 405（经 /sb 时转发层对非 POST 照查、回 426）。

describe('account（0.38 第 47 条：只免 POST；只收 POST、函数侧免 POST，所以实际不查）', () => {
  function setup() {
    const db = new FakeDb(new Clock());
    db.addUser(A, 'a@test.local');
    const box: Outbox[] = [];
    const deps = accountDeps(db, box);
    return { db, deps, call: (r: Request) => accountHandle(r, deps) };
  }

  it('旧版本、没带版本头 POST：照常处理（注销申请成功）', async () => {
    for (const v of [OLD, null, '1.0.0']) {
      const { db, deps, call } = setup();
      const res = await call(req('account', 'POST', v, { authorization: 'Bearer x' }, { action: 'delete', confirm: '注销' }));
      await Promise.all(deps.bg);
      expect(res.status, String(v)).toBe(200);
      expect(db.pending.has(A)).toBe(true);
    }
  });

  it('新版本 POST：照常处理', async () => {
    const { call } = setup();
    const res = await call(req('account', 'POST', NEW, { authorization: 'Bearer x' }, { action: 'delete', confirm: '注销' }));
    expect(res.status).toBe(200);
  });

  it('其他方法：函数里回 405（新旧版本一样）；经 /sb 时转发层对旧版本回 426', async () => {
    const { call } = setup();
    for (const m of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      for (const v of [OLD, NEW]) expect((await call(req('account', m, v, { authorization: 'Bearer x' }))).status, `${m} ${v}`).toBe(405);
      expect(needsVersionCheck(m, '/functions/v1/account'), m).toBe(true);
    }
  });
});

describe('account-purge（服务器调用；只收 POST、函数侧免 POST，所以实际不查；免查不等于放开：没有 x-cron-secret 照样 401）', () => {
  const r2: R2 = { deletePrefix: async () => ({ deleted: 0 }) };
  function setup() {
    const db = new FakeDb(new Clock());
    const deps = purgeDeps(db, r2, new FakeBackups(), []);
    return (r: Request) => purgeHandle(r, deps);
  }

  it('不带版本头、旧版本、新版本 + 正确的 x-cron-secret：照常跑（200）', async () => {
    for (const v of [null, OLD, NEW]) {
      const res = await setup()(req('account-purge', 'POST', v, { 'x-cron-secret': CRON }));
      expect(res.status, String(v)).toBe(200);
    }
  });

  it('免查只免版本：不带或带错 x-cron-secret 一律 401，带上新版本号也一样', async () => {
    for (const v of [null, OLD, NEW]) {
      expect((await setup()(req('account-purge', 'POST', v))).status).toBe(401);
      expect((await setup()(req('account-purge', 'POST', v, { 'x-cron-secret': 'wrong' }))).status).toBe(401);
    }
  });

  it('其他方法：405', async () => {
    expect((await setup()(req('account-purge', 'GET', OLD, { 'x-cron-secret': CRON }))).status).toBe(405);
  });
});

describe('usage-report（服务器调用；只收 POST、函数侧免 POST，所以实际不查）', () => {
  const SECRET = 'test-ops-secret-xxxxxxxxxxxxxxxxxxxxxx';
  const call = () => (r: Request) => usageHandle(r, {
    opsSecret: SECRET,
    db: { heartbeats: async () => [], pendingDeletions: async () => [], longTxCount: async () => 0 },
    now: () => Date.parse('2026-10-29T12:00:00Z'),
  });

  it('不带版本头、旧版本、新版本 + 正确的 x-ops-secret：照常处理（200）；没带密钥 401', async () => {
    for (const v of [null, OLD, NEW]) {
      expect((await call()(req('usage-report', 'POST', v, { 'x-ops-secret': SECRET }, { part: 'heartbeat' }))).status, String(v)).toBe(200);
      expect((await call()(req('usage-report', 'POST', v, {}, { part: 'heartbeat' }))).status).toBe(401);
    }
  });

  it('其他方法：405', async () => {
    expect((await call()(req('usage-report', 'GET', OLD, { 'x-ops-secret': SECRET }))).status).toBe(405);
  });
});

describe('invite-signup（要查；版本门在 core.ts 的 Turnstile、限流之后）', () => {
  const PROXY = 'test-proxy-secret';
  function deps(min: string | null): InviteDeps {
    const store: InviteStore = {
      takeRate: async () => true, getInvite: async () => null, casInviteUsed: async () => false, putPending: async () => {},
      getPending: async () => null, casPendingTries: async () => false, deletePending: async () => {}, insertProfile: async () => {},
      minClientVersion: async () => min,
    };
    return {
      store,
      auth: { createUser: async () => ({ ok: false, exists: false }), deleteUser: async () => {}, magiclinkTokenHash: async () => null },
      env: 'prod', verifyTurnstile: async () => ({ success: true, hostname: 'lemomemo.com', action: 'invite_start' }),
      sendMail: async () => true, hashSecret: 'test-hash-secret', proxySecret: PROXY, configured: true,
      now: () => Date.parse('2026-10-29T12:00:00Z'),
    };
  }
  const start = { step: 'start', email: 'a@example.com', code: 'ABCD2345EFGH', captchaToken: 'ok-token', locale: 'zh-CN' };
  const verify = { step: 'verify', email: 'a@example.com', code: 'ABCD2345EFGH', email_otp: '123456' };
  const proxied = { 'x-proxy-secret': PROXY, 'x-client-ip': '203.0.113.7' };

  it('旧版本、没带版本头：start、verify 都回 426', async () => {
    for (const v of [OLD, null]) {
      for (const body of [start, verify]) {
        const res = await inviteHandle(req('invite-signup', 'POST', v, proxied, body), deps(MIN));
        expect(res.status, `${String(v)} ${body.step}`).toBe(426);
        expect(await res.json()).toEqual({ code: 'upgrade_required', min: MIN });
      }
    }
  });

  it('0.38 第 52 条：读配置挂起超过 1.5 秒放行（经 minClientVersion 缓存读；记 gate_config_timeout，10 秒内不再读）', async () => {
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      const g = gate({ log: (x) => logs.push(x) });
      let aborted = false;
      const hang = vi.fn<LoadMin>((signal) => new Promise<unknown>(() => {
        signal.addEventListener('abort', () => { aborted = true; });
      }));
      const d = deps(null);
      d.store.minClientVersion = () => g.minClientVersion(hang);
      const p = inviteHandle(req('invite-signup', 'POST', OLD, proxied, start), d);
      // Turnstile、HMAC 是真的异步：等走到读配置这一步再推进时钟（waitUntil 在假计时器下也会推进时钟，1.5 秒的边界见上面“读配置超过 1.5 秒”那条）
      await vi.waitUntil(() => hang.mock.calls.length > 0);
      await vi.advanceTimersByTimeAsync(1500);
      const res = await p;
      expect(res.status).toBe(200);
      expect(aborted).toBe(true);
      expect(logs).toEqual(['gate_config_timeout']);
      expect((await inviteHandle(req('invite-signup', 'POST', OLD, proxied, start), d)).status).toBe(200);
      expect(hang).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('经 minClientVersion 缓存读：读到 min 后旧版本 426、60 秒内不再读', async () => {
    const g = gate();
    const load = vi.fn<LoadMin>(async () => MIN);
    const d = deps(null);
    d.store.minClientVersion = () => g.minClientVersion(load);
    expect((await inviteHandle(req('invite-signup', 'POST', OLD, proxied, start), d)).status).toBe(426);
    expect((await inviteHandle(req('invite-signup', 'POST', NEW, proxied, start), d)).status).toBe(200);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('新版本：照常处理（start 回 {ok}；verify 没有待验证记录回 400 code_wrong）', async () => {
    const s = await inviteHandle(req('invite-signup', 'POST', NEW, proxied, start), deps(MIN));
    expect(s.status).toBe(200);
    const v = await inviteHandle(req('invite-signup', 'POST', NEW, proxied, verify), deps(MIN));
    expect(v.status).toBe(400);
  });
});
