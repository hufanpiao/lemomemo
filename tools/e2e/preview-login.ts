// 预览 E2E 的登录准备和种子里的“加管理员”（架构 0.29 续第 89、91 条；TC-B1-74、TC-B1-75 ①，接手清单 TC75-admin）
// 用预览项目的 service key 调 auth.admin.generateLink({type: 'magiclink'}) 取 email_otp，不发邮件；
// --admin 模式给 .test 测试账号写一行 private.admins（不取验证码）。
// 护栏（三种用法共用 checkGuards()，全部在调 generateLink 或写 admins 之前查，任何一条不过都报错退出、不签发、不写库）：
//   ① 只接受 @lemomemo.test 结尾的邮箱（真实邮箱格式一律拒）；
//   ② 邮箱在环境变量 PREVIEW_OWNER_EMAILS（负责人验收账号，GitHub 环境变量、不进代码）里就拒；--admin 时这个名单为空也拒；
//   ③ 读不清 private.admins（查不了、条数对不上）就拒；登录时邮箱是管理员就拒（例外只有 --as-admin，见下）；
//      --admin 时“已经是管理员”不报错、输出“已是管理员，跳过”（种子可重跑）；
//   ④ 账号必须已存在（generateLink 对不存在的邮箱会直接建号）：分页查 auth.users，找不到报 no_such_user；
//   ⑤ 命令行只认预览项目 ref，正式项目和其他 ref 一律不建客户端。
// 验证码、action_link、hashed_token 取到后先 ::add-mask::，不打印明文；service key 只从环境变量读，不打印、不进报错。
//
// 用法：
//   • Playwright 准备步骤直接 import prepareLogin()，验证码只在内存里；
//   • 命令行：node tools/e2e/preview-login.ts <e2e-n@lemomemo.test>
//       读 PREVIEW_SUPABASE_PROJECT_REF（必须是预览 ref）、E2E_PREVIEW_SERVICE_KEY（仓库级 secret，R-206）、PREVIEW_OWNER_EMAILS，
//       把 email_otp 写进 $GITHUB_OUTPUT（没有 GITHUB_OUTPUT 就报错：本机不跑这一步，验证码也不往屏幕上打）。
//   • 管理员账号登录：node tools/e2e/preview-login.ts --as-admin <邮箱>（负责人 10-30 定“只给指定的那一个开例外”）：
//       邮箱必须和仓库级变量 E2E_ADMIN_EMAIL（不是密钥、不进代码；值本身必须是 @lemomemo.test）一字不差，
//       而且 private.admins 里恰好只有这一个管理员（查不清或多出别的就拒）；PREVIEW_OWNER_EMAILS 为空也拒；其余护栏、::add-mask:: 照旧。
//   • 种子加管理员：node tools/e2e/preview-login.ts --admin <e2e-admin@lemomemo.test>（同样只认预览 ref；不写 GITHUB_OUTPUT）。
//       写库靠后端迁移 grant insert on private.admins to service_role（安全说明-v4 S-6、架构设计-v4 决定第 1 条）；写失败报 admin_write_failed。
//   • 只查护栏：环境变量 PREVIEW_LOGIN_GUARD_ONLY=1（负责人本机经 tools/keys/login-token-tests.ps1 -Only P6 实跑反例，B1 验收 P6）：
//       只认普通登录，只跑 checkGuards，绝不调 generateLink、不要 GITHUB_OUTPUT；被拦时报错后再打印“未签发（只查护栏模式）”，
//       护栏全过也不签发、退出码 3（反例本该被拦）。

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { adaptClient } from './preview-login-adapt.ts';

export { adaptClient };

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
  /** auth.users 的一页账号（page 从 1 起）；nextPage 为 null 表示这是最后一页，total 是服务端报的总数 */
  listUsers(
    page: number,
    perPage: number,
  ): Promise<{ users: { id: string; email: string | null }[] | null; nextPage: number | null; total: number; error: boolean }>;
  generateLink(email: string): Promise<{
    properties: { email_otp?: string | null; action_link?: string | null; hashed_token?: string | null } | null;
    error: boolean;
  }>;
  /** 往 private.admins 写一行（--admin 模式；护栏全过、且还不是管理员才调） */
  insertAdmin(userId: string): Promise<{ error: boolean }>;
}

