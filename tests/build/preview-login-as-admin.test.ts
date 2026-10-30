// tools/e2e/preview-login.ts 的 --as-admin（管理员账号登录的唯一例外；负责人 10-30 定“只给指定的那一个开例外”，TC75-admin 第二轮）：
// 邮箱必须和 E2E_ADMIN_EMAIL 一字不差、E2E_ADMIN_EMAIL 本身是 .test、不在 PREVIEW_OWNER_EMAILS、private.admins 里恰好只有这一个；
// 任何一条不满足都在调 generateLink 之前报错；不带 --as-admin 时管理员照旧一律拒。用假客户端，不连预览库、不用真密钥
import { describe, expect, it } from 'vitest';
import { main, prepareLogin, PREVIEW_REF } from '../../tools/e2e/preview-login.ts';
import { ADMIN_ID, FAKE_KEY, fakeClient, type FakeOpts, LINK, OTP, rejects } from './preview-login-fakes.ts';

const ADMIN = 'e2e-admin@lemomemo.test';
const OWNER_TEST = 'owner-accept@lemomemo.test';
const OWNERS = `owner.real@gmail.com, ${OWNER_TEST}`;

function prepAs(email: string, opts: FakeOpts, adminEmailVar: string | undefined, ownerEmails = OWNERS) {
  const f = fakeClient(opts);
  const masked: string[] = [];
  const run = prepareLogin({ email, client: f.client, ownerEmails, mask: (s) => masked.push(s), asAdmin: { adminEmailVar } });
  return { ...f, masked, run };
}

describe('prepareLogin 的管理员例外（asAdmin）', () => {
  it('正例：邮箱和 E2E_ADMIN_EMAIL 一字不差、admins 里只有它 → 签发，验证码、链接、hashed_token 都先 mask', async () => {
    const { run, calls, masked } = prepAs(ADMIN, {}, ADMIN);
    expect(await run).toEqual({ email: ADMIN, emailOtp: OTP });
    expect(calls.generate).toEqual([ADMIN]);
    expect(masked).toEqual([OTP, LINK, 'hash-abc']);
  });

  it('不带 asAdmin：同一个管理员邮箱照旧报 admin_email、不调 generateLink（默认行为不变）', async () => {
    const f = fakeClient();
    const e = await rejects(prepareLogin({ email: ADMIN, client: f.client, ownerEmails: OWNERS, mask: () => {} }));
    expect(e.code).toBe('admin_email');
    expect(f.calls.generate).toEqual([]);
  });

  // [说明, 传入邮箱, E2E_ADMIN_EMAIL, 假客户端选项, 期望错误码, 是否在读远端之前就拒]
  const REVERSE: [string, string, string | undefined, FakeOpts, string, boolean][] = [
    ['E2E_ADMIN_EMAIL 没设', ADMIN, undefined, {}, 'bad_admin_var', true],
    ['E2E_ADMIN_EMAIL 是空串', ADMIN, '', {}, 'bad_admin_var', true],
    ['E2E_ADMIN_EMAIL 是真实邮箱', 'boss@gmail.com', 'boss@gmail.com', {}, 'bad_admin_var', true],
    ['E2E_ADMIN_EMAIL 是伪装的 .test', `${ADMIN}.evil.com`, `${ADMIN}.evil.com`, {}, 'bad_admin_var', true],
    ['E2E_ADMIN_EMAIL 带大写（值本身不规整）', 'E2E-Admin@lemomemo.test', 'E2E-Admin@lemomemo.test', {}, 'bad_admin_var', true],
    ['邮箱换了大小写', 'E2E-ADMIN@lemomemo.test', ADMIN, {}, 'not_admin_var', true],
    ['邮箱带前后空白', ` ${ADMIN} `, ADMIN, {}, 'not_admin_var', true],
    ['邮箱是全角写法', 'ｅ2e-admin@lemomemo.test', ADMIN, {}, 'not_admin_var', true],
    ['邮箱是另一个 .test 账号', 'e2e-1@lemomemo.test', ADMIN, {}, 'not_admin_var', true],
    ['E2E_ADMIN_EMAIL 指向负责人的 .test 账号', OWNER_TEST, OWNER_TEST, { admins: { [ADMIN_ID]: OWNER_TEST }, users: [OWNER_TEST] }, 'owner_email', true],
    ['admins 里多出一个管理员', ADMIN, ADMIN, { admins: { [ADMIN_ID]: ADMIN, 'id-2': 'e2e-1@lemomemo.test' } }, 'admin_not_sole', false],
    ['admins 里多出一个没有邮箱的管理员', ADMIN, ADMIN, { admins: { [ADMIN_ID]: ADMIN, 'id-2': null } }, 'admin_not_sole', false],
    ['admins 里唯一的管理员是别人', ADMIN, ADMIN, { admins: { [ADMIN_ID]: 'e2e-1@lemomemo.test' } }, 'admin_not_sole', false],
    ['admins 是空的', ADMIN, ADMIN, { admins: {} }, 'admin_not_sole', false],
    ['读不清 admins', ADMIN, ADMIN, { adminsError: true }, 'admins_unreadable', false],
    ['admins 条数对不上', ADMIN, ADMIN, { adminsCount: 2 }, 'admins_unreadable', false],
    ['查不到管理员账号', ADMIN, ADMIN, { userLookupError: true }, 'admins_unreadable', false],
    ['auth.users 里没有这个账号', ADMIN, ADMIN, { users: ['e2e-1@lemomemo.test'] }, 'no_such_user', false],
  ];

  it('负责人名单为空或没设：报 no_owner_list，连 admins 都不读、不调 generateLink', async () => {
    for (const owners of ['', ' ;, ']) {
      const { run, calls } = prepAs(ADMIN, {}, ADMIN, owners);
      expect((await rejects(run)).code).toBe('no_owner_list');
      expect(calls.adminsRead).toBe(0);
      expect(calls.generate).toEqual([]);
    }
    const f = fakeClient();
    const e = await rejects(prepareLogin({ email: ADMIN, client: f.client, ownerEmails: undefined, mask: () => {}, asAdmin: { adminEmailVar: ADMIN } }));
    expect(e.code).toBe('no_owner_list');
    expect(f.calls.adminsRead).toBe(0);
  });

  it.each(REVERSE)('反例：%s → 报错、不调 generateLink、不 mask', async (_label, email, adminVar, opts, code, early) => {
    const { run, calls, masked } = prepAs(email, opts, adminVar);
    const e = await rejects(run);
    expect(e.code).toBe(code);
    expect(calls.generate).toEqual([]);
    expect(masked).toEqual([]);
    expect(e.message).not.toContain(email.trim());
    if (early) expect(calls.adminsRead).toBe(0);
  });
});

