// TC-B1-73 / R1 / R5 本机参考测量（两步分片协议，架构 0.47 续 ⑤）：在 lemo-e2e 里造一个大账号，按 start → part… → done 跑一次 account export，
// 记每片原文和 gzip 大小、耗时、函数容器 CPU、单次调用内存峰值（account 的探针 EXPORT_MEM_PROBE，lemo-e2e 才开；容器 cgroup 只记增量作参考），再直接调 private.export_size_over 记预检耗时，最后在库里核对计数、任务行和 logs。
//
// 用法（仓库根目录，先 npm run e2e:real:up；量完 npm run e2e:real:down）：
//   node tools/e2e/export-full-account.mjs [--profile typ|max] [--notes-body N] [--excerpt N] [--log-rows N] [--sync-rows N] [--expect-too-large]
//     --profile typ  各文本列取常见长度（默认）；max  各文本列取到库里 check 的上限（没有 check 的 note 列按 2000 字）
//     --notes-body / --excerpt  单独指定 notes.body、note_files.text_excerpt 的字数（中文随机字），覆盖 profile 的值
//     --log-rows  logs 行数，默认 180000（每人每天 2000 条 × 保留 90 天）；--sync-rows  每张同步表行数，默认 20000（row_quota）
//     --save-gz <路径>  把各片首尾相接的多成员 .json.gz 存到这个路径（给 Python gzip、7-Zip 等工具核对，TC-B1-129）
//     --r4  R4：一个账号三次 start，核对中断后继续（次数只 +1、行数不变）、任务过期回 410、另一个会话回 410（TC-B1-123、124、132）
//     --min-segments N  探针按 worker 标识分段，至少要 N 段（R1 默认 4，其余默认 1；0.47 第 21 条补）
//     R3 空账号：--sync-rows 0 --log-rows 0（只有 profile），核对一片就结束
//     --expect-too-large  R5：造的数据原文超过 480 MB，核对 start 回 413 export_too_large、不扣导出次数、不建任务、不写 logs
//   每跑一次新建一个 export-load-<时间>@lemomemo.test 账号（导出每天 3 次，换账号不用清计数）。
//   跑的时候不要在 lemo-e2e 上并行跑别的导出（E2E、另一个本脚本等）：探针日志按时间段从 edge runtime 容器里取、按片序号对回各片，并行时会混进别人的行。
//   预览环境的跑法在 export-load-preview.mjs（护栏不同），本脚本只认本机。
//
// 只碰 lemo-e2e：API 地址取 real-backend.mjs 的 statusEnv()（过它的护栏），端口必须在 55320～55329；
// 造数据、核对只经 docker exec 进 supabase_db_lemo-e2e（容器名写死，跑前核对它在跑），不连任何别的库、不读写别的容器。
// 本地演示密钥只在进程内用，不打印；只打印条数、字节数、毫秒数和错误码。
/* global fetch, console -- Node 24 的全局（fetch 没有 node: 模块可 import） */
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { argv, exit, stdout } from 'node:process';
import { gunzipSync } from 'node:zlib';
import { statusEnv } from './real-backend.mjs';
import { EXPORT_TABLES, runExport, summary } from './export-load-lib.mjs';
import { lengths, seedSql } from './export-load-seed.mjs';

const DB = 'supabase_db_lemo-e2e';
const EDGE = 'supabase_edge_runtime_lemo-e2e';
const MAX_TOTAL_RAW = 480 * 1024 * 1024;   // 和 account/common.ts 的 EXPORT_LIMITS.maxTotalRawBytes 一致
const BUDGET_MS = 15000;                     // EXPORT_LIMITS.sizeCheckBudgetMs

function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i > 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
function intArg(name, def) {
  const v = arg(name, String(def));
  if (!/^\d+$/.test(v)) throw new Error(`--${name} 要非负整数`);
  return Number(v);
}

const profile = arg('profile', 'typ');
if (profile !== 'typ' && profile !== 'max') throw new Error('--profile 只能是 typ 或 max');
const MAX = profile === 'max';
const TOO_LARGE = argv.includes('--expect-too-large');
const nb = argv.includes('--notes-body') ? intArg('notes-body', 0) : undefined;
const ex = argv.includes('--excerpt') ? intArg('excerpt', 0) : undefined;
const L = lengths(MAX, nb, ex);
const SYNC = intArg('sync-rows', 20000);
const LOGS = intArg('log-rows', 180000);

