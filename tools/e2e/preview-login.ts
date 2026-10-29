// 预览 E2E 的登录准备（架构 0.29 续第 89、91 条；TC-B1-74、TC-B1-75 ①的“不给负责人签发”一半）
// 用预览项目的 service key 调 auth.admin.generateLink({type: 'magiclink'}) 取 email_otp，不发邮件。
// 护栏（全部在调 generateLink 之前查，任何一条不过都报错退出、不签发）：
//   ① 只接受 @lemomemo.test 结尾的邮箱（真实邮箱格式一律拒）；
//   ② 邮箱在环境变量 PREVIEW_OWNER_EMAILS（负责人验收账号，GitHub 环境变量、不进代码）里就拒；
//   ③ 邮箱是 private.admins 里某个账号的就拒（查不了 admins、条数对不上也拒：查不清就不签）；
//   ④ 账号必须已存在（generateLink 对不存在的邮箱会直接建号）：分页查 auth.users，找不到报 no_such_user；
//   ⑤ 命令行只认预览项目 ref，正式项目和其他 ref 一律不建客户端。
// 验证码、action_link、hashed_token 取到后先 ::add-mask::，不打印明文；service key 只从环境变量读，不打印、不进报错。
//
// 两种用法：
//   • Playwright 准备步骤直接 import prepareLogin()，验证码只在内存里；
//   • 命令行：node tools/e2e/preview-login.ts <e2e-n@lemomemo.test>
//       读 PREVIEW_SUPABASE_PROJECT_REF（必须是预览 ref）、E2E_PREVIEW_SERVICE_KEY（仓库级 secret，R-206）、PREVIEW_OWNER_EMAILS，
//       把 email_otp 写进 $GITHUB_OUTPUT（没有 GITHUB_OUTPUT 就报错：本机不跑这一步，验证码也不往屏幕上打）。
// 本脚本只取验证码，不给任何账号加管理员。

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';

/** 预览项目的 ref（公开值）；正式项目 uvlnwawwsdfihziaielj 和其他任何 ref 都不放行 */
export const PREVIEW_REF = 'yoeqwhygehbaftkppati';

/** 只认这个测试域名（规整后比较；子域名、后缀伪装都不算） */
export const TEST_EMAIL = /^[a-z0-9._+-]+@lemomemo\.test$/;

/** 验证码的形状：写进步骤输出前核对，不像验证码就不写 */
export const OTP_SHAPE = /^\d{6,10}$/;

/** listUsers 每页条数和最多翻几页（翻不完当查不清） */
export const PER_PAGE = 1000;
export const MAX_PAGES = 50;

/** 脚本用到的管理端操作（真客户端经 adaptClient() 适配；测试用假客户端实现同一接口） */
export interface AdminOps {
  /** private.admins 的 user_id 和 count: 'exact' 报的条数 */
  adminIds(): Promise<{ ids: string[] | null; count: number | null; error: boolean }>;
  /** 某个账号的邮箱；查不到账号 user 为 null */
  userEmail(id: string): Promise<{ found: boolean; email: string | null; error: boolean }>;
  /** auth.users 的一页邮箱（page 从 1 起） */
  listEmails(page: number, perPage: number): Promise<{ emails: (string | null)[] | null; error: boolean }>;
  generateLink(email: string): Promise<{
    properties: { email_otp?: string | null; action_link?: string | null; hashed_token?: string | null } | null;
    error: boolean;
  }>;
}

export type PrepCode =
  | 'bad_args'
  | 'bad_ref'
  | 'not_test_email'
  | 'owner_email'
  | 'admin_email'
  | 'admins_unreadable'
  | 'users_unreadable'
  | 'no_such_user'
  | 'generate_failed'
  | 'no_output';

