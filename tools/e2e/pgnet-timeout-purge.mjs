// B1-left-pgnet-timeout（接手清单第 213 行；TC-B0-117 遗留观察）：证明“pg_net 超时以后 account-purge 照样跑完”。
// 只在本机的 lemo-b2push 上跑（读 config.toml 的 project_id，不是 lemo-b2push 就拒绝；API 必须是 127.0.0.1），不碰 lemomemo、lemo-purgeit，不连预览、正式。
// 放慢只靠造数据（不改函数代码、没有延时开关）：每个待删账号在 backups 桶里造 --dates 个日期目录，purgeOne 对每个日期列两次、删一次。
// R2：本脚本在 127.0.0.1:<端口> 起 S3 替身（tests/shared/fake-s3.ts），再在 edge-runtime 容器的网络里起一个转发容器
//   （同一个 edge-runtime 镜像，--network container:<edge 容器>），函数照 R2_ENDPOINT=http://127.0.0.1:<端口> 连到转发、再转到本机替身。
// 触发：把 cron.job 里 account-purge 那条 command 原样跑一次（TC-B1-154 的口径），按 ①～⑤ 判定（判据见 docs/03-评审/B1/B1-pgnet超时-执行记录.md）。
// 不写死任何密钥、邮箱：service role key 运行时从 `supabase status -o env` 读；R2 假凭据从 --env-file（函数用的同一份本机假值）读，
//   值里不带 fake / FAKE / LOCAL 字样就拒绝；测试邮箱一律随机的 @lemomemo.test（account-purge 的 skipTestRecipients 不真发）。
// 上一轮留下、已到期且认领已过期的待删账号也会被这一轮处理：算进 ② 的 purged，③ 一起核对（补跑）。
// 用法：node tools/e2e/pgnet-timeout-purge.mjs --workdir <lemo-b2push 副本目录> --env-file <函数 env 文件> --container-host <容器里访问本机的主机名> [--users 3] [--dates 400] [--expect timeout|ok]
//   --expect timeout（默认）：判 ① 超时 + ②～⑤；--expect ok（反证，用少量数据）：判 ① 200、没超时 + ②～⑤。输出一份 JSON 汇总，全部通过退出码 0。
/* global process, console, URL, fetch, setTimeout, Headers, Request, Buffer -- Node 24 的全局 */
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFakeS3 } from '../../tests/shared/fake-s3.ts';

const PROJECT = 'lemo-b2push';
const DB = `supabase_db_${PROJECT}`;
const EDGE = `supabase_edge_runtime_${PROJECT}`;
const PROXY = `${PROJECT}-s3proxy`;
const R2_BUCKETS = ['images', 'files', 'vault-images', 'vault-files'];
const BAD_LOG = ['step_error', 'verify_failed', 'r2_not_empty', 'backups_not_empty', 'heartbeat_failed'];
const ROOT = resolve(import.meta.dirname, '../..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const fail = (msg) => {
  console.error(`拒绝运行：${msg}`);
  process.exit(2);
};
const workdir = arg('workdir');
const envFile = arg('env-file');
const nUsers = Number(arg('users', '3'));
const nDates = Number(arg('dates', '400'));
const expect = arg('expect', 'timeout');
// 容器里访问本机用的主机名（Docker Desktop 给容器的那个本机名字），由调用方传，脚本里不写死（check_backend F10）
const hostFromContainer = arg('container-host');
if (!workdir || !envFile || !hostFromContainer) fail('要 --workdir、--env-file 和 --container-host');
if (!/^[a-z0-9.-]+$/.test(hostFromContainer)) fail('--container-host 只能是主机名');
if (!/^project_id = "lemo-b2push"$/m.test(readFileSync(join(workdir, 'supabase', 'config.toml'), 'utf8'))) fail('config.toml 的 project_id 不是 lemo-b2push');
const fnEnv = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const s3Url = new URL(fnEnv.R2_ENDPOINT ?? '');
if (s3Url.hostname !== '127.0.0.1') fail('R2_ENDPOINT 不是 http://127.0.0.1:<端口>');
for (const k of ['R2_FN_ACCESS_KEY_ID', 'R2_FN_SECRET_ACCESS_KEY']) if (!/fake|FAKE|LOCAL/.test(fnEnv[k] ?? '')) fail(`${k} 看起来不是本机假值`);

