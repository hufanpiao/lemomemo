// 真库两连接并发测试：remind_queue 的租约式出队（迁移 20261104130000；安全审查 S3、必改 2，代码审查 S_noLockedRecheck）。
// PGlite、pgTAP 都只有一个会话，造不出“另一个事务锁着队列行”的情况，所以单独做成这份可以重复跑的脚本：
//   A. 用户事务改一行待办（入队触发器锁住队列行）并持锁 7 秒，期间 finish 这个租约：不等锁（远小于 lock_timeout 5 秒）、不报错，
//      同租约的其余项照常删掉，锁着的那项留着；用户提交后它的租约、attempts 已被清零，下一轮当新项算。放回（p_release）的同样跳过。
//   B. 一个连接出队后持锁 7 秒不提交，另一个连接同时出队：skip locked 跳过、一项都取不到、不等锁；前一个提交后，
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
// 11-05 判定口径（2b65b43 的 CI 第一次真跑报“连接 2 不等锁：5883 毫秒”，lemo-e2e 上同样的脚本 185 毫秒、服务器侧 4 毫秒，复现不出等锁）：
//   原来按 docker exec 的墙钟判，墙钟含容器里起 psql 的时间，CI runner 上起得慢就分不清“等锁”和“起得慢”；连接 2 也是固定晚 1 秒起，
//   连接 1 起得更慢时两边谁先拿锁都说不准。改成：① 持锁方真的进了 pg_sleep（pg_stat_activity 查到）才让另一边动手；
//   ② “不等锁”按服务器上的证据判（noWaitVerdict）：这条语句在服务器上的耗时（statement_timestamp 到 clock_timestamp）小于 1 秒，
//      并且它在持锁方提交之前就结束了——等持锁方的锁只能在它提交以后才结束，所以这一条是决定性的；墙钟只打印、不判；
//   ③ 判不过时打印另一边的等待事件、拦着它的 pid（pg_blocking_pids），下次 CI 再失败能直接看出在等什么。
// 11-05 安全复审五：R5-1 持锁方的时刻改在 commit 之前、同一事务里 sleep 之后取；另一边把语句开始时刻也传回，开始晚于它就报“起晚了”（不算通过）；
//   B 场景持锁拉到 7 秒（和 A 一致）。R5-2 判定挪到 remind-queue-2conn-verdict.mjs，这里直接调 main()（不再比 import.meta.url 和 argv[1]）；
//   CI 那一步另核对输出里有“全部通过”。
/* global console -- Node 24 的全局 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { NOW_MS, START_MS, STMT_MS, noWaitVerdict } from './remind-queue-2conn-verdict.mjs';

await main();

async function main() {

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
  const user = psql(`begin; update public.todos set due = '2026-12-01' where id = '${T[0]}'; select pg_sleep(7) /* 2conn-holder */; select ${NOW_MS}; commit;`);
  if (!(await waitSleeping(tag))) return;
  // 连接 2：finish 这个租约（最后一行回服务器上的耗时和结束时刻）
  const rel = release ? `'[{"table_name": "todos", "id": "${T[0]}"}, {"table_name": "todos", "id": "${T[1]}"}]'` : `'[]'`;
  const t = await timed(`/* 2conn-finish */ with f as materialized (select private.remind_queue_finish('${K}', ${rel}) as v) select ${STMT_MS} || '|' || ${START_MS} || '|' || ${NOW_MS} from f; ${queueState}`);
  r = t.r;
  check(r.code === 0, `${tag} 用户持锁时 finish 不报错（不撞 lock_timeout）`, r.err);
  const want = release ? '1:true:1,2:null:0' : '1:true:1';
  check(t.rest === want, `${tag} 锁着的第 1 项跳过、租约留着；${release ? '第 2 项放回（attempts 1 → 0），第 3 项删掉' : '第 2、3 项删掉'}`, `实际 ${t.rest}`);
  const ur = await user;
  check(ur.code === 0, `${tag} 用户事务照常提交`, ur.err);
  const v = noWaitVerdict({ startAt: t.startAt, serverMs: t.serverMs, endAt: t.endAt, holderCommitAt: Number(ur.out.split('\n').pop()) });
  check(v.ok, `${tag} finish 不等锁（服务器上 ${t.serverMs} 毫秒，墙钟 ${r.ms} 毫秒）`, `${v.why}${t.peek ? `；1.5 秒时：${t.peek}` : ''}`);
  r = await psql(queueState);
  check(r.out === (release ? '1:null:0,2:null:0' : '1:null:0'), `${tag} 用户提交后：第 1 项租约清空、attempts 清零（下一轮当新项算）`, `实际 ${r.out}`);
  await psql(CLEANUP);
}

async function scenarioB() {
  let r = await psql(`${SETUP}
