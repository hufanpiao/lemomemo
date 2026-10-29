// tools/e2e/preview-login.ts（TC-B1-74 准备脚本的护栏、TC-B1-75 ①的“不给负责人签发”一半）：用假客户端，不连远端、不用真密钥
import { describe, expect, it } from 'vitest';
import {
  type AdminOps,
  escapeData,
  ghMask,
  main,
  MAX_PAGES,
  parseOwnerEmails,
  PER_PAGE,
  PrepError,
  prepareLogin,
  PREVIEW_REF,
} from '../../tools/e2e/preview-login.ts';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const OTP = '123456';
const LINK = 'https://x.supabase.co/auth/v1/verify?token=hash-abc&type=magiclink';
const FAKE_KEY = 'fake-service-key-不是真的';
const PROD_REF = 'uvlnwawwsdfihziaielj';

interface FakeOpts {
  admins?: Record<string, string | null>; // user_id → email（null：没有邮箱的管理员）
  adminsCount?: number | null; // 默认等于 admins 条数
  adminsError?: boolean;
  userLookupError?: boolean;
  users?: (string | null)[]; // auth.users 的邮箱；默认几个种子账号
  listError?: boolean;
  gen?: { properties: Record<string, string> | null; error: boolean };
}

const SEED = ['e2e-1@lemomemo.test', 'e2e-2@lemomemo.test', 'e2e-admin@lemomemo.test', 'e2e-k@lemomemo.test'];

function fakeClient(o: FakeOpts = {}) {
  const calls = { generate: [] as string[], adminsRead: 0, pages: [] as number[] };
  const admins = o.admins ?? { [ADMIN_ID]: 'e2e-admin@lemomemo.test' };
  const users = o.users ?? SEED;
  const client: AdminOps = {
    adminIds: async () => {
      calls.adminsRead++;
      if (o.adminsError) return { ids: null, count: null, error: true };
      const ids = Object.keys(admins);
      return { ids, count: o.adminsCount === undefined ? ids.length : o.adminsCount, error: false };
    },
    userEmail: async (id) =>
      o.userLookupError ? { found: false, email: null, error: true } : { found: id in admins, email: admins[id] ?? null, error: false },
    listEmails: async (page, perPage) => {
      calls.pages.push(page);
      if (o.listError) return { emails: null, error: true };
      return { emails: users.slice((page - 1) * perPage, page * perPage), error: false };
    },
    generateLink: async (email) => {
      calls.generate.push(email);
      return o.gen ?? { properties: { email_otp: OTP, action_link: LINK, hashed_token: 'hash-abc' }, error: false };
    },
  };
  return { client, calls };
}

async function rejects(p: Promise<unknown>): Promise<PrepError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PrepError) return e;
    throw e;
  }
  throw new Error('应该报错却通过了');
}

const prep = (email: string, client: AdminOps, ownerEmails = '', mask: (s: string) => void = () => {}) =>
  prepareLogin({ email, client, ownerEmails, mask });