/** 报错只带固定的错误码和中文说明，不带任何传入值（不带邮箱、key、验证码、远端原文） */
export class PrepError extends Error {
  readonly code: PrepCode;
  constructor(code: PrepCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** 规整：NFKC（开尔文符号 K、全角字母等变回 ASCII）、去前后空白、转小写 */
export const normEmail = (s: string): string => s.normalize('NFKC').trim().toLowerCase();

/** PREVIEW_OWNER_EMAILS：逗号、分号或空白分隔 */
export function parseOwnerEmails(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(/[\s,;]+/).map(normEmail).filter((s) => s !== ''));
}

export interface PrepareOptions {
  email: string;
  client: AdminOps;
  /** PREVIEW_OWNER_EMAILS 的原文 */
  ownerEmails: string | undefined;
  /** 拿到秘密值后立刻调用（CI 里输出 ::add-mask::） */
  mask: (secret: string) => void;
}

/** private.admins 里所有账号的邮箱（service_role 有 select，0001 第 582 行）；出错、条数对不上都当查不清 */
async function adminEmails(client: AdminOps): Promise<Set<string>> {
  const r = await client.adminIds();
  if (r.error || !r.ids || r.count === null || r.count !== r.ids.length) {
    throw new PrepError('admins_unreadable', '读不清 private.admins，按查不清处理，不签发');
  }
  const out = new Set<string>();
  for (const id of r.ids) {
    const u = await client.userEmail(id);
    if (u.error || !u.found) throw new PrepError('admins_unreadable', '查不到某个管理员账号，按查不清处理，不签发');
    if (u.email) out.add(normEmail(u.email)); // 没有邮箱的管理员（手机号账号）不可能和传入的邮箱相同
  }
  return out;
}

/** 分页查 auth.users 里有没有这个邮箱 */
async function userExists(client: AdminOps, email: string): Promise<boolean> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await client.listEmails(page, PER_PAGE);
    if (r.error || !r.emails) throw new PrepError('users_unreadable', '查不了 auth.users，按查不清处理，不签发');
    // 这里严格比较（只转小写、不做 NFKC）：库里的 e2e-①@… 不能当成 e2e-1@… 的账号；admins、负责人名单那两处才宽松规整
    if (r.emails.some((e) => e !== null && e.toLowerCase() === email)) return true;
    if (r.emails.length < PER_PAGE) return false;
  }
  throw new PrepError('users_unreadable', 'auth.users 页数超过上限，按查不清处理，不签发');
}

/** 护栏全过才调 generateLink，返回 email_otp（已 mask） */
export async function prepareLogin(o: PrepareOptions): Promise<{ email: string; emailOtp: string }> {
  const email = normEmail(o.email);
  if (!TEST_EMAIL.test(email)) throw new PrepError('not_test_email', '只接受 @lemomemo.test 结尾的测试邮箱');
  if (parseOwnerEmails(o.ownerEmails).has(email)) {
    throw new PrepError('owner_email', '这是 PREVIEW_OWNER_EMAILS 里的负责人验收邮箱，不签发');
  }
  if ((await adminEmails(o.client)).has(email)) throw new PrepError('admin_email', '这是 private.admins 里的管理员邮箱，不签发');
  if (!(await userExists(o.client, email))) {
    throw new PrepError('no_such_user', '预览项目里没有这个账号（generateLink 会直接建号），先跑种子脚本，不签发');
  }
  const { properties: p, error } = await o.client.generateLink(email);
  // 先遮掉再判断：哪怕下面报错，日志里也不会出现这几个值
  for (const v of [p?.email_otp, p?.action_link, p?.hashed_token]) if (v) o.mask(v);
  const otp = p?.email_otp;
  if (error || !otp || !OTP_SHAPE.test(otp)) throw new PrepError('generate_failed', 'generateLink 没有返回合格的 email_otp');
  return { email, emailOtp: otp };
}

/** 照 @actions/core 的 escapeData 转义：% → %25、\r → %0D、\n → %0A */
export const escapeData = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** GitHub Actions 的遮掩命令（和 core.setSecret 同一写法） */
export function ghMask(write: (line: string) => void): (secret: string) => void {
  return (secret) => write(`::add-mask::${escapeData(secret)}\n`);
}