insert into private.remind_queue (table_name, id) select 'todos', x from unnest(array[${ids}]::uuid[]) x;
insert into private.remind_queue (table_name, id) values ('todos', '${ORPHAN}');`);
  check(r.code === 0, 'B 造数据（3 项加 1 条孤儿）', r.err);
  // 连接 1：出队后持锁 7 秒不提交（R5-1：和 A 一致，CI 上起 psql 慢也来得及）
  const first = psql(`begin; select count(*) from private.remind_queue_pop(500, 180, false) where id in (${ids}); select pg_sleep(7) /* 2conn-holder */; select ${NOW_MS}; commit;`);
  if (!(await waitSleeping('B'))) return;
  // 连接 2：连接 1 拿着锁时出队（这一条语句的耗时、结束时刻同一行回）
  const t = await timed(`/* 2conn-pop */ with p as materialized (select count(*) filter (where id in (${ids})) as n from private.remind_queue_pop(500, 180, false)) select ${STMT_MS} || '|' || ${START_MS} || '|' || ${NOW_MS} || '|' || n from p;`);
  r = t.r;
  check(r.code === 0 && t.extra === '0', '连接 2 同时出队：skip locked，一项都取不到', `实际 ${r.out} ${r.err}`);
  const fr = await first;
  check(fr.code === 0 && fr.out.split('\n')[0] === '3', '连接 1 取到 3 项并提交', `实际 ${fr.out} ${fr.err}`);
  const v = noWaitVerdict({ startAt: t.startAt, serverMs: t.serverMs, endAt: t.endAt, holderCommitAt: Number(fr.out.split('\n').pop()) });
  check(v.ok, `连接 2 不等锁（连接 1 正删着同一条孤儿也不等；服务器上 ${t.serverMs} 毫秒，墙钟 ${r.ms} 毫秒）`, `${v.why}${t.peek ? `；1.5 秒时：${t.peek}` : ''}`);
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

/** 持锁方真的进了 pg_sleep（锁已拿到）才往下走；最多等 15 秒 */
async function waitSleeping(tag) {
  for (let i = 0; i < 75; i++) {
    const r = await psql("select count(*) from pg_stat_activity where wait_event = 'PgSleep' and query like '%2conn-holder%';");
    if (r.out === '1') return true;
    await sleep(200);
  }
  check(false, `${tag} 持锁方 15 秒内没进 pg_sleep`);
  return false;
}

/** 判不过时：看另一边在等什么 */
async function whyWaiting() {
  const r = await psql("select pid || ' ' || coalesce(wait_event_type, '-') || '/' || coalesce(wait_event, '-') || ' 被 ' || pg_blocking_pids(pid)::text || ' 拦着：' || left(query, 80) from pg_stat_activity where query like '%2conn-%' and pid <> pg_backend_pid();");
  return r.out.replace(/\n/g, '；');
}

/** 跑 sql（第一行是“服务器上耗时|开始时刻|结束时刻|其他”，其余行是别的查询）；超过 1.5 秒还没完就先看一眼它在等什么 */
async function timed(sql) {
  let peek = '';
  let done = false;
  const run = psql(sql).then((r) => { done = true; return r; });
  await sleep(1500);
  if (!done) peek = await whyWaiting();
  const r = await run;
  const [head = '', ...rest] = r.out.split('\n');
  const [serverMs, startAt, endAt, extra] = head.split('|');
  return { r, serverMs: Number(serverMs), startAt: Number(startAt), endAt: Number(endAt), extra, peek, rest: rest.join('\n') };
}
}