describe('prepareLogin 护栏', () => {
  it('.test 账号：调 generateLink(magiclink) 取 email_otp，三个秘密值都先遮掩', async () => {
    const { client, calls } = fakeClient();
    const masked: string[] = [];
    const r = await prep(' E2E-1@LemoMemo.test ', client, '', (s) => masked.push(s));
    expect(r).toEqual({ email: 'e2e-1@lemomemo.test', emailOtp: OTP });
    expect(calls.generate).toEqual(['e2e-1@lemomemo.test']);
    expect(masked).toEqual([OTP, LINK, 'hash-abc']);
  });

  const notTest = [
    'someone@gmail.com',
    'e2e-1@lemomemo.com',
    'e2e-1@lemomemo.test.evil.com',
    'e2e-1@sub.lemomemo.test',
    'a@b@lemomemo.test',
    'e2e 1@lemomemo.test',
    '@lemomemo.test',
    '',
  ];
  for (const email of notTest) {
    it(`非 .test 邮箱报错、不调 generateLink：${JSON.stringify(email)}`, async () => {
      const { client, calls } = fakeClient();
      const e = await rejects(prep(email, client));
      expect(e.code).toBe('not_test_email');
      expect(calls.generate).toHaveLength(0);
    });
  }

  it('PREVIEW_OWNER_EMAILS 里的邮箱报错（大小写、分隔符不影响），不调 generateLink', async () => {
    const { client, calls } = fakeClient();
    const owners = 'owner@gmail.com; OWNER-PREVIEW@lemomemo.test ,x@lemomemo.test';
    expect((await rejects(prep('owner-preview@lemomemo.test', client, owners))).code).toBe('owner_email');
    // 真实邮箱格式的负责人邮箱：在第一道就被拒
    expect((await rejects(prep('owner@gmail.com', client, owners))).code).toBe('not_test_email');
    expect(calls.generate).toHaveLength(0);
  });

  it('开尔文符号 K（U+212A）规整成 k：负责人邮箱换写法也拒；合法账号签发时传规整后的 ASCII', async () => {
    const { client, calls } = fakeClient();
    const e = await rejects(prep('owner-Kim@lemomemo.test', client, 'owner-kim@lemomemo.test'));
    expect(e.code).toBe('owner_email');
    expect(calls.generate).toHaveLength(0);
    const r = await prep('e2e-K@lemomemo.test', client);
    expect(r.email).toBe('e2e-k@lemomemo.test');
    expect(calls.generate).toEqual(['e2e-k@lemomemo.test']);
  });

  it('private.admins 里的邮箱报错（大小写不同也算），不调 generateLink', async () => {
    const { client, calls } = fakeClient({ admins: { [ADMIN_ID]: 'E2E-Admin@lemomemo.test' } });
    expect((await rejects(prep('e2e-admin@lemomemo.test', client))).code).toBe('admin_email');
    expect(calls.adminsRead).toBe(1);
    expect(calls.generate).toHaveLength(0);
  });

  it('管理员没有邮箱、admins 为空：不挡别的 .test 账号', async () => {
    for (const admins of [{ [ADMIN_ID]: null }, {}]) {
      const { client, calls } = fakeClient({ admins });
      expect((await prep('e2e-1@lemomemo.test', client)).emailOtp).toBe(OTP);
      expect(calls.generate).toEqual(['e2e-1@lemomemo.test']);
    }
  });

  it('读不了 admins、count 对不上、count 为空、查不到管理员账号：按查不清处理，不签发', async () => {
    const cases: FakeOpts[] = [{ adminsError: true }, { adminsCount: 2 }, { adminsCount: null }, { userLookupError: true }];
    for (const o of cases) {
      const { client, calls } = fakeClient(o);
      expect((await rejects(prep('e2e-1@lemomemo.test', client))).code).toBe('admins_unreadable');
      expect(calls.generate).toHaveLength(0);
    }
  });

  it('账号不存在：报 no_such_user，不调 generateLink（它会直接建号）', async () => {
    const { client, calls } = fakeClient();
    expect((await rejects(prep('e2e-99@lemomemo.test', client))).code).toBe('no_such_user');
    expect(calls.generate).toHaveLength(0);
  });

  it('账号在第二页：翻页找到；不在任何一页：翻到不满一页为止', async () => {
    const filler = Array.from({ length: PER_PAGE }, (_, i) => (i % 7 === 0 ? null : `seed-${i}@lemomemo.test`));
    const a = fakeClient({ users: [...filler, 'e2e-1@lemomemo.test'] });
    expect((await prep('e2e-1@lemomemo.test', a.client)).emailOtp).toBe(OTP);
    expect(a.calls.pages).toEqual([1, 2]);
    const b = fakeClient({ users: [...filler, 'e2e-2@lemomemo.test'] });
    expect((await rejects(prep('e2e-1@lemomemo.test', b.client))).code).toBe('no_such_user');
    expect(b.calls.pages).toEqual([1, 2]);
  });

  it('分页边界：刚好满一页、下一页为空 → no_such_user；50 个整页都没找到 → users_unreadable', async () => {
    const page = Array.from({ length: PER_PAGE }, (_, i) => `seed-${i}@lemomemo.test`);
    const a = fakeClient({ users: page });
    expect((await rejects(prep('e2e-1@lemomemo.test', a.client))).code).toBe('no_such_user');
    expect(a.calls.pages).toEqual([1, 2]);
    expect(a.calls.generate).toHaveLength(0);
    const many = Array.from({ length: PER_PAGE * MAX_PAGES }, (_, i) => `seed-${i}@lemomemo.test`);
    const b = fakeClient({ users: many });
    expect((await rejects(prep('e2e-1@lemomemo.test', b.client))).code).toBe('users_unreadable');
    expect(b.calls.pages).toHaveLength(MAX_PAGES);
    expect(b.calls.generate).toHaveLength(0);
  });

  it('查账号是否存在时严格比较：库里只有 e2e-①@lemomemo.test，查 e2e-1@lemomemo.test 报 no_such_user', async () => {
    const { client, calls } = fakeClient({ users: ['e2e-①@lemomemo.test'] });
    expect((await rejects(prep('e2e-1@lemomemo.test', client))).code).toBe('no_such_user');
    expect(calls.generate).toHaveLength(0);
  });

  it('查不了 auth.users：users_unreadable，不签发', async () => {
    const { client, calls } = fakeClient({ listError: true });
    expect((await rejects(prep('e2e-1@lemomemo.test', client))).code).toBe('users_unreadable');
    expect(calls.generate).toHaveLength(0);
  });

  it('generateLink 失败：报 generate_failed，报错里不带远端原文', async () => {
    const { client } = fakeClient({ gen: { properties: null, error: true } });
    const e = await rejects(prep('e2e-1@lemomemo.test', client));
    expect(e.code).toBe('generate_failed');
  });

  it('generateLink 同时返回 error 和部分 properties：仍先遮掩拿到的值再报错', async () => {
    const { client } = fakeClient({ gen: { properties: { email_otp: OTP, action_link: LINK }, error: true } });
    const masked: string[] = [];
    const e = await rejects(prep('e2e-1@lemomemo.test', client, '', (s) => masked.push(s)));
    expect(e.code).toBe('generate_failed');
    expect(masked).toEqual([OTP, LINK]);
  });

  it('email_otp 不像验证码（非 6～10 位数字）：先遮掩，再报 generate_failed', async () => {
    for (const bad of ['12345', '12345678901', 'abc123', '123456\n']) {
      const { client } = fakeClient({ gen: { properties: { email_otp: bad }, error: false } });
      const masked: string[] = [];
      expect((await rejects(prep('e2e-1@lemomemo.test', client, '', (s) => masked.push(s)))).code).toBe('generate_failed');
      expect(masked).toEqual([bad]);
    }
  });

  it('parseOwnerEmails：逗号、分号、空白分隔，去空、转小写', () => {
    expect([...parseOwnerEmails(' A@x.com,b@Y.com;\n c@z.com ,, ')]).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
    expect(parseOwnerEmails(undefined).size).toBe(0);
  });

  it('ghMask：照 @actions/core escapeData 转义 %、\\r、\\n，一条命令一行', () => {
    expect(escapeData('a%b\r\nc')).toBe('a%25b%0D%0Ac');
    const lines: string[] = [];
    ghMask((l) => lines.push(l))('ab\ncd%');
    expect(lines).toEqual(['::add-mask::ab%0Acd%25\n']);
  });
});

