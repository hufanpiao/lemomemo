// account {action: 'rebind_device'}（B5 任务单 S3；TC-B1-84 服务器一半、85 ①～⑤、86、93；⑩ 的静态检查在 tests/build/account-rebind-rpc.test.ts（这里的 tsconfig 没有 node 类型）；代定 D9 低版本 426）。
// authenticate 按 Authorization 里的令牌查表：新会话 S2 = A 的 s2，old_token 按名字对应 A 的 s1、B 的 s1、A 的 s2 等。
import { describe, expect, it } from 'vitest';
import { type AuthResult, handle, REBIND_DAILY_LIMIT } from '../../supabase/functions/account/core.ts';
import { A, accountDeps, accountReq, accountSetup, B, DAY, type FakeDb, jwtWith } from './account-fakes.ts';

const DEV = '0d0d0d0d-0000-4000-8000-000000000001';
const S1 = `${A.slice(0, 8)}-s1`;
const S2 = `${A.slice(0, 8)}-s2`;
const OLD = 'old-token-A-s1-0123456789';   // 这台设备原来那个会话的 access token（测试用的假串）
const TOKENS: Record<string, { user: string; session: string } | 'try_later'> = {
  x: { user: A, session: S2 },
  [OLD]: { user: A, session: S1 },
  'old-token-B-s1-0123456789': { user: B, session: `${B.slice(0, 8)}-s1` },
  'old-token-A-s2-0123456789': { user: A, session: S2 },
  'old-token-gone-0123456789': { user: A, session: 'nope' },
  'old-token-busy-0123456789': 'try_later',
};

function setup() {
  const s = accountSetup();
  s.db.devices.set(DEV, { user_id: A, label: 'iPhone', session_id: S1 });
  return s;
}

async function rebind(db: FakeDb, body: Record<string, unknown> = {}, opt: { otpAgoS?: number; version?: Response | null } = {}) {
  const jwt = jwtWith([{ method: 'otp', timestamp: Math.floor(db.clock.ms / 1000) - (opt.otpAgoS ?? 60) }]);
  const authenticate = async (req: Request): Promise<AuthResult> => {
    const t = TOKENS[(req.headers.get('authorization') ?? '').replace(/^Bearer /, '')];
    const deny = (code: string, status: number) => ({ ok: false as const, code, response: new Response(JSON.stringify({ error: code }), { status }) });
    if (t === undefined) return deny('session_revoked', 401);
    if (t === 'try_later') return deny('try_later', 503);
    if (!db.sessions.has(t.session) || db.revoked.has(t.session)) return deny('session_revoked', 401);
    return { ok: true, user: { userId: t.user, sessionId: t.session, jwt } };
  };
  const deps = accountDeps(db, [], { authenticate, checkVersion: async () => opt.version ?? null });
  const r = await handle(accountReq({ action: 'rebind_device', device_id: DEV, old_token: OLD, ...body }), deps);
  return { status: r.status, text: await r.text() };
}
const code = (r: { text: string }) => (JSON.parse(r.text) as { error?: string }).error;

describe('rebind_device', () => {
  it('TC-B1-84：成功把 devices 行换到新会话、吊销旧会话', async () => {
    const { db } = setup();
    const r = await rebind(db);
    expect([r.status, r.text]).toEqual([200, '{"ok":true}']);
    expect(db.devices.get(DEV)?.session_id).toBe(S2);
    expect(db.revoked.has(S1)).toBe(true);
  });

  it('TC-B1-85 ①～⑤：S1 吊销、别人的 S1、同一个会话、设备不对、otp 过期；一律 rebind_failed 或 reauth_required，D 行不变', async () => {
    const cases: [string, Record<string, unknown>, { otpAgoS?: number }, number, string][] = [
      ['① S1 已吊销', { old_token: 'old-token-gone-0123456789' }, {}, 409, 'rebind_failed'],
      ['② B 的 S1', { old_token: 'old-token-B-s1-0123456789' }, {}, 409, 'rebind_failed'],
      ['③ S1 = S2', { old_token: 'old-token-A-s2-0123456789' }, {}, 409, 'rebind_failed'],
      ['④ 别的设备', { device_id: '0d0d0d0d-0000-4000-8000-000000000009' }, {}, 409, 'rebind_failed'],
      ['⑤ otp 超过 10 分钟', {}, { otpAgoS: 601 }, 401, 'reauth_required'],
    ];
    for (const [name, body, opt, status, c] of cases) {
      const { db } = setup();
      const r = await rebind(db, body, opt);
      expect([r.status, code(r)], name).toEqual([status, c]);
      expect(db.devices.get(DEV)?.session_id, name).toBe(S1);
      expect(db.revoked.has(S1), name).toBe(false);
    }
  });

  it('TC-B1-86：rpc 抛错回 try_later、被拒回 rebind_failed，D 行都不变；旧令牌验证时服务忙回 503', async () => {
    let { db } = setup();
    db.fail.add('rebindDevice');
    let r = await rebind(db);
    expect([r.status, code(r)]).toEqual([503, 'try_later']);
    expect(db.devices.get(DEV)?.session_id).toBe(S1);
    ({ db } = setup());
    db.devices.set('0d0d0d0d-0000-4000-8000-000000000002', { user_id: A, label: null, session_id: S2 });   // S2 已占着别的设备行
    r = await rebind(db);
    expect([r.status, code(r)]).toEqual([409, 'rebind_failed']);
    expect(db.devices.get(DEV)?.session_id).toBe(S1);
    ({ db } = setup());
    r = await rebind(db, { old_token: 'old-token-busy-0123456789' });
    expect([r.status, code(r)]).toEqual([503, 'try_later']);
  });

  it('TC-B1-93：每天 10 次（失败的也算），第 11 次 429 且不调 rpc；跨 UTC 日重新计数；old_token 不进日志和响应', async () => {
    const { db } = setup();
    for (let i = 0; i < REBIND_DAILY_LIMIT; i++) await rebind(db, { old_token: 'old-token-B-s1-0123456789' });
    const calls = db.rebindCalls;
    const r = await rebind(db);
    expect([r.status, code(r)]).toEqual([429, 'rate_limited']);
    expect(db.rebindCalls).toBe(calls);
    db.clock.advance(DAY);
    expect((await rebind(db)).status).toBe(200);
    expect(JSON.stringify(db.logs)).not.toContain('old-token');
    expect(r.text).not.toContain('old-token');
  });

  it('正文不对 400；低版本 426（D9：account 免查，这个动作自己查），什么都不做', async () => {
    const { db } = setup();
    for (const body of [{ device_id: 'x' }, { old_token: 'short' }, { old_token: 7 }]) expect((await rebind(db, body)).status).toBe(400);
    const r = await rebind(db, {}, { version: new Response('{"error":"upgrade_required"}', { status: 426 }) });
    expect(r.status).toBe(426);
    expect(db.rebindCalls).toBe(0);
    expect(db.devices.get(DEV)?.session_id).toBe(S1);
  });
});
