// B1 QA 报告 6.2 节 E 组 P0 里离线测不了的几项，在 lemo-e2e 上实跑（只碰 lemo-e2e，跑完由调用的人 npm run e2e:real:down）：
//   TC-B1-131 ⑥：两个数据库连接同时各对同一个任务取 20 片（export_job_take），count 正好 40、两边拿到的 parts 合起来正好 1～40 不重不漏；
//   TC-B1-143 ⑤：另一个连接先拿住 export_size_over 的 advisory 锁（7310310001），再调预检回 -2、不扫任何表；锁放开后照常回合计；
//   TC-B1-138 ①③：故障注入（只在 lemo-e2e 的库里临时改）——① 收回 service_role 对 export_job_start 的执行权；③ 在 public.logs 上挂一个
//     只拦本测试账号 act = 'export' 的触发器。两档都核对：start 回 503 try_later、当天导出次数退回（account 0）、export-refund +1、
//     counters 里没有这个账号的 export-job 键、logs 没有 export 行、函数日志有 export_job_failed / export_log_failed；finally 里恢复，恢复后正常 start 一次核对已恢复；
//   TC-B1-130 ①：经真的 account 函数，取片之间 ① 退出登录（/auth/v1/logout）② 会话被吊销（写 private.revoked_sessions，同远程移除设备）
//     ③ 管理员停用（profiles.disabled_at），下一片都被拒、不回 gzip；
//   TC-B1-130 ④：账号里放一个标记串，整份导出取完（标记确实在包里），再查这段时间 edge runtime、kong、db 三个容器的日志里没有标记串。
//     /sb 转发不在 lemo-e2e 链路上（要 wrangler），它的日志另由 tests/functions/account-export-p0-auth.test.ts 核对。
//
// ⚠ 138 故障注入期间（收回执行权、logs 上挂触发器）影响整个 lemo-e2e：不要和别的实测（e2e:real、export-full-account、预览脚本演练等）同时跑。
// 用法（仓库根目录，先 npm run e2e:real:up；跑完 npm run e2e:real:down）：node tools/e2e/export-p0-real.mjs
// 只打印核对结果（✓ / ✗）、条数、毫秒数和错误码；本地演示密钥、令牌只在进程内用，不打印。退出码 0 = 全过。
/* global fetch, console -- Node 24 的全局 */
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';
import { exit } from 'node:process';
import { gunzipSync } from 'node:zlib';
import { statusEnv } from './real-backend.mjs';
import { lengths, seedSql } from './export-load-seed.mjs';

const DB = 'supabase_db_lemo-e2e';
const EDGE = 'supabase_edge_runtime_lemo-e2e';
const KONG = 'supabase_kong_lemo-e2e';
const NEXT = 'x-lemo-export-next';
const LOCK_KEY = 7310310001;                 // 迁移 20261031100000 export_size_over 的固定锁键
const MAX_TOTAL_RAW = 480 * 1024 * 1024;     // account/common.ts EXPORT_LIMITS.maxTotalRawBytes
const BUDGET_MS = 15000;                     // EXPORT_LIMITS.sizeCheckBudgetMs

