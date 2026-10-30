// 跑 tests/build/preview-login-admin.real.test.ts（TC-B1-75 ④ 接本机 lemo-e2e 真后端）。
// 用法（仓库根目录）：npm run e2e:real:up → node tools/e2e/run-preview-login-admin-real.mjs → npm run e2e:real:down
// 经 real-backend.mjs 的 statusEnv() 取 lemo-e2e 的 API_URL、SERVICE_ROLE_KEY（过它的护栏；本地演示密钥），只放进 vitest 子进程的环境变量，不打印。
// 地址不是 127.0.0.1 / localhost 的 55320～55329 就不跑。
import { spawnSync } from 'node:child_process';
import { env, execPath, exit, stderr } from 'node:process';
import { URL } from 'node:url';
import { statusEnv } from './real-backend.mjs';

const s = statusEnv();
const u = new URL(s.API_URL);
const port = Number(u.port);
if (!['127.0.0.1', 'localhost'].includes(u.hostname) || !(port >= 55320 && port <= 55329)) {
  stderr.write('API_URL 不是 lemo-e2e 的 553xx，停\n');
  exit(2);
}
const r = spawnSync(execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/build/preview-login-admin.real.test.ts'], {
  stdio: 'inherit',
  env: { ...env, LEMO_E2E_REAL: '1', LEMO_E2E_API_URL: s.API_URL, LEMO_E2E_SERVICE_ROLE_KEY: s.SERVICE_ROLE_KEY },
});
exit(r.status ?? 1);
