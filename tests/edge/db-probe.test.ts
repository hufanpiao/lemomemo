// db-probe（预览专用、一次性的数据库探测函数；supabase/functions/_preview/db-probe/，说明见 docs/09-路线图/B0-P6数据库探测函数.md）
// 证明：只在预览项目生效；过期回 410；只收 POST 和固定格式的请求体；限频（同实例冷却 + 跨实例锁）；
// 各步骤按假数据库的结果如实判通过 / 不通过（RLS 放错行、app.uid 跨事务串、TLS 校验失败、不加密被接受都判不通过）；
// 超总预算报 deadline 并关掉自开的连接；响应里不回显连接串、密码、主机名、报错原文。
// index.ts 要 Deno 和 npm:postgres，这里不测；它和 _shared/db.ts 的连接参数是否一致，在最后一组用文本核对。
// P6 各项在 db-probe-p6.test.ts（B1 第九批按主题拆开）；假数据库和共用小工具在 db-probe-harness.ts，
// 每条用例后还原真计时器的 afterEach 也在 db-probe-harness.ts 里注册（引入它就生效）。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COOLDOWN_MS, EXPIRES_AT, handle, isPreview } from '../../supabase/functions/_preview/db-probe/handler.ts';
import { caFingerprint, errCode, PREVIEW_REF, TEST_UID, UID_PLACEHOLDER, urlFacts } from '../../supabase/functions/_preview/db-probe/probe.ts';
import { ROOT, A, B, PREVIEW_URL, POOL_HOST, FAKE_URL, setup, post, run, expectNoLeak } from './db-probe-harness.ts';

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
    // withUser / withScan 一律经 _shared/db.ts、只用 fn_ai（角色写死在导出名里，B1 接手清单 S3 复审必改）
    expect(idx).toContain('withAiUser(uid,');
    expect(idx).toContain('withAiScan(');
    expect(idx).not.toMatch(/withVault/);
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
