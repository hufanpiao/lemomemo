// tools/keys/login-token-tests.ps1 -Only P6 的假运行器（tests/build/login-token-tests.test.ts 经 -P9Runner 传给脚本），代替 node tools/e2e/preview-login.ts：
// 跑的是真的 preview-login.ts 的 main()（真护栏代码、真读环境变量），只把管理端客户端换成假的——admins 为空、auth.users 只有 e2e-1@lemomemo.test，
// 不连远端。每跑一次往 P6_RUNNER_LOG 追加一行：收到的参数、几个环境变量、调没调 generateLink / listUsers、退出码。
// P6_RUNNER_MODE=leak 时先原样打印 key（看脚本判不判“输出里出现了 key”、屏幕上遮没遮住）
import { appendFileSync } from 'node:fs';
import { main } from '../../tools/e2e/preview-login.ts';

const [kind, script, ...args] = process.argv.slice(2);
const calls = { generate: 0, listUsers: 0 };
const client = {
  adminIds: async () => ({ ids: [], count: 0, error: false }),
  userEmail: async () => ({ found: false, email: null, error: false }),
  listUsers: async () => {
    calls.listUsers++;
    return { users: [{ id: 'u-1', email: 'e2e-1@lemomemo.test' }], nextPage: null, total: 1, error: false };
  },
  generateLink: async () => {
    calls.generate++;
    return { properties: { email_otp: '123456' }, error: false };
  },
  insertAdmin: async () => ({ error: true }),
};
if (process.env.P6_RUNNER_MODE === 'leak') process.stdout.write(`key=${process.env.E2E_PREVIEW_SERVICE_KEY}\n`);
const code = await main(args, process.env, {
  out: (s) => process.stdout.write(s),
  append: () => {
    throw new Error('只查护栏模式不该写 GITHUB_OUTPUT');
  },
  makeClient: async () => client,
});
const keys = ['E2E_PREVIEW_SERVICE_KEY', 'PREVIEW_SUPABASE_PROJECT_REF', 'PREVIEW_OWNER_EMAILS', 'PREVIEW_LOGIN_GUARD_ONLY', 'GITHUB_OUTPUT', 'E2E_ADMIN_EMAIL'];
const env = Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]));
appendFileSync(process.env.P6_RUNNER_LOG ?? 'p6-runner.log', `${JSON.stringify({ kind, script, args, env, calls, code })}\n`);
process.exitCode = code;