// ---------- 本机 lemo-b2push ----------
const sbStatus = execSync(`npx supabase status -o env --workdir "${workdir}"`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = Object.fromEntries([...sbStatus.matchAll(/^([A-Z_]+)="?([^"\r\n]*)"?$/gm)].map((m) => [m[1], m[2]]));
const API = st.API_URL ?? '';
const SERVICE = st.SERVICE_ROLE_KEY ?? '';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(API) || !SERVICE) fail('supabase status 里没有本机 API_URL / SERVICE_ROLE_KEY');

const psql = (sql) => execFileSync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' }).trim();
const api = (path, init = {}) => fetch(`${API}${path}`, { ...init, headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, ...(init.headers ?? {}) } });
const lit = (ids) => `array[${ids.map((x) => `'${x}'`).join(',')}]::uuid[]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pool(items, n, f) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await f(items[i++]);
  }));
}

async function createUser() {
  const r = await api('/auth/v1/admin/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `pgnet-${randomUUID().slice(0, 8)}@lemomemo.test`, email_confirm: true }) });
  const j = await r.json();
  if (!r.ok || typeof j.id !== 'string') throw new Error(`建用户失败 ${r.status}`);
  return j.id;
}
/** backups 桶：每个日期目录 1 个小文件（<日期>/<user_id>/seed.gz） */
async function seedBackups(uid, dates) {
  await pool(dates, 16, async (d) => {
    const r = await api(`/storage/v1/object/backups/${d}/${uid}/seed.gz`, { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: new Uint8Array([0x1f, 0x8b, 0, 0]) });
    if (!r.ok) throw new Error(`传备份失败 ${r.status}`);
  });
}
const backupCount = (uid) => Number(psql(`select count(*) from storage.objects where bucket_id = 'backups' and name like '%/${uid}/%';`));

// ---------- S3 替身 + 容器网络里的转发 ----------
const s3 = createFakeS3({ accessKeyId: fnEnv.R2_FN_ACCESS_KEY_ID, secretAccessKey: fnEnv.R2_FN_SECRET_ACCESS_KEY, region: 'auto', buckets: R2_BUCKETS });
const origin = `http://127.0.0.1:${s3Url.port}`;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (k !== 'host' && v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const m = req.method ?? 'GET';
  // 验签用 url.host：照函数签名时的 127.0.0.1:<端口> 拼回去（转发容器改过 Host）
  const r = await s3.handle(new Request(`${origin}${req.url ?? '/'}`, { method: m, headers, ...(m === 'GET' || m === 'HEAD' ? {} : { body: Buffer.concat(chunks) }) }));
  const h = {};
  r.headers.forEach((v, k) => { h[k] = v; });
  res.writeHead(r.status, h);
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((ok) => server.listen(Number(s3Url.port), '127.0.0.1', ok));
const proxyDir = mkdtempSync(join(tmpdir(), 'pgnet-s3proxy-'));
writeFileSync(join(proxyDir, 'index.ts'), `Deno.serve({ port: ${s3Url.port} }, async (req) => {
  const u = new URL(req.url);
  const h = new Headers(req.headers); h.delete('host');
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
  const r = await fetch('http://${hostFromContainer}:${s3Url.port}' + u.pathname + u.search, { method: req.method, headers: h, body, redirect: 'manual' });
  return new Response(r.body, { status: r.status, headers: r.headers });
});\n`);
const edgeImage = execFileSync('docker', ['inspect', EDGE, '--format', '{{.Config.Image}}'], { encoding: 'utf8' }).trim();
execFileSync('docker', ['rm', '-f', PROXY], { stdio: 'ignore' });
execFileSync('docker', ['run', '-d', '--rm', '--name', PROXY, '--network', `container:${EDGE}`, '-v', `${proxyDir}:/proxy:ro`, '--entrypoint', 'edge-runtime', edgeImage, 'start', '--main-service=/proxy', `--port=${s3Url.port}`], { stdio: 'ignore' });
const r2Count = (uid) => Object.fromEntries(R2_BUCKETS.map((b) => [b, [...s3.objects.keys()].filter((k) => k.startsWith(`${b}/${uid}/`)).length]));

