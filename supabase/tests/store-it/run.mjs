// K3-store-it（B1 接手清单）：account、account-purge、invite-admin 三个 index.ts 的真 store 打本机真库的集成测试入口。
// 用法：本机 node supabase/tests/store-it/run.mjs --e2e-sb（先 npm run e2e:real:up）；CI 里 node supabase/tests/store-it/run.mjs（打改名成 lemo-ci 的那套）
// npm run test:db 的最后一段（CI 的 db 任务经它跑）。做三件事：
//   ① 读 `supabase status -o json` 的 API_URL、DB_URL、ANON_KEY、SERVICE_ROLE_KEY（本地 CLI 的演示值，不打印）；
//      地址不是 127.0.0.1 / localhost / [::1] 就拒绝（account-store.it.ts 开头还会再查一次）；
//   ② 先跑 copy:shared（两个 index.ts 引 _shared/gen/）；
//   ③ 带这几项跑 deno test supabase/tests/store-it/account-store.it.ts、invite-admin-store.it.ts，再另起一个进程跑 purge-remind.it.ts，
//      再另起一个进程跑 push-dispatch-d3.it.ts（11-06 B2：push-dispatch 真 store 的 D3 第 6 点三条、TC-DEL-remind_queue 函数一侧，约 35 秒），
//      再另起一个进程跑 ai-fns-store.it.ts（11-07 B3：四个 AI 函数按真 index.ts 组装，Gemini 用进程内替身），
//      再另起一个进程跑 remind-enqueue-parity.it.ts（11-13 R-411 后续：批量入队范围 SQL 和替身比对），
//      再另起一个进程跑 todo-items-cap.it.ts（11-13 R-350：子任务上限两连接并发），
//      再各起一个进程跑 vault-store.it.ts、vault-move.it.ts（11-14 B5：隐私记的 SQL 以 fn_vault、fn_ai 打真库）：
//      网络只许 127.0.0.1，写只许 supabase/.temp/（残留清单）。
// 不用 shell：supabase 先按 PATH 找（CI），找不到就用 node 直接跑 node_modules/supabase/dist/supabase.js（本机 npx 装的）。
// 结果用 process.exitCode 交出。
// 选项 --e2e-sb（11-05）：改打 lemo-e2e 专用后端（.e2e-sb，npm run e2e:real:up 起的那套），不在仓库根目录跑 supabase status。
//   四项都经 tools/e2e/real-backend.mjs 的 statusEnvWithDb() 取（过它的护栏：project_id、553xx 端口、API 必须 55321；
//   DB_URL 用 status 实际给的地址，必须是本机、55322，审查 M1）。
// 不传 --e2e-sb（11-05 主持人定，安全红线）：只有 CI 放行（guard.mjs：CI=true、没有 SUPABASE_* 变量和 .env*、config 顶层恰好一行 project_id = "lemo-ci"），
//   本机直接拒绝、提示加 --e2e-sb——仓库 config 的 project_id 是 lemomemo，本机绝不能写进去。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkRepoSupabase } from './guard.mjs';

const root = resolve(import.meta.dirname, '..', '..', '..');

function readStatus() {
  const cliJs = join(root, 'node_modules', 'supabase', 'dist', 'supabase.js');
  const tries = [['supabase', ['status', '-o', 'json']]];
  if (existsSync(cliJs)) tries.push([process.execPath, [cliJs, 'status', '-o', 'json']]);
  for (const [cmd, args] of tries) {
    try {
      const out = execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
    } catch { /* 换下一种 */ }
  }
  return null;
}

const local = (u) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(u).hostname); } catch { return false; } };

