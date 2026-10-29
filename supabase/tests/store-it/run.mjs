// K3-store-it（B1 接手清单）：account、account-purge、invite-admin 三个 index.ts 的真 store 打本机真库的集成测试入口。
// 用法（仓库根目录，本地 Supabase 已起：supabase start -x studio）：node supabase/tests/store-it/run.mjs
// npm run test:db 的最后一段（CI 的 db 任务经它跑）。做三件事：
//   ① 读 `supabase status -o json` 的 API_URL、DB_URL、ANON_KEY、SERVICE_ROLE_KEY（本地 CLI 的演示值，不打印）；
//      地址不是 127.0.0.1 / localhost / [::1] 就拒绝（account-store.it.ts 开头还会再查一次）；
//   ② 先跑 copy:shared（两个 index.ts 引 _shared/gen/）；
//   ③ 带这几项跑 deno test supabase/tests/store-it/account-store.it.ts、invite-admin-store.it.ts：网络只许 127.0.0.1，写只许 supabase/.temp/（残留清单）。
// 不用 shell：supabase 先按 PATH 找（CI），找不到就用 node 直接跑 node_modules/supabase/dist/supabase.js（本机 npx 装的）。
// 结果用 process.exitCode 交出。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..', '..');

function readStatus() {
  const cliJs = join(root, 'node_modules', 'supabase', 'dist', 'supabase.js');
  const tries = [['supabase', ['status', '-o', 'json']]];
  if (existsSync(cliJs)) tries.push([process.execPath, [cliJs, 'status', '-o', 'json']]);
  for (const [cmd, args] of tries) {
    try {
      const out = execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return JSON.parse(out.slice(out.indexOf('{')));
    } catch { /* 换下一种 */ }
  }
  return null;
}

const local = (u) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(u).hostname); } catch { return false; } };

const s = readStatus();
if (!s || !s.API_URL || !s.DB_URL || !s.SERVICE_ROLE_KEY || !s.ANON_KEY) {
  console.error('store-it：读不到 supabase status（本地 Supabase 没起？先 supabase start -x studio）');
  process.exitCode = 1;
} else if (!local(s.API_URL) || !local(s.DB_URL)) {
  console.error('store-it：只打本机的 Supabase（supabase status 给的地址不是 127.0.0.1 / localhost / [::1]）');
  process.exitCode = 1;
} else {
  execFileSync(process.execPath, [join(root, 'build', 'copy_shared.mjs')], { cwd: root, stdio: 'inherit' });
  mkdirSync(join(root, 'supabase', '.temp'), { recursive: true });
  const r = spawnSync('deno', [
    'test', '--config', 'deno.json', '--allow-net=127.0.0.1,localhost', '--allow-env', '--allow-read=.', '--allow-write=supabase/.temp',
    'supabase/tests/store-it/account-store.it.ts',
    'supabase/tests/store-it/invite-admin-store.it.ts',
  ], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, IT_API_URL: s.API_URL, IT_DB_URL: s.DB_URL, IT_ANON_KEY: s.ANON_KEY, IT_SERVICE_KEY: s.SERVICE_ROLE_KEY },
  });
  if (r.error) console.error(`store-it：deno 没跑起来（${r.error.message}）`);
  process.exitCode = r.status ?? 1;
}
