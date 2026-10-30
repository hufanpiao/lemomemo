// tools/e2e/preview-login.ts 的 --admin（预览 E2E 种子：给测试账号加管理员；TC-B1-75 ①，接手清单 TC75-admin）：
// 只给 @lemomemo.test 的已有账号写 private.admins；负责人名单为空、真实邮箱、负责人账号（PREVIEW_OWNER_EMAILS，哪怕已在 admins 里）、
// 读不清 admins、不存在的账号一律报错，而且在调 generateLink、写 admins 之前就退出；已经是管理员的 .test 账号跳过（幂等，负责人 10-30 定）。
// 用假客户端，不连预览库、不用真密钥
import { describe, expect, it } from 'vitest';
import { grantAdmin, main, PREVIEW_REF } from '../../tools/e2e/preview-login.ts';
import { ADMIN_ID, FAKE_KEY, fakeClient, type FakeOpts, PROD_REF, rejects, userIdAt } from './preview-login-fakes.ts';

const OWNER_REAL = 'owner.real@gmail.com';
const OWNER_TEST = 'owner-accept@lemomemo.test';
const OWNERS = `${OWNER_REAL}, ${OWNER_TEST}`;

const grant = (email: string, opts: FakeOpts = {}, ownerEmails = OWNERS) => {
  const f = fakeClient({ users: ['e2e-1@lemomemo.test', 'e2e-admin@lemomemo.test', OWNER_TEST, OWNER_REAL], ...opts });
  return { ...f, run: grantAdmin({ email, client: f.client, ownerEmails }) };
};

