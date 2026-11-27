// 在三个进程时区各跑一遍 Vitest（架构 1.3 B0 验收：时间函数在 3 个时区结果一致）
// 用法：node build/run_tz_tests.mjs [vitest 的其他参数]；默认只跑 node 项目（shared、架构自测、构建脚本）
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ZONES = ['UTC', 'Asia/Seoul', 'America/Los_Angeles'];
const root = join(import.meta.dirname, '..');
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const extra = process.argv.slice(2);
const args = extra.length > 0 ? extra : ['--project', 'node', 'tests/shared'];

let failed = 0;
for (const tz of ZONES) {
  console.log(`\n── TZ=${tz} ──`);
  const r = spawnSync(process.execPath, [vitest, 'run', ...args], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, TZ: tz },
  });
  if (r.status !== 0) {
    failed++;
    console.error(`TZ=${tz} 失败（退出码 ${r.status}）`);
  }
}
console.log(failed === 0 ? '\n三个时区全部通过' : `\n${failed} 个时区失败`);
process.exit(failed === 0 ? 0 : 1);
