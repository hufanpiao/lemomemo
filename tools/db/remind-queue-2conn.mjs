// 真库两连接并发测试：remind_queue 的租约式出队（迁移 20261104130000；安全审查 S3、必改 2，代码审查 S_noLockedRecheck）。
// PGlite、pgTAP 都只有一个会话，造不出“另一个事务锁着队列行”的情况，所以单独做成这份可以重复跑的脚本：
//   A. 用户事务改一行待办（入队触发器锁住队列行）并持锁 7 秒，期间 finish 这个租约：不等锁（远小于 lock_timeout 5 秒）、不报错，
//      同租约的其余项照常删掉，锁着的那项留着；用户提交后它的租约、attempts 已被清零，下一轮当新项算。放回（p_release）的同样跳过。
//   B. 一个连接出队后持锁 4 秒不提交，另一个连接同时出队：skip locked 跳过、一项都取不到、不等锁；前一个提交后，
//      租约没过期的项也不会被重取（加锁后再判一次租约）。队列里另放一条孤儿：两轮都要删它，后一轮也不等前一轮提交
//      （删孤儿同样 skip locked；不加时实测后一轮要等 3 秒多）。
// 用法（仓库根目录，先在 lemo-b2push 的工作目录 supabase start、db reset --local）：
//   node tools/db/remind-queue-2conn.mjs [容器名，默认 supabase_db_lemo-b2push]
//   node tools/db/remind-queue-2conn.mjs --dry [容器名]   只判断这个容器名放不放行，不连库（退出码 0 放行、2 拒绝）
// 只连本机 docker 容器里的库，用 psql（docker exec）；容器名带 lemomemo、lemo-purgeit 的一律拒绝（那是本机在用的库），
//   不看任何环境变量、没有例外（安全复审二 R1-1：act 在本机跑工作流会自动设 CI、GITHUB_ACTIONS、ACT 并挂宿主 docker socket，
//   靠环境变量放行会连到本机的 lemomemo）。CI 的 db 任务在 supabase start 之前把 config.toml 的 project_id 改成 lemo-ci，
//   这里连 supabase_db_lemo-ci（ci.yml；tests/build/remind-queue-2conn-guard.test.ts 钉住放行规则和 CI 写法）。
// 改过迁移 20261104130000 里的 skip locked（出队删孤儿、finish 的放回和删除）或加锁后再判租约那几句，本机也要跑一次（上线与回滚手册）。造的数据用固定的 2c000000-… id，
// 跑完删掉（auth 用户删掉后待办级联删除，队列项一并删）。退出码 0 = 全过，1 = 有失败。
/* global console -- Node 24 的全局 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const dry = process.argv[2] === '--dry';
const container = process.argv[dry ? 3 : 2] ?? 'supabase_db_lemo-b2push';
const allowed = /^supabase_db_[a-z0-9-]+$/i.test(container) && !/lemomemo|lemo-purgeit/i.test(container);
if (!allowed) {
  console.error(`拒绝：容器名 ${container} 不是测试库（只允许 supabase_db_<测试项目>，lemomemo、lemo-purgeit 在任何环境都不许）`);
  process.exit(2);
}
if (dry) {
  console.log(`放行：${container}`);
  process.exit(0);
}

const U = '2c000000-0000-4000-8000-0000000000a1';
const T = ['2c000000-0000-4000-8000-000000000001', '2c000000-0000-4000-8000-000000000002', '2c000000-0000-4000-8000-000000000003'];
const K = '2c000000-0000-4000-8000-00000000c1a1';
const ORPHAN = '2c000000-0000-4000-8000-0000000000ff';   // 队列里有、todos 里没有
const ids = T.map((x) => `'${x}'`).join(', ');

/** 开一个 psql 连接跑 sql，回 { code, out, err, ms } */
function psql(sql) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim(), ms: Date.now() - t0 }));
    p.stdin.end(sql);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (ok, msg, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${msg}${ok || !detail ? '' : `（${detail}）`}`);
  if (!ok) failed++;
};

const SETUP = `
delete from auth.users where id = '${U}';
insert into auth.users (id, email) values ('${U}', '2conn@test.local');
insert into public.profiles (user_id) values ('${U}') on conflict do nothing;
insert into public.todos (id, user_id, title, created_at, updated_at) values
  ('${T[0]}', '${U}', 't', 1, 1), ('${T[1]}', '${U}', 't', 1, 1), ('${T[2]}', '${U}', 't', 1, 1);
delete from private.remind_queue where id in (${ids});
`;
const CLEANUP = `delete from private.remind_queue where id in (${ids}, '${ORPHAN}'); delete from auth.users where id = '${U}';`;
const queueState = `select coalesce(string_agg(right(id::text, 1) || ':' || coalesce((claim = '${K}')::text, 'null') || ':' || attempts, ',' order by id), '') from private.remind_queue where id in (${ids});`;

async function scenarioA(release) {
  const tag = release ? 'A2（放回）' : 'A1（删除）';
  let r = await psql(`${SETUP}
insert into private.remind_queue (table_name, id, claim, claimed_at, attempts)
  select 'todos', x, '${K}', now(), 1 from unnest(array[${ids}]::uuid[]) x;`);
  check(r.code === 0, `${tag} 造数据`, r.err);
  // 连接 1：用户改第 1 行待办，入队触发器锁住它的队列行（清租约、attempts 清零，还没提交），持锁 7 秒
  const user = psql(`begin; update public.todos set due = '2026-12-01' where id = '${T[0]}'; select pg_sleep(7); commit;`);
  await sleep(1000);
  // 连接 2：finish 这个租约
  const rel = release ? `'[{"table_name": "todos", "id": "${T[0]}"}, {"table_name": "todos", "id": "${T[1]}"}]'` : `'[]'`;
  r = await psql(`select private.remind_queue_finish('${K}', ${rel}); ${queueState}`);
  check(r.code === 0, `${tag} 用户持锁时 finish 不报错（不撞 lock_timeout）`, r.err);
  check(r.ms < 3000, `${tag} finish 不等锁：${r.ms} 毫秒`);
  const want = release ? '1:true:1,2:null:0' : '1:true:1';
  check(r.out === want, `${tag} 锁着的第 1 项跳过、租约留着；${release ? '第 2 项放回（attempts 1 → 0），第 3 项删掉' : '第 2、3 项删掉'}`, `实际 ${r.out}`);
  const ur = await user;
  check(ur.code === 0, `${tag} 用户事务照常提交`, ur.err);
  r = await psql(queueState);
  check(r.out === (release ? '1:null:0,2:null:0' : '1:null:0'), `${tag} 用户提交后：第 1 项租约清空、attempts 清零（下一轮当新项算）`, `实际 ${r.out}`);
  await psql(CLEANUP);
}

async function scenarioB() {
  let r = await psql(`${SETUP}
insert into private.remind_queue (table_name, id) select 'todos', x from unnest(array[${ids}]::uuid[]) x;
insert into private.remind_queue (table_name, id) values ('todos', '${ORPHAN}');`);
  check(r.code === 0, 'B 造数据（3 项加 1 条孤儿）', r.err);
  // 连接 1：出队后持锁 4 秒不提交
  const first = psql(`begin; select count(*) from private.remind_queue_pop(500, 180, false) where id in (${ids}); select pg_sleep(4); commit;`);
  await sleep(1000);
  // 连接 2：同时出队
  r = await psql(`select count(*) from private.remind_queue_pop(500, 180, false) where id in (${ids});`);
  check(r.code === 0 && r.out === '0', '连接 2 同时出队：skip locked，一项都取不到', `实际 ${r.out} ${r.err}`);
  check(r.ms < 3000, `连接 2 不等锁（连接 1 正删着同一条孤儿也不等）：${r.ms} 毫秒`);
  const fr = await first;
  check(fr.code === 0 && fr.out.split('\n')[0] === '3', '连接 1 取到 3 项并提交', `实际 ${fr.out} ${fr.err}`);
  r = await psql(`select count(*) from private.remind_queue_pop(500, 180, true) where id in (${ids});
select count(distinct claim) || ':' || count(*) filter (where attempts = 1) from private.remind_queue where id in (${ids});`);
  check(r.out === '0\n1:3', '连接 1 提交后再单项重试出队：租约没过期，不重取；3 项都是连接 1 的同一个租约、attempts 1', `实际 ${r.out.replace('\n', ' / ')}`);
  await psql(CLEANUP);
}

const ping = await psql('select 1');
if (ping.code !== 0) {
  console.error(`连不上 ${container}：${ping.err}`);
  process.exit(2);
}
await scenarioA(false);
await scenarioA(true);
await scenarioB();
const left = await psql(`select count(*) from private.remind_queue where id in (${ids}, '${ORPHAN}'); select count(*) from auth.users where id = '${U}';`);
check(left.out === '0\n0', '跑完造的数据都删了', left.out);
console.log(failed ? `共 ${failed} 项失败` : '全部通过');
process.exit(failed ? 1 : 0);
