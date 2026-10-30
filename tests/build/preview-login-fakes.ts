// tools/e2e/preview-login.ts 单测共用的假客户端（preview-login.test.ts、preview-login-admin.test.ts）：
// 实现同一个 AdminOps 接口，不连远端、不用真密钥；calls 记下调过 generateLink、insertAdmin 的参数，好断言反例“一次都没调”
import type { AdminOps } from '../../tools/e2e/preview-login.ts';
import { PrepError } from '../../tools/e2e/preview-login.ts';

export const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
export const OTP = '123456';
export const LINK = 'https://x.supabase.co/auth/v1/verify?token=hash-abc&type=magiclink';
export const FAKE_KEY = 'fake-service-key-不是真的';
export const PROD_REF = 'uvlnwawwsdfihziaielj';

export interface FakeOpts {
  admins?: Record<string, string | null>; // user_id → email（null：没有邮箱的管理员）
  adminsCount?: number | null; // 默认等于 admins 条数
  adminsError?: boolean;
  userLookupError?: boolean;
  users?: (string | null)[]; // auth.users 的邮箱（id 按位置生成 u-0、u-1…）；默认几个种子账号
  listError?: boolean;
  gen?: { properties: Record<string, string> | null; error: boolean };
  insertError?: boolean;
  pageCap?: number; // 服务端每页最多给几条（模拟把 perPage 压小）
  total?: number; // 服务端报的总数；默认等于 users 条数
}

export const SEED = ['e2e-1@lemomemo.test', 'e2e-2@lemomemo.test', 'e2e-admin@lemomemo.test', 'e2e-k@lemomemo.test'];

/** auth.users 里第 i 个账号的 id */
export const userIdAt = (i: number): string => `u-${i}`;

export function fakeClient(o: FakeOpts = {}) {
  const calls = { generate: [] as string[], insert: [] as string[], adminsRead: 0, pages: [] as number[] };
  const admins = o.admins ?? { [ADMIN_ID]: 'e2e-admin@lemomemo.test' };
  const users = (o.users ?? SEED).map((email, i) => ({ id: userIdAt(i), email }));
  const client: AdminOps = {
    adminIds: async () => {
      calls.adminsRead++;
      if (o.adminsError) return { ids: null, count: null, error: true };
      const ids = Object.keys(admins);
      return { ids, count: o.adminsCount === undefined ? ids.length : o.adminsCount, error: false };
    },
    userEmail: async (id) =>
      o.userLookupError ? { found: false, email: null, error: true } : { found: id in admins, email: admins[id] ?? null, error: false },
    listUsers: async (page, perPage) => {
      calls.pages.push(page);
      if (o.listError) return { users: null, nextPage: null, total: 0, error: true };
      const size = Math.min(perPage, o.pageCap ?? perPage);
      const end = page * size;
      return { users: users.slice(end - size, end), nextPage: end < users.length ? page + 1 : null, total: o.total ?? users.length, error: false };
    },
    generateLink: async (email) => {
      calls.generate.push(email);
      return o.gen ?? { properties: { email_otp: OTP, action_link: LINK, hashed_token: 'hash-abc' }, error: false };
    },
    insertAdmin: async (userId) => {
      calls.insert.push(userId);
      return { error: o.insertError === true };
    },
  };
  return { client, calls };
}

export async function rejects(p: Promise<unknown>): Promise<PrepError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PrepError) return e;
    throw e;
  }
  throw new Error('应该报错却通过了');
}