describe('命令行 main()', () => {
  function run(argv: string[], env: Record<string, string | undefined>, o: FakeOpts = {}) {
    const { client, calls } = fakeClient(o);
    const out: string[] = [];
    const files: [string, string][] = [];
    const made: [string, string][] = [];
    const p = main(argv, env, {
      out: (s) => out.push(s),
      append: (f, s) => files.push([f, s]),
      makeClient: async (url, key) => {
        made.push([url, key]);
        return client;
      },
    });
    return { p, out, files, made, calls };
  }
  const baseEnv = { PREVIEW_SUPABASE_PROJECT_REF: PREVIEW_REF, E2E_PREVIEW_SERVICE_KEY: FAKE_KEY, GITHUB_OUTPUT: 'gh-out.txt' };

  it('成功：先遮掩再写 GITHUB_OUTPUT；屏幕上只有 ::add-mask:: 行带秘密值，key 一次都不出现', async () => {
    const r = run(['e2e-1@lemomemo.test'], baseEnv);
    expect(await r.p).toBe(0);
    expect(r.made).toEqual([[`https://${PREVIEW_REF}.supabase.co`, FAKE_KEY]]);
    expect(r.files).toEqual([['gh-out.txt', `email_otp=${OTP}\n`]]);
    expect(r.out.join('')).not.toContain(FAKE_KEY);
    const plain = r.out.filter((l) => !l.startsWith('::add-mask::')).join('');
    expect(plain).not.toContain(OTP);
    expect(plain).not.toContain('hash-abc');
    expect(r.out.slice(0, 3).every((l) => l.startsWith('::add-mask::'))).toBe(true);
  });

  it('只放行预览 ref：正式 ref、别的 ref、没设都退出码 1、不建客户端', async () => {
    for (const ref of [PROD_REF, 'abcdefghij0123456789', 'https://evil.example', '', undefined]) {
      const r = run(['e2e-1@lemomemo.test'], { ...baseEnv, PREVIEW_SUPABASE_PROJECT_REF: ref });
      expect(await r.p).toBe(1);
      expect(r.made).toHaveLength(0);
      expect(r.files).toHaveLength(0);
      expect(r.out.join('')).toMatch(/^错误（bad_ref）/);
    }
  });

  it('反例：真实邮箱、负责人邮箱、admins 邮箱、不存在的账号都退出码 1，不写输出、不调 generateLink、不打印 key 和邮箱', async () => {
    const cases: [string, Record<string, string>, string][] = [
      ['someone@gmail.com', {}, 'not_test_email'],
      ['owner@lemomemo.test', { PREVIEW_OWNER_EMAILS: 'owner@lemomemo.test' }, 'owner_email'],
      ['e2e-admin@lemomemo.test', {}, 'admin_email'],
      ['e2e-99@lemomemo.test', {}, 'no_such_user'],
    ];
    for (const [email, extra, code] of cases) {
      const r = run([email], { ...baseEnv, ...extra });
      expect(await r.p).toBe(1);
      expect(r.files).toHaveLength(0);
      expect(r.calls.generate).toHaveLength(0);
      const all = r.out.join('');
      expect(all.startsWith(`错误（${code}）`)).toBe(true);
      expect(all).not.toContain(FAKE_KEY);
      expect(all).not.toContain(email);
    }
  });

  it('验证码形状不对：退出码 1，不写 GITHUB_OUTPUT', async () => {
    const r = run(['e2e-1@lemomemo.test'], baseEnv, { gen: { properties: { email_otp: 'not-an-otp' }, error: false } });
    expect(await r.p).toBe(1);
    expect(r.files).toHaveLength(0);
  });

  it('缺参数、缺 key、没有 GITHUB_OUTPUT：报错退出，不建客户端', async () => {
    const cases: [string[], Record<string, string | undefined>][] = [
      [[], baseEnv],
      [['a@lemomemo.test', 'b@lemomemo.test'], baseEnv],
      [['e2e-1@lemomemo.test'], { ...baseEnv, E2E_PREVIEW_SERVICE_KEY: undefined }],
      [['e2e-1@lemomemo.test'], { ...baseEnv, GITHUB_OUTPUT: undefined }],
    ];
    for (const [argv, env] of cases) {
      const r = run(argv, env);
      expect(await r.p).toBe(1);
      expect(r.made).toHaveLength(0);
      expect(r.out.join('')).not.toContain(FAKE_KEY);
    }
  });

  it('意外异常：只打印笼统的一句，不带异常原文', async () => {
    const out: string[] = [];
    const code = await main(['e2e-1@lemomemo.test'], baseEnv, {
      out: (s) => out.push(s),
      append: () => {},
      makeClient: async () => {
        throw new Error(`连接失败 key=${FAKE_KEY}`);
      },
    });
    expect(code).toBe(1);
    expect(out.join('')).not.toContain(FAKE_KEY);
  });
});
