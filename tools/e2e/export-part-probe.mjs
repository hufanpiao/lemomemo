// 架构 0.47 续 ⑤ R1 的前置实测（10-31）：方案 A 的“单片”在本机 edge runtime 上能放多大。只在本机 lemo-e2e 用，不部署、不碰别的库。
//
// 做法：在 lemo-e2e 的副本目录 .e2e-sb/supabase/functions/ 里临时借 usage-report 的入口文件放探针（.e2e-sb 被 git 忽略，`up` 时整个重建；
// 不改仓库的 supabase/），它按方案 A 的口径取一片：按主键翻页（每页 250 行，EXPORT_PAGE 新值）、读完一页看本片原文到没到预算、到了就收尾，
// 这一片的 JSON 文字单独压成一个 gzip 成员，下一片的游标放响应头。脚本按每个片预算把满载账号整份走一遍，逐片记：
//   函数容器 CPU（cgroup v2 的 cpu.stat 前后差，扣掉一次 docker exec 的开销；整个 edge runtime 容器，偏保守）、墙钟、原文、gzip 字节；
// 最后把各片首尾相接，用 Node zlib 整份解开、JSON.parse，核对每张表的行数等于库里本人的行数（顺带验证“多成员 gzip 拼起来是一份完整 JSON”）。
// 探针没做真导出里的隐私记行过滤、exportOmitCols（CPU 占比很小），也不扣次数、不写 logs。跑完把 usage-report 的入口原样写回。
//
// 用法（仓库根目录，先 npm run e2e:real:up；跑完 npm run e2e:real:down）：
//   node tools/e2e/export-part-probe.mjs [--budgets 8,16,24,32] [--sync-rows 20000] [--log-rows 180000] [--uid <已造好的账号 id>]
//   不给 --uid 就先调 tools/e2e/export-full-account.mjs --profile typ 造一个满载账号（它最后那次整份导出在满载时会 546，不影响这里）。
// 只认 lemo-e2e：API 地址经 real-backend.mjs 的 statusEnv()（过它的护栏），必须是 127.0.0.1 / localhost 的 55320～55329；
// 造数、查行数只经 docker exec 进 supabase_db_lemo-e2e（容器名写死、跑前核对在跑）。本地演示密钥只在进程内用，不打印。
/* global fetch, console -- Node 24 的全局 */
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { argv, execPath, exit } from 'node:process';
import { URL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { ROOT } from './real-backend-guard.mjs';
import { statusEnv } from './real-backend.mjs';

const DB = 'supabase_db_lemo-e2e';
const EDGE = 'supabase_edge_runtime_lemo-e2e';
// edge runtime 的函数清单在 supabase start 时定死（SUPABASE_INTERNAL_FUNCTIONS_CONFIG），新函数名一律 404；
// 所以借 .e2e-sb 副本里 usage-report 的入口文件放探针，跑完原样写回（下次 up 也会整个重新复制）。
// 要求这一轮 lemo-e2e 起来以后还没调过 usage-report（worker 起来以后不重新加载）；探针回应里没有 x-next 就报错停下
const FN = 'usage-report';
const FN_FILE = join(ROOT, '.e2e-sb', 'supabase', 'functions', FN, 'index.ts');

function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i > 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
const budgets = arg('budgets', '8,16,24,32').split(',').map(Number);
if (budgets.some((b) => !Number.isInteger(b) || b < 1 || b > 64)) throw new Error('--budgets 要 1～64 的整数（MB），逗号分隔');
const syncRows = arg('sync-rows', '20000');
const logRows = arg('log-rows', '180000');
if (!/^\d+$/.test(syncRows) || !/^\d+$/.test(logRows)) throw new Error('--sync-rows、--log-rows 要非负整数');

function docker(args, input) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} 失败：${(r.stderr || '').slice(0, 1000)}`);
  return r.stdout;
}
const running = docker(['ps', '--format', '{{.Names}}']).split(/\r?\n/);
for (const c of [DB, EDGE]) if (!running.includes(c)) { console.error(`没在跑：${c}（先 npm run e2e:real:up）`); exit(2); }
const env = statusEnv();
const api = new URL(env.API_URL);
const port = Number(api.port);
if (!(port >= 55320 && port <= 55329) || !['127.0.0.1', 'localhost'].includes(api.hostname)) { console.error('API_URL 不是 lemo-e2e 的 553xx，停'); exit(2); }
const API = env.API_URL.replace(/\/$/, '');
const SR = env.SERVICE_ROLE_KEY;
const psql = (sql) => docker(['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-A', '-t', '-F', '='], sql).trim();

// ---------- 账号 ----------
let uid = arg('uid', '');
if (!uid) {
  const since = psql('select now()::text;');
  const r = spawnSync(execPath, ['tools/e2e/export-full-account.mjs', '--profile', 'typ', '--sync-rows', syncRows, '--log-rows', logRows], { cwd: ROOT, encoding: 'utf8' });
  const seeded = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('造数据'));
  console.log(seeded ?? '造数据：export-full-account.mjs 没打印造数结果');
  uid = psql(`select id from auth.users where email like 'export-load-%@lemomemo.test' and created_at >= '${since}'::timestamptz order by created_at desc limit 1;`);
}
if (!/^[0-9a-f-]{36}$/.test(uid)) throw new Error('拿不到满载账号的 id');
const TABLES = ['profiles', 'settings', 'devices', 'logs', 'events', 'todos', 'categories', 'notes', 'note_images', 'note_files', 'anniversaries'];
const dbCounts = Object.fromEntries(psql(TABLES.map((t) => `select '${t}', count(*) from public.${t} where user_id = '${uid}'`).join(' union all ') + ';')
  .split(/\r?\n/).map((l) => l.split('=')).map(([k, v]) => [k, Number(v)]));

// ---------- 探针函数（只写进 .e2e-sb 副本） ----------
const PROBE = String.raw`// 临时探针（tools/e2e/export-part-probe.mjs 写入、跑完删除；只在本机 lemo-e2e）。只认 service role。
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { allManifests } from '../_shared/gen/manifests/index.ts';
import { exportTablesOf } from '../account/export.ts';