/** 命令行入口；env、写文件、建客户端都可注入，测试不连远端 */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: {
    out: (s: string) => void;
    append: (file: string, s: string) => void;
    makeClient: (url: string, key: string) => Promise<AdminOps>;
  },
): Promise<number> {
  try {
    const email = argv[0];
    const ref = env.PREVIEW_SUPABASE_PROJECT_REF ?? '';
    const key = env.E2E_PREVIEW_SERVICE_KEY ?? '';
    if (argv.length !== 1 || !email) throw new PrepError('bad_args', '用法：node tools/e2e/preview-login.ts <e2e-n@lemomemo.test>');
    if (ref !== PREVIEW_REF) throw new PrepError('bad_ref', 'PREVIEW_SUPABASE_PROJECT_REF 不是预览项目，这一步只在预览项目跑');
    if (!key) throw new PrepError('bad_args', '没有 E2E_PREVIEW_SERVICE_KEY');
    const outFile = env.GITHUB_OUTPUT ?? '';
    // 先查输出位置：没有地方放验证码就不签发
    if (!outFile) throw new PrepError('no_output', '没有 GITHUB_OUTPUT：这一步只在 CI 里跑，验证码不往屏幕上打');
    const client = await io.makeClient(`https://${PREVIEW_REF}.supabase.co`, key);
    const { email: e, emailOtp } = await prepareLogin({ email, client, ownerEmails: env.PREVIEW_OWNER_EMAILS, mask: ghMask(io.out) });
    io.append(outFile, `email_otp=${emailOtp}\n`);
    io.out(`已为 ${e} 取到验证码（已遮掩，写进步骤输出 email_otp）\n`);
    return 0;
  } catch (err) {
    if (err instanceof PrepError) io.out(`错误（${err.code}）：${err.message}\n`);
    else io.out('错误：准备步骤意外失败（详情不打印，免得带出秘密值）\n');
    return 1;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** supabase-js 客户端 → AdminOps；远端返回的值逐个核类型，形状不对当出错 */
export function adaptClient(c: SupabaseClient): AdminOps {
  return {
    async adminIds() {
      const { data, error, count } = await c.schema('private').from('admins').select('user_id', { count: 'exact' });
      if (error || !Array.isArray(data)) return { ids: null, count: null, error: true };
      const ids: string[] = [];
      for (const row of data as unknown[]) {
        const id = typeof row === 'object' && row !== null && 'user_id' in row ? str(row.user_id) : null;
        if (id === null) return { ids: null, count: null, error: true };
        ids.push(id);
      }
      return { ids, count: count ?? null, error: false };
    },
    async userEmail(id) {
      const { data, error } = await c.auth.admin.getUserById(id);
      if (error) return { found: false, email: null, error: true };
      return { found: data.user !== null, email: data.user?.email ?? null, error: false };
    },
    async listEmails(page, perPage) {
      const { data, error } = await c.auth.admin.listUsers({ page, perPage });
      if (error) return { emails: null, error: true };
      return { emails: data.users.map((u) => u.email ?? null), error: false };
    },
    async generateLink(email) {
      const { data, error } = await c.auth.admin.generateLink({ type: 'magiclink', email });
      const p = data.properties;
      return {
        properties: p ? { email_otp: p.email_otp, action_link: p.action_link, hashed_token: p.hashed_token } : null,
        error: error !== null,
      };
    },
  };
}

async function realClient(url: string, key: string): Promise<AdminOps> {
  const { createClient } = await import('@supabase/supabase-js');
  return adaptClient(createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main(process.argv.slice(2), process.env, {
    out: (s) => process.stdout.write(s),
    append: (f, s) => appendFileSync(f, s, 'utf8'),
    makeClient: realClient,
  });
  process.exitCode = code;
}
