// tools/e2e/preview-login.ts 的 adaptClient：用形状同 supabase-js 的假 SupabaseClient，不连远端、不用真密钥
// （从 preview-login.test.ts 拆出来，免得单个文件超过 300 行）
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { adaptClient, type AdminOps, PER_PAGE, PrepError, prepareLogin } from '../../tools/e2e/preview-login.ts';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const OTP = '123456';
const LINK = 'https://x.supabase.co/auth/v1/verify?token=hash-abc&type=magiclink';

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

describe('adaptClient（假的 SupabaseClient，形状同 supabase-js）', () => {
  interface SbOpts {
    admins?: { data: unknown; error: unknown; count: number | null };
    user?: { data: { user: { email?: string } | null }; error: unknown };
    list?: { data: { users: { email?: string }[] }; error: unknown };
    gen?: { data: { properties: Record<string, string> | null; user: unknown }; error: unknown };
  }
  function fakeSb(o: SbOpts = {}): SupabaseClient {
    const fake = {
      schema: () => ({
        from: () => ({ select: async () => o.admins ?? { data: [{ user_id: ADMIN_ID }], error: null, count: 1 } }),
      }),
      auth: {
        admin: {
          getUserById: async () => o.user ?? { data: { user: { email: 'e2e-admin@lemomemo.test' } }, error: null },
          listUsers: async () => o.list ?? { data: { users: [{ email: 'e2e-1@lemomemo.test' }, {}] }, error: null },
          generateLink: async () =>
            o.gen ?? { data: { properties: { email_otp: OTP, action_link: LINK, hashed_token: 'hash-abc' }, user: {} }, error: null },
        },
      },
    };
    return fake as unknown as SupabaseClient;
  }

  it('正常形状：四个操作都转成 AdminOps，能走完签发', async () => {
    const ops = adaptClient(fakeSb());
    expect(await ops.adminIds()).toEqual({ ids: [ADMIN_ID], count: 1, error: false });
    expect(await ops.userEmail(ADMIN_ID)).toEqual({ found: true, email: 'e2e-admin@lemomemo.test', error: false });
    expect(await ops.listEmails(1, PER_PAGE)).toEqual({ emails: ['e2e-1@lemomemo.test', null], error: false });
    expect((await prep('e2e-1@lemomemo.test', ops)).emailOtp).toBe(OTP);
  });

  it('listUsers 出错：emails 为 null、error 为真；走护栏报 users_unreadable', async () => {
    const ops = adaptClient(fakeSb({ list: { data: { users: [] }, error: { message: 'boom' } } }));
    expect(await ops.listEmails(1, PER_PAGE)).toEqual({ emails: null, error: true });
    expect((await rejects(prep('e2e-1@lemomemo.test', ops))).code).toBe('users_unreadable');
  });

  it('admins 的 count 为 null：照实传出；走护栏报 admins_unreadable', async () => {
    const ops = adaptClient(fakeSb({ admins: { data: [{ user_id: ADMIN_ID }], error: null, count: null } }));
    expect(await ops.adminIds()).toEqual({ ids: [ADMIN_ID], count: null, error: false });
    expect((await rejects(prep('e2e-1@lemomemo.test', ops))).code).toBe('admins_unreadable');
  });

  it('admins 行缺 user_id 或不是字符串：当出错；走护栏报 admins_unreadable', async () => {
    for (const data of [[{}], [{ user_id: 42 }], [null]]) {
      const ops = adaptClient(fakeSb({ admins: { data, error: null, count: 1 } }));
      expect(await ops.adminIds()).toEqual({ ids: null, count: null, error: true });
      expect((await rejects(prep('e2e-1@lemomemo.test', ops))).code).toBe('admins_unreadable');
    }
  });

  it('generateLink 出错、data.properties 为 null：properties 为 null、error 为真；走护栏报 generate_failed、什么都不遮', async () => {
    const ops = adaptClient(fakeSb({ gen: { data: { properties: null, user: null }, error: { message: 'rate limited' } } }));
    expect(await ops.generateLink('e2e-1@lemomemo.test')).toEqual({ properties: null, error: true });
    const masked: string[] = [];
    const e = await rejects(prep('e2e-1@lemomemo.test', ops, '', (s) => masked.push(s)));
    expect(e.code).toBe('generate_failed');
    expect(e.message).not.toContain('rate limited');
    expect(masked).toHaveLength(0);
  });
});