const out = { project: PROJECT, expect, users: nUsers, dates: nDates, checks: {} };
try {
  // ---------- 造数据：nUsers 个待删账号 + 1 个对照账号 B ----------
  const dates = Array.from({ length: nDates }, (_, i) => new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10));
  const targets = [];
  for (let i = 0; i < nUsers; i++) targets.push(await createUser());
  const b = await createUser();
  const t1 = Date.now();
  for (const u of [...targets, b]) {
    await seedBackups(u, dates);
    for (const bk of R2_BUCKETS) for (let k = 0; k < 2; k++) s3.objects.set(`${bk}/${u}/seed/${k}.bin`, { body: new Uint8Array([k]), contentType: 'application/octet-stream', etag: `"seed${k}"` });
  }
  out.seedMs = Date.now() - t1;
  // profiles 行（App 首次登录时建；这里直接插）：待删账号是“注销冷静期”状态，对照账号 B 正常
  psql(`insert into public.profiles (user_id) select u from unnest(${lit([...targets, b])}) u on conflict (user_id) do nothing;
update public.profiles set disabled_at = now(), disabled_reason = 'deletion' where user_id = any(${lit(targets)});
insert into private.pending_deletions (user_id, purge_after) select u, now() - interval '1 minute' from unnest(${lit(targets)}) u;`);
  const bBefore = { backups: backupCount(b), r2: r2Count(b) };
  // 之前留下、这一轮也会被处理的待删账号（到期、没认领或认领已过期）：比如上一轮被 CPU 上限掐断、认领过了 1 小时的那个。
  // 一起算进 ② 的 purged、③ 逐个核对（补跑能不能把半截的删完）
  const carried = psql(`select user_id from private.pending_deletions where purge_after <= now() and (purge_started_at is null or purge_started_at < now() - interval '1 hour')
  and not (user_id = any(${lit(targets)}));`).split(/\r?\n/).filter(Boolean);
  out.carried = carried.map((u) => u.slice(0, 8));

  // ---------- 触发：cron.job 里那条 command 原样跑一次 ----------
  const command = psql(`select command from cron.job where jobname = 'account-purge';`);
  if (!/net\.http_post/.test(command) || !/timeout_milliseconds := 5000/.test(command)) throw new Error('cron.job 里 account-purge 的 command 不是预期的那条');
  const t0 = Number(psql('select (extract(epoch from clock_timestamp()) * 1000)::bigint;'));
  const reqId = psql(`${command};`).split('\n').pop();
  out.trigger = { t0: new Date(t0).toISOString(), request_id: reqId };

  // ① pg_net 的结果
  let resp = '';
  for (let i = 0; i < 60 && !resp; i++) {
    resp = psql(`select coalesce(status_code::text, ''), coalesce(timed_out::text, ''), coalesce(error_msg, ''), (extract(epoch from created) * 1000)::bigint from net._http_response where id = ${Number(reqId)};`);
    if (!resp) await sleep(1000);
  }
  const [code, timedOut, errMsg] = resp.split('|');
  const isTimeout = code === '' && (timedOut === 'true' || /time(d)? ?out/i.test(errMsg ?? ''));
  out.checks['①'] = { status_code: code || null, timed_out: timedOut || null, error_msg: errMsg || null, pass: expect === 'timeout' ? isTimeout : code === '200' && timedOut !== 'true' };

  // ② 心跳：at 晚于触发时刻（超时那次还要晚于 t0 + 5 秒），detail 是本次结果
  let hb = '';
  for (let i = 0; i < 150 && !hb; i++) {
    hb = psql(`select (extract(epoch from at) * 1000)::bigint, detail::text from private.heartbeat where name = 'account-purge' and at > to_timestamp(${t0} / 1000.0);`);
    if (!hb) await sleep(1000);
  }
  const [hbAt, hbDetail] = hb ? [Number(hb.slice(0, hb.indexOf('|'))), JSON.parse(hb.slice(hb.indexOf('|') + 1))] : [null, null];
  out.checks['②'] = {
    at: hbAt ? new Date(hbAt).toISOString() : null, detail: hbDetail,
    pass: hbDetail !== null && hbDetail.purged === nUsers + carried.length && hbDetail.failed === 0 && (expect === 'timeout' ? hbAt > t0 + 5000 && hbDetail.ms > 5000 : true),
  };

  // ③ 每个待删账号都删干净（没有删到一半）
  const per = [...targets, ...carried].map((u) => {
    const [au, pr, pd, da] = psql(`select (select count(*) from auth.users where id = '${u}'), (select count(*) from public.profiles where user_id = '${u}'),
  (select count(*) from private.pending_deletions where user_id = '${u}'), (select count(*) from private.deleted_accounts where user_id = '${u}');`).split('|').map(Number);
    const r2 = r2Count(u);
    const row = { user: u.slice(0, 8), auth_users: au, profiles: pr, pending: pd, deleted_accounts: da, backups: backupCount(u), r2 };
    return { ...row, pass: au === 0 && pr === 0 && pd === 0 && da === 1 && row.backups === 0 && Object.values(r2).every((n) => n === 0) };
  });
  out.checks['③'] = { users: per, pass: per.every((x) => x.pass) };

  // ④ 对照账号 B 不受影响
  const bAfter = { backups: backupCount(b), r2: r2Count(b), profiles: Number(psql(`select count(*) from public.profiles where user_id = '${b}';`)) };
  out.checks['④'] = { before: bBefore, after: bAfter, pass: bAfter.profiles === 1 && bAfter.backups === bBefore.backups && JSON.stringify(bAfter.r2) === JSON.stringify(bBefore.r2) };

  // ⑤ 函数日志里没有出错记录
  const lg = spawnSync('docker', ['logs', '--since', new Date(t0 - 2000).toISOString(), EDGE], { encoding: 'utf8' });
  const logs = `${lg.stdout}\n${lg.stderr}`;
  const lines = logs.split(/\r?\n/).filter((l) => l.includes('account-purge:'));
  out.checks['⑤'] = { codes: lines.map((l) => l.slice(l.indexOf('account-purge:'))).slice(0, 20), pass: !lines.some((l) => BAD_LOG.some((c) => l.includes(c))) };
  out.pass = Object.values(out.checks).every((c) => c.pass);
} finally {
  execFileSync('docker', ['rm', '-f', PROXY], { stdio: 'ignore' });
  server.close();
  rmSync(proxyDir, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 2));
process.exit(out.pass ? 0 : 1);