describe('grantAdmin：只给 .test 测试账号加管理员', () => {
  it('正例：e2e-1@lemomemo.test（大小写、前后空白、全角都规整）→ 用它的 user_id 写一行 admins，不调 generateLink', async () => {
    for (const email of ['e2e-1@lemomemo.test', '  E2E-1@LemoMemo.TEST ', 'ｅ2e-1@lemomemo.test']) {
      const { run, calls } = grant(email);
      expect(await run).toEqual({ email: 'e2e-1@lemomemo.test', skipped: false });
      expect(calls.insert).toEqual([userIdAt(0)]);
      expect(calls.generate).toEqual([]);
    }
  });

  const REVERSE: [string, string, FakeOpts?][] = [
    ['真实邮箱', 'someone@gmail.com'],
    ['伪装成 .test 的真实域名', 'e2e-1@lemomemo.test.evil.com'],
    ['子域名', 'e2e-1@x.lemomemo.test'],
    ['尾点', 'e2e-1@lemomemo.test.'],
    ['西里尔字母冒充 e', 'e2e-1@lemomemo.t\u0435st'],
    ['零宽空格', 'e2e-1@lemomemo.te\u200bst'],
    ['中间换行', 'e2e-1@lemo\nmemo.test'],
    ['负责人的真实邮箱（PREVIEW_OWNER_EMAILS）', OWNER_REAL],
    ['PREVIEW_OWNER_EMAILS 里的 .test 验收账号', OWNER_TEST],
    ['PREVIEW_OWNER_EMAILS 里的邮箱换大小写', OWNER_TEST.toUpperCase()],
    ['负责人的 .test 账号已在 private.admins 里（owner 护栏在“已是管理员就跳过”之前）', OWNER_TEST, { admins: { [ADMIN_ID]: OWNER_TEST } }],
    ['账号不存在', 'e2e-404@lemomemo.test'],
    ['读不清 admins', 'e2e-1@lemomemo.test', { adminsError: true }],
    ['admins 条数对不上', 'e2e-1@lemomemo.test', { adminsCount: 5 }],
    ['查不了 auth.users', 'e2e-1@lemomemo.test', { listError: true }],
  ];
  const CODE: Record<string, string> = {
    真实邮箱: 'not_test_email',
    '伪装成 .test 的真实域名': 'not_test_email',
    子域名: 'not_test_email',
    尾点: 'not_test_email',
    '西里尔字母冒充 e': 'not_test_email',
    零宽空格: 'not_test_email',
    中间换行: 'not_test_email',
    '负责人的真实邮箱（PREVIEW_OWNER_EMAILS）': 'not_test_email',
    'PREVIEW_OWNER_EMAILS 里的 .test 验收账号': 'owner_email',
    'PREVIEW_OWNER_EMAILS 里的邮箱换大小写': 'owner_email',
    '负责人的 .test 账号已在 private.admins 里（owner 护栏在“已是管理员就跳过”之前）': 'owner_email',
    账号不存在: 'no_such_user',
    '读不清 admins': 'admins_unreadable',
    'admins 条数对不上': 'admins_unreadable',
    '查不了 auth.users': 'users_unreadable',
  };

  it.each(REVERSE)('反例：%s → 报错，不写 admins、不调 generateLink', async (label, email, opts) => {
    const { run, calls } = grant(email, opts);
    const e = await rejects(run);
    expect(e.code).toBe(CODE[label]);
    expect(calls.insert).toEqual([]);
    expect(calls.generate).toEqual([]);
    // 报错里不带传入的邮箱
    expect(e.message).not.toContain(email.trim());
  });

  it('真实邮箱、负责人账号在读任何远端数据之前就拒（连 admins 都不读）', async () => {
    for (const email of ['someone@gmail.com', OWNER_REAL, OWNER_TEST]) {
      const { run, calls } = grant(email);
      await rejects(run);
      expect(calls.adminsRead).toBe(0);
      expect(calls.pages).toEqual([]);
    }
  });

  it('PREVIEW_OWNER_EMAILS 为空或没设：报 no_owner_list，连 admins 都不读、不写库', async () => {
    for (const owners of ['', ' , ;']) {
      const { run, calls } = grant('e2e-1@lemomemo.test', {}, owners);
      expect((await rejects(run)).code).toBe('no_owner_list');
      expect(calls.adminsRead).toBe(0);
      expect(calls.insert).toEqual([]);
    }
    const f = fakeClient();
    expect((await rejects(grantAdmin({ email: 'e2e-1@lemomemo.test', client: f.client, ownerEmails: undefined }))).code).toBe('no_owner_list');
    expect(f.calls.adminsRead).toBe(0);
  });

  it('已是管理员的 .test 账号（换大小写也算）：跳过，skipped 为真，不重复写 admins、不调 generateLink', async () => {
    for (const email of ['e2e-admin@lemomemo.test', 'E2E-Admin@LemoMemo.test']) {
      const { run, calls } = grant(email);
      expect(await run).toEqual({ email: 'e2e-admin@lemomemo.test', skipped: true });
      expect(calls.insert).toEqual([]);
      expect(calls.generate).toEqual([]);
    }
  });

  it('已是管理员也先跑完其余护栏：账号在 auth.users 里不存在 → no_such_user；读不清 admins → admins_unreadable', async () => {
    const gone = grant('e2e-admin@lemomemo.test', { users: ['e2e-1@lemomemo.test'] });
    expect((await rejects(gone.run)).code).toBe('no_such_user');
    const blurry = grant('e2e-admin@lemomemo.test', { adminsCount: 3 });
    expect((await rejects(blurry.run)).code).toBe('admins_unreadable');
    expect(gone.calls.insert).toEqual([]);
    expect(blurry.calls.insert).toEqual([]);
  });

  it('写 admins 失败（例如 service_role 没有 insert 权限）：报 admin_write_failed，不调 generateLink', async () => {
    const { run, calls } = grant('e2e-1@lemomemo.test', { insertError: true });
    expect((await rejects(run)).code).toBe('admin_write_failed');
    expect(calls.insert).toEqual([userIdAt(0)]);
    expect(calls.generate).toEqual([]);
  });
});