async function readE2eStatus() {
  const rb = await import('../../../tools/e2e/real-backend.mjs');
  try {
    const e = rb.statusEnvWithDb();
    return { API_URL: e.API_URL, ANON_KEY: e.ANON_KEY, SERVICE_ROLE_KEY: e.SERVICE_ROLE_KEY, DB_URL: e.DB_URL };
  } catch (err) {
    console.error(`store-it --e2e-sb：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const e2eSb = process.argv.slice(2).includes('--e2e-sb');
const refused = e2eSb ? null : checkRepoSupabase(root, process.env);
const s = refused ? null : e2eSb ? await readE2eStatus() : readStatus();
if (refused) {
  console.error(`store-it：${refused}`);
  process.exitCode = 2;
} else if (!s || !s.API_URL || !s.DB_URL || !s.SERVICE_ROLE_KEY || !s.ANON_KEY) {
  console.error(e2eSb ? 'store-it：读不到 lemo-e2e 的状态（先 npm run e2e:real:up，跑完 npm run e2e:real:down）' : 'store-it：读不到 supabase status（本地 Supabase 没起？先 supabase start -x studio）');
  process.exitCode = 1;
} else if (!local(s.API_URL) || !local(s.DB_URL)) {
  console.error('store-it：只打本机的 Supabase（supabase status 给的地址不是 127.0.0.1 / localhost / [::1]）');
  process.exitCode = 1;
} else {
  execFileSync(process.execPath, [join(root, 'build', 'copy_shared.mjs')], { cwd: root, stdio: 'inherit' });
  mkdirSync(join(root, 'supabase', '.temp'), { recursive: true });
  // 每组文件一个 deno 进程（harness 收尾会关库连接，import 它的文件各占一个进程）：网络只许 127.0.0.1，写只许 supabase/.temp/。
  // timeout：卡住时杀掉（status 为 null，按失败算），不拖到整个 db 任务的 40 分钟上限
  const env = { ...process.env, IT_API_URL: s.API_URL, IT_DB_URL: s.DB_URL, IT_ANON_KEY: s.ANON_KEY, IT_SERVICE_KEY: s.SERVICE_ROLE_KEY };
  const denoTest = (files, timeout) => {
    const r = spawnSync('deno', [
      'test', '--config', 'deno.json', '--allow-net=127.0.0.1,localhost', '--allow-env', '--allow-read=.', '--allow-write=supabase/.temp',
      ...files.map((f) => `supabase/tests/store-it/${f}`),
    ], { cwd: root, stdio: 'inherit', env, ...(timeout ? { timeout } : {}) });
    if (r.error) console.error(`store-it：${files.join('、')} 没跑完（${r.error.message}）`);
    return r.status ?? 1;
  };
  const status = [
    // K3-store-it：account、invite-admin 两个 index.ts
    denoTest(['account-store.it.ts', 'invite-admin-store.it.ts']),
    // PURGE-cpu-budget 返工：多账号同时到期、同时有一批要提醒的
    denoTest(['purge-remind.it.ts']),
    // B2 D3 第 6 点：推送全发进程内替身，不联网；正常约 35 秒
    denoTest(['push-dispatch-d3.it.ts'], 180_000),
    // B3（11-07）：ai-parse、ai-voice、token-admin、claude-intake 按真 index.ts 组装打真库。它换掉了 globalThis.fetch（Gemini 替身，不联网）和 Deno.serve
    denoTest(['ai-fns-store.it.ts'], 180_000),
    // R-411 后续（11-13）：批量入队范围 SQL（remind_enqueue）和替身（MemDb.enqueueScope）同一批行比对，整个在一个事务里、最后回滚；几秒
    denoTest(['remind-enqueue-parity.it.ts'], 120_000),
    // R-350 评审第 2 条（11-13）：两个连接同时往同一条待办加子任务，锁主待办行后 30 项上限守得住；几秒
    denoTest(['todo-items-cap.it.ts'], 120_000),
    // B5（11-14）：隐私记 vault / vault-image / account 导出和 rebind 的 SQL 第一次上真库（vault-harness.ts 切 fn_vault、fn_ai 跑真 store）；两组各占一个进程，各几秒
    denoTest(['vault-store.it.ts'], 120_000),
    denoTest(['vault-move.it.ts'], 120_000),
  ];
  process.exitCode = status.find((x) => x !== 0) ?? 0;
}