const PAGE = 250;
const TABLES = exportTablesOf(allManifests);
const SR = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SR, { auth: { autoRefreshToken: false, persistSession: false } });

Deno.serve(async (req) => {
  if (!SR || req.headers.get('authorization') !== 'Bearer ' + SR) return new Response('no', { status: 401 });
  const { user_id: userId, budget, cursor } = await req.json();
  const t0 = performance.now();
  let { t, after, h, w } = cursor ?? { t: 0, after: null, h: false, w: false };
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const out = new Response(cs.readable).arrayBuffer();
  const enc = new TextEncoder();
  let raw = 0;
  const write = async (s) => { const b = enc.encode(s); raw += b.byteLength; await writer.write(b); };
  if (cursor === null) await write('{"format":"probe","tables":{');
  let next = 'done';
  while (t < TABLES.length) {
    const tb = TABLES[t];
    if (!h) { await write((t > 0 ? ',' : '') + JSON.stringify(tb.name) + ':['); h = true; }
    const base = admin.from(tb.name).select('*').eq('user_id', userId);
    const q = after === null ? base : base.gt(tb.keyCol, after);
    const { data, error } = await q.order(tb.keyCol, { ascending: true }).limit(PAGE);
    if (error || !Array.isArray(data)) return new Response('db', { status: 503 });
    if (data.length) { await write((w ? ',' : '') + data.map((r) => JSON.stringify(r)).join(',')); w = true; after = data[data.length - 1][tb.keyCol]; }
    if (data.length < PAGE) { await write(']'); t++; after = null; h = false; w = false; }
    if (t >= TABLES.length) { await write('}}'); break; }
    if (raw >= budget) { next = JSON.stringify({ t, after, h, w }); break; }
  }
  await writer.close();
  const gz = await out;
  return new Response(gz, { headers: { 'content-type': 'application/gzip', 'x-next': next, 'x-raw': String(raw), 'x-ms': String(Math.round(performance.now() - t0)) } });
});
`;
if (!existsSync(FN_FILE)) throw new Error(`找不到 ${FN_FILE}（先 npm run e2e:real:up）`);
const ORIGINAL = readFileSync(FN_FILE);
writeFileSync(FN_FILE, PROBE);

const cpuUsec = () => Number(/usage_usec (\d+)/.exec(docker(['exec', EDGE, 'cat', '/sys/fs/cgroup/cpu.stat']))?.[1] ?? NaN);
async function part(budgetBytes, cursor) {
  const c0 = cpuUsec();
  const s = performance.now();
  const res = await fetch(`${API}/functions/v1/${FN}`, {
    method: 'POST', headers: { apikey: SR, authorization: `Bearer ${SR}`, 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: uid, budget: budgetBytes, cursor }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const wall = performance.now() - s;
  const c1 = cpuUsec();
  return { status: res.status, buf, wall, cpuUs: c1 - c0, raw: Number(res.headers.get('x-raw')), next: res.headers.get('x-next') };
}

try {
  // docker exec 本身在容器里跑 cat，也算进 cgroup：量 5 次取中位数当开销扣掉
  const ov = [];
  for (let i = 0; i < 5; i++) { const a = cpuUsec(); ov.push(cpuUsec() - a); }
  const overheadUs = ov.sort((x, y) => x - y)[2];
  const warm = await part(1, null);   // 预热：冷启动、模块编译不算进测量
  if (warm.status !== 200 || warm.next === null) throw new Error(`探针没生效（状态 ${warm.status}）：usage-report 可能已被调过，npm run e2e:real:down 再 up 后重跑`);
  console.log(`账号 ${uid.slice(0, 8)}…；库里行数 ${JSON.stringify(dbCounts)}；docker exec 开销约 ${(overheadUs / 1000).toFixed(0)} ms/次（已扣）`);
  const summary = [];
  for (const mb of budgets) {
    const parts = [];
    let cursor = null;
    for (let i = 0; i < 200; i++) {
      const p = await part(mb * 1024 * 1024, cursor);
      if (p.status !== 200) { parts.push({ ...p, fail: true }); break; }
      parts.push(p);
      if (p.next === 'done') break;
      cursor = JSON.parse(p.next ?? 'null');
    }
    const failed = parts.filter((p) => p.fail);
    const cpu = parts.filter((p) => !p.fail).map((p) => Math.max(0, (p.cpuUs - overheadUs) / 1000));
    const wall = parts.filter((p) => !p.fail).map((p) => p.wall);
    const raws = parts.filter((p) => !p.fail).map((p) => p.raw);
    let check = '';
    if (!failed.length) {
      try {
        const doc = JSON.parse(gunzipSync(Buffer.concat(parts.map((p) => p.buf))).toString('utf8'));
        const bad = TABLES.filter((t) => (doc.tables[t]?.length ?? -1) !== dbCounts[t]);
        check = bad.length ? `行数不符：${bad.join('、')}` : '拼起来解开、行数全对';
      } catch (e) {
        // 字段写满的账号原文超过 Node 单个字符串上限（约 512 MB），整份核对不了；只记一句，测量照常输出
        check = `没核对（${e instanceof Error ? e.message.slice(0, 60) : '解开失败'}）`;
      }
    }
    const row = {
      预算MB: mb, 片数: parts.length, 失败: failed.map((p) => p.status).join(',') || 0,
      单片CPU最大ms: Math.round(Math.max(...cpu)), 单片CPU平均ms: Math.round(cpu.reduce((a, b) => a + b, 0) / cpu.length),
      单片墙钟最大ms: Math.round(Math.max(...wall)), 单片原文最大MB: +(Math.max(...raws) / 1048576).toFixed(1),
      单片gzip最大MB: +(Math.max(...parts.map((p) => p.buf.length)) / 1048576).toFixed(1),
      原文合计MB: +(raws.reduce((a, b) => a + b, 0) / 1048576).toFixed(1), gzip合计MB: +(parts.reduce((a, p) => a + p.buf.length, 0) / 1048576).toFixed(1),
      每MB原文CPUms: +(cpu.reduce((a, b) => a + b, 0) / (raws.reduce((a, b) => a + b, 0) / 1048576)).toFixed(1), 核对: check,
    };
    summary.push(row);
    console.log(JSON.stringify(row));
    console.log(`  各片 CPU ms：${cpu.map((c) => Math.round(c)).join(' ')}`);
  }
} finally {
  writeFileSync(FN_FILE, ORIGINAL);
}