export type PrepCode =
  | 'bad_args'
  | 'bad_ref'
  | 'not_test_email'
  | 'owner_email'
  | 'no_owner_list'
  | 'admin_email'
  | 'admin_not_sole'
  | 'bad_admin_var'
  | 'not_admin_var'
  | 'admins_unreadable'
  | 'users_unreadable'
  | 'no_such_user'
  | 'generate_failed'
  | 'admin_write_failed'
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

/** --admin、--as-admin 必须先有负责人名单：名单为空时 owner 护栏形同虚设，可能把负责人账号加成管理员 */
function requireOwnerList(raw: string | undefined): void {
  if (parseOwnerEmails(raw).size === 0) {
    throw new PrepError('no_owner_list', '没有 PREVIEW_OWNER_EMAILS：加管理员必须先有负责人名单，不写库');
  }
}

/** --as-admin 的前置检查（不读远端）：E2E_ADMIN_EMAIL 必须是 .test 邮箱，传入的邮箱必须和它一字不差 */
export function checkAdminException(rawEmail: string, adminEmailVar: string | undefined): void {
  if (!adminEmailVar || !TEST_EMAIL.test(adminEmailVar)) {
    throw new PrepError('bad_admin_var', 'E2E_ADMIN_EMAIL 没设或不是 @lemomemo.test 结尾的测试邮箱，不按管理员例外签发');
  }
  if (rawEmail !== adminEmailVar) throw new PrepError('not_admin_var', '邮箱和 E2E_ADMIN_EMAIL 不是一字不差相同，不按管理员例外签发');
}

export interface PrepareOptions {
  email: string;
  client: AdminOps;
  /** PREVIEW_OWNER_EMAILS 的原文 */
  ownerEmails: string | undefined;
  /** 拿到秘密值后立刻调用（CI 里输出 ::add-mask::） */
  mask: (secret: string) => void;
  /** 管理员例外（--as-admin）：E2E_ADMIN_EMAIL 的原文；不传就是普通登录，管理员一律拒 */
  asAdmin?: { adminEmailVar: string | undefined } | undefined;
}

/** private.admins 里每个管理员的邮箱（没有邮箱的记 null）；出错、条数对不上都当查不清 */
async function adminEmails(client: AdminOps): Promise<(string | null)[]> {
  const r = await client.adminIds();
  if (r.error || !r.ids || r.count === null || r.count !== r.ids.length) {
    throw new PrepError('admins_unreadable', '读不清 private.admins，按查不清处理，不签发');
  }
  const out: (string | null)[] = [];
  for (const id of r.ids) {
    const u = await client.userEmail(id);
    if (u.error || !u.found) throw new PrepError('admins_unreadable', '查不到某个管理员账号，按查不清处理，不签发');
    out.push(u.email ? normEmail(u.email) : null); // 没有邮箱的管理员（手机号账号）不可能和传入的邮箱相同，但照样算一个管理员
  }
  return out;
}

const unreadable = (why: string) => new PrepError('users_unreadable', `${why}，按查不清处理，不签发`);

/** 分页查 auth.users 里这个邮箱的账号 id；没有返回 null */
async function findUserId(client: AdminOps, email: string): Promise<string | null> {
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await client.listUsers(page, PER_PAGE);
    if (r.error || !r.users) throw unreadable('查不了 auth.users');
    // 服务端把每页条数压得比请求的小时，按页号翻会漏人：第一页既不满又少于 total 就当查不清
    if (page === 1 && r.users.length < PER_PAGE && r.users.length < r.total) throw unreadable('auth.users 每页条数和请求的不一致');
    // 这里严格比较（只转小写、不做 NFKC）：库里的 e2e-①@… 不能当成 e2e-1@… 的账号；admins、负责人名单那两处才宽松规整
    const hit = r.users.find((u) => u.email !== null && u.email.toLowerCase() === email);
    if (hit) return hit.id;
    seen += r.users.length;
    // 最后一页只看 nextPage 有没有，不用它和 lastPage 的数值：auth-js 解析 Link 头只取页号第一位，两位数页号会算错
    if (r.nextPage === null) {
      if (seen < r.total) throw unreadable('翻完了 auth.users，条数还少于 total');
      // 没有 Link 头（total 为 0）却正好满一页：后面可能还有，判断不了是不是最后一页
      if (r.total === 0 && r.users.length === PER_PAGE) throw unreadable('auth.users 满一页却没有分页信息');
      return null;
    }
  }
  throw unreadable('auth.users 页数超过上限');
}