// ---------- 只认 lemo-e2e ----------
function docker(args, input) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} 失败：${(r.stderr || '').slice(0, 500)}`);
  return r.stdout;
}
const running = docker(['ps', '--format', '{{.Names}}']).split(/\r?\n/);
for (const c of [DB, EDGE, KONG]) if (!running.includes(c)) { console.error(`没在跑：${c}（先 npm run e2e:real:up）`); exit(2); }
const env = statusEnv();
const api = new URL(env.API_URL);
if (!(Number(api.port) >= 55320 && Number(api.port) <= 55329) || !['127.0.0.1', 'localhost'].includes(api.hostname)) { console.error('API_URL 不是 lemo-e2e 的 553xx，停'); exit(2); }
const API = env.API_URL.replace(/\/$/, '');
const SR = env.SERVICE_ROLE_KEY;
const ANON = env.ANON_KEY;
const FN = `${API}/functions/v1/account`;

const PSQL = ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-A', '-t', '-F', '=', '-v', 'ON_ERROR_STOP=1'];
/** 在 lemo-e2e 的库里跑 SQL（一个连接，跑完断开） */
const psql = (sql) => docker(PSQL, sql).trim();
/** 同上，但不等：返回 Promise（两个连接同时跑用） */
function psqlAsync(sql) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', PSQL, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let errText = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { errText += d; });
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`psql 失败：${errText.slice(0, 300)}`))));
    p.stdin.end(sql);
  });
}

async function j(path, init, key = SR) {
  const r = await fetch(API + path, { ...init, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return t ? JSON.parse(t) : null;
}

const checks = [];
const ok = (cond, what) => { checks.push(`${cond ? '✓' : '✗'} ${what}`); console.log(checks.at(-1)); };

/** 建一个 @lemomemo.test 账号（带 profile） */
async function newUser(tag) {
  const email = `export-p0-${tag}-${Date.now()}@lemomemo.test`;
  const u = await j('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, email_confirm: true }) });
  if (!/^[0-9a-f-]{36}$/.test(u.id)) throw new Error('user id 不对');
  return { uid: u.id, email };
}
/** 验证码（magiclink）会话：返回请求头和 JWT 里的 session_id */
async function otpSession(email) {
  const link = await j('/auth/v1/admin/generate_link', { method: 'POST', body: JSON.stringify({ type: 'magiclink', email }) });
  const sess = await j('/auth/v1/verify', { method: 'POST', body: JSON.stringify({ type: 'magiclink', token_hash: link.hashed_token ?? link.properties?.hashed_token }) }, ANON);
  const payload = JSON.parse(Buffer.from(sess.access_token.split('.')[1], 'base64url').toString());
  return { headers: { apikey: ANON, authorization: `Bearer ${sess.access_token}` }, sid: payload.session_id, jwt: sess.access_token };
}
const call = (h, body) => fetch(FN, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function errOf(res) {
  try { const e = JSON.parse(await res.text()).error; return typeof e === 'string' && /^[a-z_]{1,40}$/.test(e) ? e : '?'; } catch { return '?'; }
}
const countersOf = (uid) => Object.fromEntries(psql(`select split_part(key, ':', 1), sum(count) from private.counters where key like '%:${uid}:%' group by 1;`)
  .split(/\r?\n/).filter(Boolean).map((l) => l.split('=')).map(([k, v]) => [k, Number(v)]));
const jobKeys = (uid) => Number(psql(`select count(*) from private.counters where key like 'export-job:${uid}:%';`));
const exportLogs = (uid) => Number(psql(`select count(*) from public.logs where user_id = '${uid}' and src = 'account' and act = 'export';`));
const logsOf = (c, since) => { const r = spawnSync('docker', ['logs', '--since', since, c], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return `${r.stdout}${r.stderr}`; };

let failedHard = false;
try {
  // ================= TC-B1-131 ⑥：两个连接同时各取 20 片 =================
  {
    const [u, e, s] = [randomUUID(), randomUUID(), randomUUID()];
    // 任务行要挂在一个真用户上？counters 没有外键，键的三段约束只看格式；用随机 uuid 即可
    psql(`select private.export_job_start('${u}', '${e}', 'omitted', '${s}');`);
    const at = psql(`select to_char((clock_timestamp() + interval '5 seconds') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z';`);
    const take = `select parts || ':' || to_char(clock_timestamp() at time zone 'UTC', 'HH24:MI:SS.US') from private.export_job_take('${u}', '${e}', 'omitted', '${s}', 100, 3600);`;
    const script = `select pg_sleep_until('${at}');\n` + Array.from({ length: 20 }, () => `${take}\nselect pg_sleep(0.02);`).join('\n');
    const [o1, o2] = await Promise.all([psqlAsync(script), psqlAsync(script)]);
    const rows = (o) => o.split(/\r?\n/).filter((l) => /^\d+:/.test(l)).map((l) => ({ n: Number(l.split(':')[0]), t: l.slice(l.indexOf(':') + 1) }));
    const r1 = rows(o1);
    const r2 = rows(o2);
    const all = [...r1, ...r2].map((r) => r.n).sort((a, b) => a - b);
    const count = Number(psql(`select count from private.counters where key = 'export-job:${u}:${e}.omitted.${s}';`));
    ok(r1.length === 20 && r2.length === 20, `131 ⑥ 两个连接各取 20 片都拿到结果（${r1.length} / ${r2.length}）`);
    ok(count === 40, `131 ⑥ 并发后任务行 count 正好 40（实际 ${count}）`);
    ok(all.join(',') === Array.from({ length: 40 }, (_, i) => i + 1).join(','), '131 ⑥ 两边拿到的 parts 合起来正好 1～40，不重不漏（update … returning 原子 +1）');
    // 两个连接的时间段确实重叠（不是一个跑完另一个才开始）
    const span = (r) => [r[0]?.t ?? '', r.at(-1)?.t ?? ''];
    const [a0, a1] = span(r1);
    const [b0, b1] = span(r2);
    const overlap = a0 <= b1 && b0 <= a1;
    const interleaved = r1.map((r) => r.n).some((n, i, arr) => i > 0 && n !== (arr[i - 1] ?? 0) + 1);
    ok(overlap && interleaved, `131 ⑥ 两个连接的取片时间重叠且 parts 交错（连接 1 ${a0}～${a1}，连接 2 ${b0}～${b1}）`);
    psql(`delete from private.counters where key = 'export-job:${u}:${e}.omitted.${s}';`);
  }

  // ================= TC-B1-143 ⑤：另一个会话先拿住锁 =================
  const U1 = await newUser('a');
  psql(seedSql(U1.uid, lengths(false), false, 30, 30));
  {
    const holder = psqlAsync(`begin;\nselect pg_advisory_xact_lock(${LOCK_KEY});\nselect pg_sleep(4);\ncommit;`);
    // 轮询 pg_locks：看到别的连接已经拿住 7310310001（advisory 锁，classid/objid 是 bigint 的高、低 32 位）再测，最多等 10 秒
    const held = `select count(*) from pg_locks where locktype = 'advisory' and granted and classid = ${Math.floor(LOCK_KEY / 2 ** 32)} and objid = ${LOCK_KEY % 2 ** 32} and objsubid = 1;`;
    let seen = false;
    for (let i = 0; i < 100 && !seen; i++) { seen = psql(held) === '1'; if (!seen) await sleep(100); }
    ok(seen, '143 ⑤ 已看到另一个连接拿住了 advisory 锁 7310310001（pg_locks）');
    const out = psql(`\\timing on\nbegin;\nselect private.export_size_over('${U1.uid}', 'omitted', ${MAX_TOTAL_RAW}, ${BUDGET_MS});\n` +
      `select 'scans=' || coalesce(sum(seq_scan + coalesce(idx_scan, 0)), 0) from pg_stat_xact_user_tables where schemaname = 'public';\ncommit;`);
    const v = Number(out.split(/\r?\n/).find((l) => /^-?\d+$/.test(l.trim())) ?? NaN);
    const ms = Number([...out.matchAll(/Time: ([\d.]+) ms/g)][1]?.[1] ?? NaN);   // 第 2 条语句（begin 之后）的耗时
    const scans = Number(/scans=(\d+)/.exec(out)?.[1] ?? NaN);
    ok(v === -2, `143 ⑤ 另一个连接拿着锁时预检回 -2（实际 ${v}，${Math.round(ms)} ms）`);
    ok(scans === 0, `143 ⑤ 回 -2 的那次没扫任何 public 表（本事务 seq_scan + idx_scan = ${scans}）`);
    await holder;
    const after = Number(psql(`select private.export_size_over('${U1.uid}', 'omitted', ${MAX_TOTAL_RAW}, ${BUDGET_MS});`));
    ok(after > 0, `143 ⑤ 锁放开以后同样的调用照常回合计（${after} 字节）`);
  }

  // ================= TC-B1-130 ④：日志里没有导出内容 =================
  const MARK = `P0MARK${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  psql(`update public.notes set body = '${MARK}' where id = (select id from public.notes where user_id = '${U1.uid}' order by id limit 1);`);
  {
    const since = new Date(Date.now() - 2000).toISOString();
    const s = await otpSession(U1.email);
    const st = await call(s.headers, { action: 'export', step: 'start' });
    ok(st.status === 200, `130 ④ start 200（实际 ${st.status}）`);
    const { export_id: id } = st.status === 200 ? await st.json() : { export_id: randomUUID() };
    const bufs = [];
    let cursor = null;
    for (let i = 0; i < 20; i++) {
      const r = await call(s.headers, { action: 'export', step: 'part', export_id: id, cursor });
      if (r.status !== 200) { ok(false, `130 ④ 取片 ${r.status} ${await errOf(r)}`); break; }
      bufs.push(Buffer.from(await r.arrayBuffer()));
      cursor = r.headers.get(NEXT);
      if (cursor === 'done') break;
    }
    const text = gunzipSync(Buffer.concat(bufs)).toString('utf8');
    ok(text.includes(MARK), '130 ④ 标记串确实在导出包里');
    await sleep(1500);   // 等容器日志落盘
    for (const c of [EDGE, KONG, DB]) ok(!logsOf(c, since).includes(MARK), `130 ④ ${c} 这段时间的日志里没有标记串（没有响应体、没有行内容）`);
    ok(!logsOf(EDGE, since).includes(id), '130 ④ 函数日志里也没有 export_id');

    // ================= TC-B1-130 ①：取片之间退出登录、会话吊销、停用 =================
    const midway = async (label) => {
      const ss = await otpSession(U1.email);
      const r0 = await call(ss.headers, { action: 'export', step: 'start' });
      if (r0.status !== 200) { ok(false, `130 ① ${label}：start ${r0.status} ${await errOf(r0)}`); return null; }
      const { export_id: eid } = await r0.json();
      const r1 = await call(ss.headers, { action: 'export', step: 'part', export_id: eid, cursor: null });
      const next = r1.headers.get(NEXT);
      ok(r1.status === 200, `130 ① ${label}：第 1 片 200（回的游标：${next === 'done' ? 'done' : '有'}）`);
      await r1.arrayBuffer();
      return { ss, eid, cursor: next === 'done' ? null : next };
    };
    const denied = async (label, m, want) => {
      const before = countersOf(U1.uid)['export-part'] ?? 0;
      // “下一片”用第 1 片回的真实游标；第 1 片已经是最后一片（回 done）时按协议重取第 1 片（cursor null）
      const r = await call(m.ss.headers, { action: 'export', step: 'part', export_id: m.eid, cursor: m.cursor });
      const code = await errOf(r);
      const type = r.headers.get('content-type') ?? '';
      ok(want.includes(`${r.status} ${code}`) && !type.includes('gzip') && r.headers.get(NEXT) === null,
        `130 ① ${label}：下一片被拒 ${r.status} ${code}，不是 gzip、没有游标头（期望 ${want.join(' 或 ')}）`);
      ok((countersOf(U1.uid)['export-part'] ?? 0) === before, `130 ① ${label}：被拒的那次没扣 export-part（鉴权在前）`);
    };
    // 今天 U1 已用 1 次导出；下面三档各用 1 次 start 会超当天 3 次，所以第三档换 U3
    const m1 = await midway('退出登录');
    if (m1) {
      const lo = await fetch(`${API}/auth/v1/logout?scope=local`, { method: 'POST', headers: m1.ss.headers });
      ok(lo.status === 204, `130 ① 退出登录 /auth/v1/logout 回 ${lo.status}`);
      await denied('退出登录', m1, ['401 unauthorized', '401 session_revoked']);
    }
    const m2 = await midway('会话吊销');
    if (m2) {
      psql(`insert into private.revoked_sessions (session_id, user_id) values ('${m2.ss.sid}', '${U1.uid}');`);
      await denied('会话吊销', m2, ['401 session_revoked']);
    }
  }
  const U3 = await newUser('c');
  psql(`insert into public.profiles (user_id, display_name) values ('${U3.uid}', 'export-p0');`);
  {
    const ss = await otpSession(U3.email);
    const r0 = await call(ss.headers, { action: 'export', step: 'start' });
    const { export_id: eid } = r0.status === 200 ? await r0.json() : { export_id: randomUUID() };
    const r1 = await call(ss.headers, { action: 'export', step: 'part', export_id: eid, cursor: null });
    ok(r0.status === 200 && r1.status === 200, `130 ① 停用：start、第 1 片 200（${r0.status} / ${r1.status}）`);
    const next = r1.headers.get(NEXT);
    await r1.arrayBuffer();
    psql(`update public.profiles set disabled_at = now(), disabled_reason = 'admin' where user_id = '${U3.uid}';`);
    const r2 = await call(ss.headers, { action: 'export', step: 'part', export_id: eid, cursor: next === 'done' || next === null ? null : next });
    const code = await errOf(r2);
    ok(r2.status === 403 && code === 'account_disabled' && !(r2.headers.get('content-type') ?? '').includes('gzip'), `130 ① 管理员停用：下一片 ${r2.status} ${code}`);
  }

  // ================= TC-B1-138 ①③：故障注入 =================
  const U2 = await newUser('b');
  psql(`insert into public.profiles (user_id, display_name) values ('${U2.uid}', 'export-p0');`);
  const s2 = await otpSession(U2.email);
  const faults = [
    { tag: '①', name: 'export_job_start 报错（收回 service_role 的执行权）', code: 'export_job_failed',
      on: 'revoke execute on function private.export_job_start(uuid, uuid, text, uuid) from service_role;',
      off: 'grant execute on function private.export_job_start(uuid, uuid, text, uuid) to service_role;' },
    { tag: '③', name: '写 logs act = export 报错（logs 上临时触发器，只拦本账号）', code: 'export_log_failed',
      on: `create function public.e2e_p0_fault() returns trigger language plpgsql as $f$ begin
             if new.act = 'export' and new.user_id = '${U2.uid}' then raise exception 'e2e_fault'; end if; return new; end $f$;
           create trigger e2e_p0_fault before insert on public.logs for each row execute function public.e2e_p0_fault();`,
      off: 'drop trigger if exists e2e_p0_fault on public.logs; drop function if exists public.e2e_p0_fault();' },
  ];
  let refunds = 0;
  for (const f of faults) {
    const since = new Date(Date.now() - 1000).toISOString();
    psql(f.on);
    try {
      const r = await call(s2.headers, { action: 'export', step: 'start' });
      const code = await errOf(r);
      refunds += 1;
      const c = countersOf(U2.uid);
      ok(r.status === 503 && code === 'try_later', `138 ${f.tag} ${f.name}：start 回 ${r.status} ${code}`);
      ok((c.account ?? 0) === 0, `138 ${f.tag} 当天导出次数退回原值（account ${c.account ?? 0}）`);
      ok((c['export-refund'] ?? 0) === refunds, `138 ${f.tag} export-refund 当天 +1（${c['export-refund'] ?? 0}）`);
      ok(jobKeys(U2.uid) === 0, `138 ${f.tag} counters 里查不到这个账号的 export-job 键（不留任务行，取片只能 410）`);
      ok(exportLogs(U2.uid) === 0, `138 ${f.tag} logs 没有 export 行`);
      await sleep(1000);
      ok(logsOf(EDGE, since).includes(`account: ${f.code}`), `138 ${f.tag} 函数日志有 ${f.code}`);
    } finally {
      psql(f.off);
    }
  }
  // 恢复以后照常：建得了任务、写得了 logs
  const okStart = await call(s2.headers, { action: 'export', step: 'start' });
  ok(okStart.status === 200 && jobKeys(U2.uid) === 1 && exportLogs(U2.uid) === 1, `138 故障撤掉以后 start 照常 200、有任务行、有 export 行（${okStart.status}）`);
  ok(psql("select count(*) from pg_trigger where tgname = 'e2e_p0_fault';") === '0'
    && psql("select has_function_privilege('service_role', 'private.export_job_start(uuid, uuid, text, uuid)', 'EXECUTE');") === 't', '138 故障注入已全部恢复（触发器已删、执行权已还）');
} catch (e) {
  failedHard = true;
  console.error(`中途出错：${e instanceof Error ? e.message : String(e)}`);
}

const bad = checks.filter((c) => c.startsWith('✗')).length;
console.log(`\n共 ${checks.length} 项，✓ ${checks.length - bad}，✗ ${bad}${failedHard ? '，另有中途出错' : ''}`);
exit(bad === 0 && !failedHard ? 0 : 1);
