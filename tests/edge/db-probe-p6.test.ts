// db-probe 的 P6 各项（B1 第九批从 db-probe.test.ts 拆出）：各步骤按假数据库的结果如实判通过 / 不通过
// （RLS 放错行、app.uid 跨事务串、TLS 校验失败、不加密被接受都判不通过）、超总预算报 deadline 并关掉自开的连接。
// 假数据库和共用小工具在 db-probe-harness.ts；每条用例后还原真计时器的 afterEach 也在那里注册（引入它就生效）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { connUrl, PREVIEW_REF, ROUNDS, TOTAL_BUDGET_MS, urlFacts } from '../../supabase/functions/_preview/db-probe/probe.ts';
import { ROOT, B, T0, SECRET_PW, POOL_HOST, FAKE_URL, setup, run, expectNoLeak } from './db-probe-harness.ts';

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