/** 'login'：管理员一律拒；'grant'：管理员不拒，交给调用方跳过；'as-admin'：admins 里必须恰好只有这一个 */
export type GuardMode = 'login' | 'grant' | 'as-admin';

/**
 * 三种用法共用的护栏，按顺序查、任何一条不过就抛 PrepError；全过返回规整后的邮箱、账号 id、是不是管理员。
 * 调用方只有拿到返回值以后才调 generateLink 或写 admins
 */
export async function checkGuards(
  rawEmail: string,
  client: AdminOps,
  ownerEmails: string | undefined,
  mode: GuardMode = 'login',
): Promise<{ email: string; userId: string; isAdmin: boolean }> {
  const email = normEmail(rawEmail);
  if (!TEST_EMAIL.test(email)) throw new PrepError('not_test_email', '只接受 @lemomemo.test 结尾的测试邮箱');
  if (parseOwnerEmails(ownerEmails).has(email)) {
    throw new PrepError('owner_email', '这是 PREVIEW_OWNER_EMAILS 里的负责人验收邮箱，不签发、不加管理员');
  }
  const admins = await adminEmails(client);
  const isAdmin = admins.includes(email);
  if (mode === 'login' && isAdmin) throw new PrepError('admin_email', '这是 private.admins 里的管理员邮箱，不签发');
  if (mode === 'as-admin' && (admins.length !== 1 || !isAdmin)) {
    throw new PrepError('admin_not_sole', 'private.admins 里不是恰好只有这一个管理员，不按管理员例外签发');
  }
  const userId = await findUserId(client, email);
  if (userId === null) {
    throw new PrepError('no_such_user', '预览项目里没有这个账号（generateLink 会直接建号），先跑种子脚本建号，不签发、不加管理员');
  }
  return { email, userId, isAdmin };
}

/** 护栏全过才调 generateLink，返回 email_otp（已 mask） */
export async function prepareLogin(o: PrepareOptions): Promise<{ email: string; emailOtp: string }> {
  if (o.asAdmin) {
    requireOwnerList(o.ownerEmails);
    checkAdminException(o.email, o.asAdmin.adminEmailVar);
  }
  const { email } = await checkGuards(o.email, o.client, o.ownerEmails, o.asAdmin ? 'as-admin' : 'login');
  const { properties: p, error } = await o.client.generateLink(email);
  // 先遮掉再判断：哪怕下面报错，日志里也不会出现这几个值
  for (const v of [p?.email_otp, p?.action_link, p?.hashed_token]) if (v) o.mask(v);
  const otp = p?.email_otp;
  if (error || !otp || !OTP_SHAPE.test(otp)) throw new PrepError('generate_failed', 'generateLink 没有返回合格的 email_otp');
  return { email, emailOtp: otp };
}

/**
 * 预览 E2E 种子：给 .test 测试账号加管理员（TC-B1-75 ①）。负责人名单为空、真实邮箱、负责人账号（哪怕已在 admins 里）、
 * 读不清 admins、不存在的账号都在写库之前报错；已经是管理员的 .test 账号跳过（skipped），不重复写；不调 generateLink
 */
export async function grantAdmin(o: Omit<PrepareOptions, 'mask' | 'asAdmin'>): Promise<{ email: string; skipped: boolean }> {
  requireOwnerList(o.ownerEmails);
  const { email, userId, isAdmin } = await checkGuards(o.email, o.client, o.ownerEmails, 'grant');
  if (isAdmin) return { email, skipped: true };
  const r = await o.client.insertAdmin(userId);
  if (r.error) throw new PrepError('admin_write_failed', '写 private.admins 失败（检查 service_role 的 insert 授权迁移），没有加上管理员');
  return { email, skipped: false };
}

