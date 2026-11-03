// tools/keys/login-token-tests.ps1 -Only P6、P6A 的假运行器（tests/build/login-token-tests.test.ts 经 -P9Runner 传给脚本），代替 node tools/e2e/preview-login.ts：
// 跑的是真的 preview-login.ts 的 main()（真护栏代码、真读环境变量），只把管理端客户端换成假的，不连远端。
// 默认：admins 为空、auth.users 只有 e2e-1@lemomemo.test；insertAdmin 回失败（P6 只查护栏模式绝不该调到）。
// P6A 用的模式（P6_RUNNER_MODE；auth.users 里另有 e2e-admin@lemomemo.test）：
//   grant     admins 为空，insertAdmin 成功（第一次）；
//   skip      admins 里已有 e2e-admin（第二次）；
//   grantfail admins 为空，insertAdmin 失败（admin_write_failed）。
// 每跑一次往 P6_RUNNER_LOG 追加一行：收到的参数、几个环境变量、调没调 generateLink / listUsers / insertAdmin、退出码。
// P6_RUNNER_MODE=leak 时先原样打印 key（看脚本判不判“输出里出现了 key”、屏幕上遮没遮住）
import { appendFileSync } from 'node:fs';
import { main } from '../../tools/e2e/preview-login.ts';

const [kind, script, ...args] = process.argv.slice(2);
const mode = process.env.P6_RUNNER_MODE ?? '';
const p6a = ['grant', 'skip', 'grantfail'].includes(mode);
const ADMIN = { id: 'u-admin', email: 'e2e-admin@lemomemo.test' };
const calls = { generate: 0, listUsers: 0, insert: 0 };
const client = {
  adminIds: async () => (mode === 'skip' ? { ids: [ADMIN.id], count: 1, error: false } : { ids: [], count: 0, error: false }),
  userEmail: async (id) => (id === ADMIN.id ? { found: true, email: ADMIN.email, error: false } : { found: false, email: null, error: false }),
  listUsers: async () => {
    calls.listUsers++;
    const users = [{ id: 'u-1', email: 'e2e-1@lemomemo.test' }, ...(p6a ? [ADMIN] : [])];
    return { users, nextPage: null, total: users.length, error: false };
  },
  generateLink: async () => {
    calls.generate++;
    return { properties: { email_otp: '123456' }, error: false };
  },
  insertAdmin: async () => {
    calls.insert++;   // 只查护栏模式（含 --admin）绝不该调到这里；P6 用例断言为 0。P6A 的 grant 模式写成功
    return { error: mode !== 'grant' };
  },
};
if (mode === 'leak') process.stdout.write(`key=${process.env.E2E_PREVIEW_SERVICE_KEY}\n`);
const code = await main(args, process.env, {
  out: (s) => process.stdout.write(s),
  append: () => {
    throw new Error('只查护栏模式、--admin 都不该写 GITHUB_OUTPUT');
  },
  makeClient: async () => client,
});
const keys = ['E2E_PREVIEW_SERVICE_KEY', 'PREVIEW_SUPABASE_PROJECT_REF', 'PREVIEW_OWNER_EMAILS', 'PREVIEW_LOGIN_GUARD_ONLY', 'GITHUB_OUTPUT', 'E2E_ADMIN_EMAIL'];
const env = Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]));
appendFileSync(process.env.P6_RUNNER_LOG ?? 'p6-runner.log', `${JSON.stringify({ kind, script, args, env, calls, code })}\n`);
process.exitCode = code;