// ---------- 只认 lemo-e2e ----------
function docker(args, input) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} 失败：${(r.stderr || '').slice(0, 2000)}`);
  return r.stdout;
}
const running = docker(['ps', '--format', '{{.Names}}']).split(/\r?\n/);
for (const c of [DB, EDGE]) if (!running.includes(c)) { console.error(`没在跑：${c}（先 npm run e2e:real:up）`); exit(2); }
const env = statusEnv();
const api = new URL(env.API_URL);
const port = Number(api.port);
if (!(port >= 55320 && port <= 55329) || !['127.0.0.1', 'localhost'].includes(api.hostname)) {
  console.error('API_URL 不是 lemo-e2e 的 553xx，停'); exit(2);
}
const API = env.API_URL.replace(/\/$/, '');
const SR = env.SERVICE_ROLE_KEY;
const ANON = env.ANON_KEY;
/** 在 lemo-e2e 的库里跑 SQL，回“列=列”一行一条 */
const psql = (sql) => docker(['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-A', '-t', '-F', '=', '-v', 'ON_ERROR_STOP=1'], sql).trim();

async function j(path, init, key = SR) {
  const r = await fetch(API + path, { ...init, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return t ? JSON.parse(t) : null;
}

// ---------- 建账号 ----------
const email = `export-load-${Date.now()}@lemomemo.test`;
const user = await j('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, email_confirm: true }) });
const uid = user.id;
if (!/^[0-9a-f-]{36}$/.test(uid)) throw new Error('user id 不对');

// ---------- 造数据 ----------
const t0 = Date.now();
const seedOut = docker(['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-A', '-t', '-F', '='], seedSql(uid, L, MAX, SYNC, LOGS));
console.log(`造数据 ${((Date.now() - t0) / 1000).toFixed(1)} 秒，profile=${profile}，notes.body=${L.noteBody} 字，excerpt=${L.excerpt} 字`);
console.log(seedOut.trim().split(/\r?\n/).join('  '));
const seeded = Object.fromEntries(seedOut.trim().split(/\r?\n/).map((l) => l.split('=')).map(([k, v]) => [k, Number(v)]));
seeded.profiles = 1;

// ---------- 预检耗时（直接调库函数，和 account 用同一组参数；另跑一次不设上限的完整合计） ----------
function sizeCheck(limit) {
  const out = psql(`\\timing on\nselect private.export_size_over('${uid}', 'omitted', ${limit}, ${BUDGET_MS});`);
  return { result: Number(out.split(/\r?\n/)[0]), ms: Math.round(Number(/Time: ([\d.]+) ms/.exec(out)?.[1] ?? NaN)) };
}
const pre = { atLimit: sizeCheck(MAX_TOTAL_RAW), full: sizeCheck('9223372036854775807') };
pre.fullMB = pre.full.result >= 0 ? +(pre.full.result / 1048576).toFixed(1) : null;
console.log(`预检：480 MB 上限 → ${pre.atLimit.result >= 0 ? (pre.atLimit.result / 1048576).toFixed(1) + ' MB' : pre.atLimit.result}，${pre.atLimit.ms} ms；` +
  `完整合计 → ${pre.fullMB ?? pre.full.result} MB，${pre.full.ms} ms`);
// 直接调用不经 account，不占 export-size 次数；advisory 锁是事务级的，随这句结束释放

// ---------- OTP 会话（account 拒密码会话） ----------
const link = await j('/auth/v1/admin/generate_link', { method: 'POST', body: JSON.stringify({ type: 'magiclink', email }) });
const hashed = link.hashed_token ?? link.properties?.hashed_token;
const sess = await j('/auth/v1/verify', { method: 'POST', body: JSON.stringify({ type: 'magiclink', token_hash: hashed }) }, ANON);
const jwt = sess.access_token;
const headers = { apikey: ANON, authorization: `Bearer ${jwt}` };

// ---------- R4：中断后继续、任务过期、另一个会话（TC-B1-73 R4；TC-B1-123、124、132） ----------
// 三次 start（正好用完当天 3 次）：A 取到第 2 片后客户端断开，隔几秒用同一个 export_id 和游标接着取完；
// B 取 1 片后把任务行的 window_start 改到 3600 秒前，再取一片应回 410；C 由会话 S1 取第 1 片，另一个会话 S2 拿同一个 export_id 和游标取应回 410，S1 之后照常取完。
if (argv.includes('--r4')) {
  const fn = `${API}/functions/v1/account`;
  const call = (h, body) => fetch(fn, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const errOf = async (res) => { const t = await res.text(); try { const e = JSON.parse(t).error; return { code: typeof e === 'string' && /^[a-z_]{1,40}$/.test(e) ? e : '?', body: t.length <= 200 && /^\{"error":"[a-z_]+"\}$/.test(t) ? t : '?' }; } catch { return { code: '?', body: '?' }; } };
  const start = async (h) => { const res = await call(h, { action: 'export', step: 'start' }); if (res.status !== 200) throw new Error(`start HTTP ${res.status} ${(await errOf(res)).code}`); return res.json(); };
  let partCalls = 0;
  /** 从 cursor 起取片，最多 limit 片或到 done；非 200 时停下并带回状态和错误码 */
  const loop = async (h, id, cursor, limit = 60) => {
    const bufs = [];
    for (let i = 0; i < limit; i++) {
      partCalls++;
      const res = await call(h, { action: 'export', step: 'part', export_id: id, cursor });
      if (res.status !== 200) return { bufs, cursor, fail: { status: res.status, ...(await errOf(res)), hdrs: [...res.headers.keys()].filter((k) => k !== 'date').sort().join(',') } };
      bufs.push(Buffer.from(await res.arrayBuffer()));
      const next = res.headers.get('x-lemo-export-next') ?? '';
      if (next === 'done') return { bufs, cursor: 'done' };
      cursor = next;
    }
    return { bufs, cursor };
  };
  const countersNow = () => Object.fromEntries(psql(`select split_part(key, ':', 1), sum(count) from private.counters where key like '%:${uid}:%' group by 1;`)
    .split(/\r?\n/).filter(Boolean).map((l) => l.split('=')).map(([k, v]) => [k, Number(v)]));
  const rowsOf = (bufs) => {
    const doc = JSON.parse(gunzipSync(Buffer.concat(bufs)).toString('utf8'));
    return { head: doc.format && doc.version === 1 && doc.vault === 'omitted' && doc.user_id === uid, rows: Object.fromEntries(Object.entries(doc.tables).map(([k, v]) => [k, v.length])) };
  };
  const checks = [];
  const ok = (cond, what) => checks.push(`${cond ? '✓' : '✗'} ${what}`);
  const sameRows = (rows) => EXPORT_TABLES.every((t) => (t === 'logs' ? rows.logs - seeded.logs >= 1 && rows.logs - seeded.logs <= 2 : rows[t] === seeded[t]));
  // A：中断后继续
  const a = await start(headers);
  const a1 = await loop(headers, a.export_id, null, 2);
  ok(!a1.fail && a1.bufs.length === 2 && a1.cursor !== 'done', `A 取到第 2 片后断开（${a1.bufs.length} 片，${a1.fail ? a1.fail.code : '游标未完'}）`);
  await new Promise((r) => setTimeout(r, 3000));
  const a2 = await loop(headers, a.export_id, a1.cursor);
  const aParts = a1.bufs.length + a2.bufs.length;
  ok(!a2.fail && a2.cursor === 'done', `A 用同一个 export_id 和游标继续取完（又取 ${a2.bufs.length} 片，共 ${aParts} 片）`);
  const aDoc = !a2.fail ? rowsOf([...a1.bufs, ...a2.bufs]) : null;
  ok(aDoc?.head === true, '继续取完的文件头部 format、version 1、vault omitted、user_id 都对');
  ok(aDoc && sameRows(aDoc.rows), `继续取完的文件每张表行数等于库里本人的行数（不中断时同样如此；logs 多 ${aDoc ? aDoc.rows.logs - seeded.logs : '?'} 条 account 日志）`);
  const cA = countersNow();
  ok(cA.account === 1, `中断再继续，当天导出次数只 +1（account ${cA.account}）`);
  ok(cA['export-job'] === aParts, `A 的任务行分片数 = 实际片数（${cA['export-job']} / ${aParts}）`);
  // B：过期
  const b = await start(headers);
  const b1 = await loop(headers, b.export_id, null, 1);
  ok(!b1.fail && b1.bufs.length === 1, 'B 第 1 片正常');
  psql(`update private.counters set window_start = window_start - interval '3600 seconds' where key like 'export-job:${uid}:${b.export_id}.%';`);
  const b2 = await loop(headers, b.export_id, b1.cursor, 1);
  ok(b2.fail?.status === 410 && b2.fail.code === 'export_expired', `window_start 改到 3600 秒前再取：410 export_expired（实际 ${b2.fail?.status ?? 200} ${b2.fail?.code ?? ''}）`);
  // C：另一个会话
  const c = await start(headers);
  const c1 = await loop(headers, c.export_id, null, 1);
  ok(!c1.fail && c1.bufs.length === 1, 'C 由会话 S1 取第 1 片正常');
  const link2 = await j('/auth/v1/admin/generate_link', { method: 'POST', body: JSON.stringify({ type: 'magiclink', email }) });
  const sess2 = await j('/auth/v1/verify', { method: 'POST', body: JSON.stringify({ type: 'magiclink', token_hash: link2.hashed_token ?? link2.properties?.hashed_token }) }, ANON);
  const h2 = { apikey: ANON, authorization: `Bearer ${sess2.access_token}` };
  const jobBefore = Number(psql(`select count from private.counters where key like 'export-job:${uid}:${c.export_id}.%';`));
  const c2 = await loop(h2, c.export_id, c1.cursor, 1);
  ok(c2.fail?.status === 410 && c2.fail.code === 'export_expired', `同一账号另一个会话 S2 拿这个 export_id 取片：410 export_expired（实际 ${c2.fail?.status ?? 200} ${c2.fail?.code ?? ''}）`);
  ok(c2.fail && b2.fail && c2.fail.body === b2.fail.body && c2.fail.hdrs === b2.fail.hdrs, `“别的会话”和“过期”两种 410 的响应体、响应头（除 Date）一样（${c2.fail?.body} / ${b2.fail?.body}）`);
  const jobAfter = Number(psql(`select count from private.counters where key like 'export-job:${uid}:${c.export_id}.%';`));
  ok(jobAfter === jobBefore, `S2 被拒不动 C 的任务行分片数（${jobBefore} → ${jobAfter}）`);
  const c3 = await loop(headers, c.export_id, c1.cursor);
  ok(!c3.fail && c3.cursor === 'done', `S1 之后照常接着取完（又取 ${c3.bufs.length} 片）`);
  const cDoc = !c3.fail ? rowsOf([...c1.bufs, ...c3.bufs]) : null;
  // C 是当天第三次导出，logs 里已有 A、B 的 account 日志（export、export_done、export_mail_failed）：logs 只核对落在“造的行数 +1”到“库里现有行数”之间
  const logsNow = Number(psql(`select count(*) from public.logs where user_id = '${uid}';`));
  ok(cDoc?.head === true && EXPORT_TABLES.every((t) => (t === 'logs' ? cDoc.rows.logs > seeded.logs && cDoc.rows.logs <= logsNow : cDoc.rows[t] === seeded[t])),
    `C 的文件头部对、各同步表行数等于库里本人的行数（logs ${cDoc?.rows.logs}，造 ${seeded.logs}、库里现有 ${logsNow}）`);
  const cEnd = countersNow();
  ok(cEnd.account === 3, `三次 start 后当天导出次数 3（${cEnd.account}）`);
  ok(cEnd['export-part'] === partCalls, `export-part 当天计数 = 实际 part 调用数（含两次 410；${cEnd['export-part']} / ${partCalls}）`);
  const logsR4 = psql(`select act, count(*) from public.logs where user_id = '${uid}' and src = 'account' group by act order by act;`).replace(/\r?\n/g, '  ');
  ok(/export=3/.test(logsR4) && /export_done=2/.test(logsR4), `logs：3 条 export、2 条 export_done（A、C 取完，B 过期没完）（${logsR4}）`);
  stdout.write(JSON.stringify({ mode: 'r4', profile, sync: SYNC, logs: LOGS, aParts, partCalls, checks }, null, 1) + '\n');
  exit(checks.every((x) => x.startsWith('✓')) ? 0 : 1);
}

// ---------- 函数容器的 CPU、内存（cgroup v2，整个 edge runtime 容器，偏大） ----------
const cg = (f) => docker(['exec', EDGE, 'cat', `/sys/fs/cgroup/${f}`]);
const cpuUsec = () => Number(/usage_usec (\d+)/.exec(cg('cpu.stat'))?.[1] ?? NaN);
const memNow = () => Number(cg('memory.current').trim());
// 先空调一次 status，让 account 的 worker 起来（冷启动不算进导出）
await fetch(`${API}/functions/v1/account`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{"action":"status"}' }).then((r) => r.text());
const mem0 = memNow();
let memMax = mem0;
let cpu0 = 0;
let polling = true;
const poll = (async () => { while (polling) { try { memMax = Math.max(memMax, memNow()); } catch { /* 采样失败跳过 */ } await new Promise((r) => setTimeout(r, 250)); } })();
let memBefore = 0;
const hooks = {
  beforePart: () => { memBefore = memNow(); memMax = memBefore; cpu0 = cpuUsec(); },
  afterPart: () => ({ cpuMs: Math.round((cpuUsec() - cpu0) / 1000), cgDeltaMB: +((memMax - memBefore) / 1048576).toFixed(1) }),
};
const edgeLogSince = new Date(Date.now() - 2000).toISOString();
const r = await runExport(`${API}/functions/v1/account`, headers, hooks);
polling = false;
await poll;
// 探针日志（架构 0.47 第 21 条）：account: export_mem_peak mb=<n> part=<片序号>、export_mem_start mb=<n> part=<片序号>
{
  const lg = spawnSync('docker', ['logs', '--since', edgeLogSince, EDGE], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const text = `${lg.stdout}\n${lg.stderr}`;
  // 0.47 第 21 条补：两行都带 w=<worker 标识>（模块加载时随机生成），按 w 把各片分段
  for (const m of text.matchAll(/export_mem_(peak|start) mb=(\d+) part=(\d+) w=([0-9a-f]{8,16})\b/g)) {
    const p = r.parts[Number(m[3]) - 1];
    if (p) { p[m[1] === 'peak' ? 'probePeakMB' : 'probeStartMB'] = Number(m[2]); p.worker = m[4]; }
  }
}
const saveGz = arg('save-gz', '');
if (saveGz && r.gzFile) writeFileSync(saveGz, r.gzFile);

// ---------- 库里核对 ----------
const counters = Object.fromEntries(psql(`select split_part(key, ':', 1), count from private.counters where key like '%:${uid}:%';`)
  .split(/\r?\n/).filter(Boolean).map((l) => l.split('=')).map(([k, v]) => [k, Number(v)]));
const logs = psql(`select act, count(*) from public.logs where user_id = '${uid}' and src = 'account' group by act order by act;`)
  .split(/\r?\n/).filter(Boolean).map((l) => l.split('=')).reduce((o, [k, v]) => ({ ...o, [k]: Number(v) }), {});
const checks = [];
const ok = (cond, what) => checks.push(`${cond ? '✓' : '✗'} ${what}`);
const s = summary(r);
if (TOO_LARGE) {
  ok(r.start.status === 413 && r.start.code === 'export_too_large', `start 回 413 export_too_large（实际 ${r.start.status} ${r.start.code ?? ''}）`);
  ok(!counters.account, `account 计数没扣（${counters.account ?? 0}）`);
  ok(counters['export-size'] === 1, `export-size 记 1 次（${counters['export-size'] ?? 0}）`);
  ok(!counters['export-job'] && !counters['export-part'], '没有任务行、没有 part 计数');
  ok(!logs.export && !logs.export_done, `logs 没写（export ${logs.export ?? 0}、export_done ${logs.export_done ?? 0}）`);
  const edgeLog = spawnSync('docker', ['logs', '--since', edgeLogSince, EDGE], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = `${edgeLog.stdout}\n${edgeLog.stderr}`.split(/\r?\n/).filter((l) => l.includes('export_size_rejected'));
  ok(lines.length === 1 && /u=[0-9a-f]{16} ms=\d+/.test(lines[0]), `函数日志有 1 条 export_size_rejected u=<哈希> ms=<耗时>（${lines.length} 条）`);
  const m = /ms=(\d+)/.exec(lines[0] ?? '');
  s.rejectedLogMs = m ? Number(m[1]) : null;
} else {
  const parts = r.parts.length;
  ok(!r.error && r.start.status === 200, `导出跑完（${r.error ?? 'ok'}）`);
  ok(s.startKeys === 'export_id,exported_at,ok', `start 只回 {ok, export_id, exported_at}（${s.startKeys}）`);
  ok(counters.account === 1 && counters['export-size'] === 1 && counters['export-part'] === parts, `四个计数：account ${counters.account}、export-size ${counters['export-size']}、export-part ${counters['export-part']}（片数 ${parts}）`);
  ok(counters['export-job'] === parts, `任务行 count = 片数（${counters['export-job']}）`);
  ok(logs.export === 1 && logs.export_done === 1, `logs：export ${logs.export ?? 0}、export_done ${logs.export_done ?? 0}`);
  ok(r.head?.exportedAtMatches === true, '文件里的 exported_at 和 start 回的一致');
  ok(s.contentEncoding.length === 1 && s.contentEncoding[0] === null, '响应不带 Content-Encoding');
    // logs 多出本次的 export 一条；响应后发通知若失败会记 export_mail_failed，和取 logs 那片谁先谁后不定，所以允许多 1～2 条
    ok(EXPORT_TABLES.every((t) => (t === 'logs' ? r.rows?.logs - seeded.logs >= 1 && r.rows?.logs - seeded.logs <= 2 : (r.rows?.[t] ?? -1) === seeded[t])),
      `每张表行数和造的一致（logs 多 ${r.rows?.logs - seeded.logs} 条 account 日志）`);
  ok(r.userIdMatches?.(uid) === true, '每行 user_id 都是本人');
  // 每写完一行才比预算（account/export-part.ts），单片最多超出一行；最胖的行是 2 万字的笔记（约 6 万字节），留 256 KB 余量
  const okParts = r.parts.filter((p) => p.status === 200);
  ok(okParts.length > 0 && okParts.every((p) => p.probePeakMB !== undefined), `每片都有探针峰值（${okParts.filter((p) => p.probePeakMB !== undefined).length}/${okParts.length}；没有就是 EXPORT_MEM_PROBE 没生效）`);
  ok(s.partMaxProbeMB !== null && s.partMaxProbeMB <= 150, `单次调用内存峰值 ≤ 150 MB（探针 heapUsed + external，最高 ${s.partMaxProbeMB}）`);
  // 连续取片不累积，按 worker 分段验收（架构 0.47 第 21 条补）：相邻、w 相同的片为一段
  ok(okParts.every((p) => p.worker && p.probeStartMB !== undefined), `每片都有 worker 标识和开始时 heapUsed（${okParts.filter((p) => p.worker).length}/${okParts.length}）`);
  const segs = [];
  for (const p of okParts) {
    if (segs.length && segs.at(-1).w === p.worker) segs.at(-1).st.push(p.probeStartMB);
    else segs.push({ w: p.worker, st: [p.probeStartMB] });
  }
  s.segments = segs.map((g) => `${g.w}:${g.st.join('/')}`);
  ok(segs.every((g) => g.st.every((v) => Math.abs(v - g.st[0]) <= 10)), `段内每片开始时 heapUsed 不逐片上涨（±10 MB；${segs.length} 段：${s.segments.join(' | ')}）`);
  const base = segs[0]?.st[0];
  ok(segs.every((g) => Math.abs(g.st[0] - base) <= 10), `每个新 worker 第一片开始时回到底数 ±10 MB（底数 ${base}，各段首片 ${segs.map((g) => g.st[0]).join('、')}）`);
  const minSegs = intArg('min-segments', SYNC === 20000 && LOGS === 180000 && !MAX ? 4 : 1);
  ok(segs.length >= minSegs, `至少覆盖 ${minSegs} 段（实际 ${segs.length} 段，${new Set(segs.map((g) => g.w)).size} 个不同的 worker）`);
  if (SYNC === 0 && LOGS === 0) ok(parts === 1, `R3 空账号一片就结束（x-lemo-export-next 为 done；实际 ${parts} 片）`);
  ok(s.partMaxCpuMs !== null && s.partMaxCpuMs <= 1200, `单片容器 CPU ≤ 1.2 秒（最高 ${s.partMaxCpuMs}）`);
  ok(s.partMaxRawMB <= 16.25, `单片原文 ≤ 16 MB + 一行（${s.partMaxRawMB}）`);
}
const out = { profile, expectTooLarge: TOO_LARGE, sync: SYNC, logs: LOGS, precheck: pre, edgeMemBaseMB: +(mem0 / 1048576).toFixed(1), ...s, checks };
stdout.write(JSON.stringify(out, null, 1) + '\n');
exit(checks.every((c) => c.startsWith('✓')) ? 0 : 1);