describe('命令行 --as-admin', () => {
  function io(opts: FakeOpts = {}) {
    const f = fakeClient(opts);
    const out: string[] = [];
    const appended: string[] = [];
    let made = 0;
    const sink = {
      out: (s: string) => out.push(s),
      append: (_f: string, s: string) => appended.push(s),
      makeClient: async () => {
        made++;
        return f.client;
      },
    };
    return { f, out, appended, made: () => made, io: sink };
  }
  const env = (over: Record<string, string | undefined> = {}) => ({
    PREVIEW_SUPABASE_PROJECT_REF: PREVIEW_REF,
    E2E_PREVIEW_SERVICE_KEY: FAKE_KEY,
    PREVIEW_OWNER_EMAILS: OWNERS,
    E2E_ADMIN_EMAIL: ADMIN,
    GITHUB_OUTPUT: '/tmp/gh-output',
    ...over,
  });

  it('成功：退出码 0，email_otp 写进 GITHUB_OUTPUT，屏幕上验证码只出现在 ::add-mask:: 里，不出现 key', async () => {
    const t = io();
    expect(await main(['--as-admin', ADMIN], env(), t.io)).toBe(0);
    expect(t.appended).toEqual([`email_otp=${OTP}\n`]);
    expect(t.out[0]).toBe(`::add-mask::${OTP}\n`);
    expect(t.out.filter((l) => l.includes(OTP) && !l.startsWith('::add-mask::'))).toEqual([]);
    expect(t.out.join('')).not.toContain(FAKE_KEY);
  });

  it('不带 --as-admin：管理员邮箱退出码 1（admin_email），不调 generateLink、不写 GITHUB_OUTPUT', async () => {
    const t = io();
    expect(await main([ADMIN], env(), t.io)).toBe(1);
    expect(t.out.join('')).toContain('admin_email');
    expect(t.f.calls.generate).toEqual([]);
    expect(t.appended).toEqual([]);
  });

  it('E2E_ADMIN_EMAIL 没设、不是 .test、和邮箱不一致，没有 GITHUB_OUTPUT，或负责人名单为空：退出码 1、不建客户端', async () => {
    const cases: [string, Record<string, string | undefined>][] = [
      [ADMIN, env({ E2E_ADMIN_EMAIL: undefined })],
      ['boss@gmail.com', env({ E2E_ADMIN_EMAIL: 'boss@gmail.com' })],
      ['e2e-1@lemomemo.test', env()],
      [ADMIN, env({ GITHUB_OUTPUT: undefined })],
      [ADMIN, env({ PREVIEW_OWNER_EMAILS: undefined })],
      [ADMIN, env({ PREVIEW_OWNER_EMAILS: '' })],
    ];
    for (const [email, e] of cases) {
      const t = io();
      expect(await main(['--as-admin', email], e, t.io)).toBe(1);
      expect(t.made()).toBe(0);
      expect(t.out.join('')).not.toContain(email);
    }
  });

  it('admins 里多出别的管理员：退出码 1（admin_not_sole），不调 generateLink、不写 GITHUB_OUTPUT', async () => {
    const t = io({ admins: { [ADMIN_ID]: ADMIN, 'id-2': 'e2e-1@lemomemo.test' } });
    expect(await main(['--as-admin', ADMIN], env(), t.io)).toBe(1);
    expect(t.out.join('')).toContain('admin_not_sole');
    expect(t.f.calls.generate).toEqual([]);
    expect(t.appended).toEqual([]);
  });

  it('参数不对（只有 --as-admin、多一个参数、和 --admin 连用）：退出码 1、不建客户端', async () => {
    for (const argv of [['--as-admin'], ['--as-admin', ADMIN, 'e2e-1@lemomemo.test'], ['--as-admin', '--admin', ADMIN]]) {
      const t = io();
      expect(await main(argv, env(), t.io)).toBe(1);
      expect(t.made()).toBe(0);
    }
  });

  // 只查护栏模式（PREVIEW_LOGIN_GUARD_ONLY=1，tools/keys/login-token-tests.ps1 -Only P6 用）：不要 GITHUB_OUTPUT，绝不调 generateLink
  const guardEnv = env({ PREVIEW_LOGIN_GUARD_ONLY: '1', GITHUB_OUTPUT: undefined, E2E_ADMIN_EMAIL: undefined });
  it('只查护栏：真实邮箱、负责人 .test 邮箱、管理员、不存在的账号 → 退出码 1、对应错误码、打印“未签发”，不调 generateLink、不写输出', async () => {
    const cases: [string, string][] = [
      ['someone@gmail.com', 'not_test_email'],
      ['owner.real@gmail.com', 'not_test_email'], // 负责人的真实邮箱先被“只认 .test”拦下
      [OWNER_TEST, 'owner_email'],
      [ADMIN, 'admin_email'],
      ['e2e-nobody@lemomemo.test', 'no_such_user'],
    ];
    for (const [email, code] of cases) {
      const t = io();
      expect(await main([email], guardEnv, t.io), email).toBe(1);
      const out = t.out.join('');
      expect(out, email).toContain(`错误（${code}）`);
      expect(out, email).toContain('未签发（只查护栏模式）');
      expect(out).not.toContain(FAKE_KEY);
      expect(out).not.toContain('email_otp');
      expect(t.f.calls.generate).toEqual([]);
      expect(t.f.calls.insert).toEqual([]);
      expect(t.appended).toEqual([]);
    }
  });

  it('只查护栏：护栏全过也不签发，退出码 3；不和 --as-admin 一起用（不建客户端）；不设这个变量时照旧要 GITHUB_OUTPUT', async () => {
    const t = io();
    expect(await main(['e2e-1@lemomemo.test'], guardEnv, t.io)).toBe(3);
    expect(t.out.join('')).toContain('护栏全过（只查护栏模式，未签发）');
    expect(t.f.calls.generate).toEqual([]);
    // --admin 在只查护栏模式下另有用例（preview-login-admin.test.ts），这里只看 --as-admin 仍被拒
    const u = io();
    expect(await main(['--as-admin', ADMIN], guardEnv, u.io)).toBe(1);
    expect(u.out.join('')).toContain('错误（bad_args）');
    expect(u.made()).toBe(0);
    expect(u.f.calls.insert).toEqual([]);
    const v = io();
    expect(await main(['e2e-1@lemomemo.test'], env({ GITHUB_OUTPUT: undefined, PREVIEW_LOGIN_GUARD_ONLY: '0' }), v.io)).toBe(1);
    expect(v.out.join('')).toContain('错误（no_output）');
    expect(v.out.join('')).not.toContain('未签发（只查护栏模式）');
  });
});