/** 照 @actions/core 的 escapeData 转义：% → %25、\r → %0D、\n → %0A */
export const escapeData = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** GitHub Actions 的遮掩命令（和 core.setSecret 同一写法） */
export function ghMask(write: (line: string) => void): (secret: string) => void {
  return (secret) => write(`::add-mask::${escapeData(secret)}\n`);
}

const FLAGS = new Set(['--admin', '--as-admin']);

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
  const guardOnly = env.PREVIEW_LOGIN_GUARD_ONLY === '1';
  try {
    const flag = argv[0] !== undefined && FLAGS.has(argv[0]) ? argv[0] : null;
    const args = flag ? argv.slice(1) : argv;
    const email = args[0];
    const ref = env.PREVIEW_SUPABASE_PROJECT_REF ?? '';
    const key = env.E2E_PREVIEW_SERVICE_KEY ?? '';
    if (args.length !== 1 || !email || email.startsWith('-')) {
      throw new PrepError('bad_args', '用法：node tools/e2e/preview-login.ts [--admin | --as-admin] <e2e-n@lemomemo.test>');
    }
    if (ref !== PREVIEW_REF) throw new PrepError('bad_ref', 'PREVIEW_SUPABASE_PROJECT_REF 不是预览项目，这一步只在预览项目跑');
    if (!key) throw new PrepError('bad_args', '没有 E2E_PREVIEW_SERVICE_KEY');
    const url = `https://${PREVIEW_REF}.supabase.co`;
    if (guardOnly) {
      if (flag) throw new PrepError('bad_args', '只查护栏模式只用于普通登录，不和 --admin、--as-admin 一起用');
      await checkGuards(email, await io.makeClient(url, key), env.PREVIEW_OWNER_EMAILS, 'login');
      io.out('护栏全过（只查护栏模式，未签发）\n');
      return 3;
    }
    if (flag === '--admin') {
      // 种子加管理员：不取验证码、不写 GITHUB_OUTPUT；名单为空在建客户端之前就拒
      requireOwnerList(env.PREVIEW_OWNER_EMAILS);
      const r = await grantAdmin({ email, client: await io.makeClient(url, key), ownerEmails: env.PREVIEW_OWNER_EMAILS });
      io.out(r.skipped ? `${r.email} 已是管理员，跳过\n` : `已把 ${r.email} 加进 private.admins（预览项目）\n`);
      return 0;
    }
    const asAdmin = flag === '--as-admin' ? { adminEmailVar: env.E2E_ADMIN_EMAIL } : undefined;
    if (asAdmin) {
      // 不合例外条件就不建客户端；例外同样要求先有负责人名单（主持人 10-30 定）
      requireOwnerList(env.PREVIEW_OWNER_EMAILS);
      checkAdminException(email, asAdmin.adminEmailVar);
    }
    const outFile = env.GITHUB_OUTPUT ?? '';
    // 先查输出位置：没有地方放验证码就不签发
    if (!outFile) throw new PrepError('no_output', '没有 GITHUB_OUTPUT：这一步只在 CI 里跑，验证码不往屏幕上打');
    const client = await io.makeClient(url, key);
    const { email: e, emailOtp } = await prepareLogin({ email, client, ownerEmails: env.PREVIEW_OWNER_EMAILS, mask: ghMask(io.out), asAdmin });
    io.append(outFile, `email_otp=${emailOtp}\n`);
    io.out(`已为 ${e} 取到验证码（已遮掩，写进步骤输出 email_otp）\n`);
    return 0;
  } catch (err) {
    if (err instanceof PrepError) io.out(`错误（${err.code}）：${err.message}\n`);
    else io.out('错误：准备步骤意外失败（详情不打印，免得带出秘密值）\n');
    if (guardOnly) io.out('未签发（只查护栏模式）\n');
    return 1;
  }
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