describe('命令行 --admin', () => {
  function io(opts: FakeOpts = {}) {
    const f = fakeClient({ users: ['e2e-1@lemomemo.test', 'e2e-admin@lemomemo.test', OWNER_TEST], admins: { [ADMIN_ID]: 'e2e-admin@lemomemo.test' }, ...opts });
    const out: string[] = [];
    const appended: string[] = [];
    let made = 0;
    return {
      f,
      out,
      appended,
      made: () => made,
      io: {
        out: (s: string) => out.push(s),
        append: (_f: string, s: string) => appended.push(s),
        makeClient: async () => {
          made++;
          return f.client;
        },
      },
    };
  }
  const env = (over: Record<string, string | undefined> = {}) => ({
    PREVIEW_SUPABASE_PROJECT_REF: PREVIEW_REF,
    E2E_PREVIEW_SERVICE_KEY: FAKE_KEY,
    PREVIEW_OWNER_EMAILS: OWNERS,
    ...over,
  });

  it('成功：退出码 0，写一行 admins；不取验证码、不写 GITHUB_OUTPUT（没设也行），屏幕上不出现 key', async () => {
    const t = io();
    expect(await main(['--admin', 'e2e-1@lemomemo.test'], env(), t.io)).toBe(0);
    expect(t.f.calls.insert).toEqual([userIdAt(0)]);
    expect(t.f.calls.generate).toEqual([]);
    expect(t.appended).toEqual([]);
    expect(t.out.join('')).not.toContain(FAKE_KEY);
  });

  it('已是管理员：输出“已是管理员，跳过”、退出码 0，不写 admins（种子可重跑）', async () => {
    const t = io();
    expect(await main(['--admin', 'e2e-admin@lemomemo.test'], env(), t.io)).toBe(0);
    expect(t.out.join('')).toContain('已是管理员，跳过');
    expect(t.f.calls.insert).toEqual([]);
    expect(t.f.calls.generate).toEqual([]);
  });

  it('反例：真实邮箱、负责人账号、不存在的账号都退出码 1，不写 admins、不调 generateLink、不打印 key 和邮箱', async () => {
    for (const email of ['someone@gmail.com', OWNER_REAL, OWNER_TEST, 'e2e-404@lemomemo.test']) {
      const t = io();
      expect(await main(['--admin', email], env(), t.io)).toBe(1);
      expect(t.f.calls.insert).toEqual([]);
      expect(t.f.calls.generate).toEqual([]);
      const printed = t.out.join('');
      expect(printed).not.toContain(FAKE_KEY);
      expect(printed).not.toContain(email);
    }
  });

  it('负责人账号已在 admins 里：退出码 1（不当“已是管理员”跳过）', async () => {
    const t = io({ admins: { [ADMIN_ID]: OWNER_TEST } });
    expect(await main(['--admin', OWNER_TEST], env(), t.io)).toBe(1);
    expect(t.out.join('')).toContain('owner_email');
    expect(t.f.calls.insert).toEqual([]);
  });

  it('PREVIEW_OWNER_EMAILS 为空或没设：退出码 1、不建客户端', async () => {
    for (const owners of ['', undefined]) {
      const t = io();
      expect(await main(['--admin', 'e2e-1@lemomemo.test'], env({ PREVIEW_OWNER_EMAILS: owners }), t.io)).toBe(1);
      expect(t.out.join('')).toContain('no_owner_list');
      expect(t.made()).toBe(0);
    }
  });

  it('只放行预览 ref：正式 ref、别的 ref、没设都退出码 1、不建客户端', async () => {
    for (const ref of [PROD_REF, 'abcdefghijklmnopqrst', undefined]) {
      const t = io();
      expect(await main(['--admin', 'e2e-1@lemomemo.test'], env({ PREVIEW_SUPABASE_PROJECT_REF: ref }), t.io)).toBe(1);
      expect(t.made()).toBe(0);
      expect(t.f.calls.insert).toEqual([]);
    }
  });

  it('参数不对（只有 --admin、多一个参数、邮箱位置是另一个开关）、缺 key：退出码 1、不建客户端', async () => {
    const cases: [string[], Record<string, string | undefined>][] = [
      [['--admin'], env()],
      [['--admin', 'e2e-1@lemomemo.test', 'e2e-2@lemomemo.test'], env()],
      [['--admin', '--admin'], env()],
      [['--admin', 'e2e-1@lemomemo.test'], env({ E2E_PREVIEW_SERVICE_KEY: '' })],
    ];
    for (const [argv, e] of cases) {
      const t = io();
      expect(await main(argv, e, t.io)).toBe(1);
      expect(t.made()).toBe(0);
    }
  });
});
