// TC-B1-73 本机参考测量：在 lemo-e2e 里造一个“每张表都到行数上限”的账号，调一次 account export，记 gzip 前后大小、耗时、函数容器 CPU 和内存。
//
// 用法（仓库根目录，先 npm run e2e:real:up；量完 npm run e2e:real:down）：
//   node tools/e2e/export-full-account.mjs [--profile typ|max] [--notes-body N] [--excerpt N] [--log-rows N] [--sync-rows N]
//     --profile typ  各文本列取常见长度（默认）；max  各文本列取到库里 check 的上限（没有 check 的 note 列按 2000 字）
//     --notes-body / --excerpt  单独指定 notes.body、note_files.text_excerpt 的字数（中文随机字），覆盖 profile 的值
//     --log-rows  logs 行数，默认 180000（每人每天 2000 条 × 保留 90 天）；--sync-rows  每张同步表行数，默认 20000（row_quota）
//   每跑一次新建一个 export-load-<时间>@lemomemo.test 账号（导出每天 3 次，换账号不用清计数）。
//
// 只碰 lemo-e2e：API 地址取 real-backend.mjs 的 statusEnv()（过它的护栏），端口必须在 55320～55329；
// 造数据只经 docker exec 进 supabase_db_lemo-e2e（容器名写死，跑前核对它在跑），不连任何别的库、不读写别的容器。
// 本地演示密钥只在进程内用，不打印。
// categories 有 (user_id, lower(name)) 唯一索引：名字截短后拼上行号。
// 文本用 3000 个常用区段汉字随机拼（比真实文字更难压缩，gzip 比按偏保守算）；每个文本列先生成 1000 条放进临时表，按行号轮着取。
/* global fetch, console -- Node 24 的全局（fetch 没有 node: 模块可 import） */
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { argv, exit, stdout } from 'node:process';
import { statusEnv } from './real-backend.mjs';

const DB = 'supabase_db_lemo-e2e';
const EDGE = 'supabase_edge_runtime_lemo-e2e';

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
const L = {
  evTitle: MAX ? 160 : 20, evNote: MAX ? 2000 : 40, evRaw: MAX ? 2000 : 40, evLoc: MAX ? 200 : 10, project: MAX ? 40 : 4, short: MAX ? 32 : 6,
  tdTitle: MAX ? 160 : 20, tdNote: MAX ? 2000 : 40, tdRaw: MAX ? 2000 : 40,
  catName: MAX ? 12 : 4,
  noteTitle: MAX ? 160 : 10, noteBody: intArg('notes-body', MAX ? 20000 : 300), noteRaw: MAX ? 2000 : 0,
  imgDesc: MAX ? 200 : 30, fileName: MAX ? 110 : 12, excerpt: intArg('excerpt', MAX ? 20000 : 200),
  annName: MAX ? 60 : 6, annNote: MAX ? 2000 : 20,
  setVal: MAX ? 1300 : 4, devLabel: MAX ? 60 : 10,
};
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

async function j(path, init, key = SR) {
  const r = await fetch(API + path, { ...init, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

// ---------- 建账号、拿 OTP 会话 ----------
const email = `export-load-${Date.now()}@lemomemo.test`;
const user = await j('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, email_confirm: true }) });
const uid = user.id;
if (!/^[0-9a-f-]{36}$/.test(uid)) throw new Error('user id 不对');

// ---------- 造数据 ----------
const sql = String.raw`
set statement_timeout = 0;
\set ON_ERROR_STOP 1
create function pg_temp.zh(n int) returns text language sql volatile as $f$
  select coalesce(string_agg(chr(19968 + floor(random() * 3000)::int), ''), '') from generate_series(1, n) $f$;
create function pg_temp.az(n int) returns text language sql volatile as $f$
  select coalesce(string_agg(chr(97 + floor(random() * 26)::int), ''), '') from generate_series(1, n) $f$;
create temp table pool (k text, i int, s text, primary key (k, i));
insert into pool select k, i, pg_temp.zh(n) from (values
  ('evTitle', ${Math.max(L.evTitle, 1)}), ('evNote', ${L.evNote}), ('evRaw', ${L.evRaw}), ('evLoc', ${L.evLoc}), ('project', ${L.project}), ('short', ${L.short}),
  ('tdTitle', ${Math.max(L.tdTitle, 1)}), ('tdNote', ${L.tdNote}), ('tdRaw', ${L.tdRaw}), ('catName', ${Math.max(L.catName, 1)}),
  ('noteTitle', ${L.noteTitle}), ('noteBody', ${L.noteBody}), ('noteRaw', ${L.noteRaw}), ('imgDesc', ${L.imgDesc}), ('fileName', ${Math.max(L.fileName, 1)}),
  ('excerpt', ${L.excerpt}), ('annName', ${Math.max(L.annName, 1)}), ('annNote', ${L.annNote}), ('setVal', ${L.setVal}), ('devLabel', ${L.devLabel})
) v(k, n), generate_series(0, 999) i;
create function pg_temp.p(k text, g bigint) returns text language sql stable as $f$ select s from pool where pool.k = $1 and pool.i = ($2 * 7919) % 1000 $f$;

insert into public.profiles (user_id, display_name) values ('${uid}', 'export-load');
insert into public.settings (id, user_id, key, value)
  select gen_random_uuid(), '${uid}', 'load.' || g, to_jsonb(pg_temp.p('setVal', g)) from generate_series(1, ${SYNC}) g;
insert into public.devices (id, user_id, label, platform, push_endpoint, p256dh, auth, app_version, last_seen_at, install_id)
  select gen_random_uuid(), '${uid}', pg_temp.p('devLabel', g), 'web',
    ${MAX ? `'https://fcm.googleapis.com/fcm/send/' || pg_temp.az(140) || g` : 'null'}, ${MAX ? 'pg_temp.az(87)' : 'null'}, ${MAX ? 'pg_temp.az(22)' : 'null'},
    '4.0.0', now(), gen_random_uuid() from generate_series(1, ${SYNC}) g;
insert into public.events (id, user_id, title, date, time, tz, project, note, raw_text, location, short, created_at, updated_at)
  select gen_random_uuid(), '${uid}', pg_temp.p('evTitle', g), date '2026-01-01' + (g % 700)::int, '09:30', 'Asia/Seoul',
    pg_temp.p('project', g), pg_temp.p('evNote', g), pg_temp.p('evRaw', g), pg_temp.p('evLoc', g), nullif(pg_temp.p('short', g), ''),
    1790000000000 + g, 1790000000000 + g from generate_series(1, ${SYNC}) g;
insert into public.todos (id, user_id, title, due, project, note, raw_text, short, created_at, updated_at)
  select gen_random_uuid(), '${uid}', pg_temp.p('tdTitle', g), date '2026-01-01' + (g % 700)::int,
    pg_temp.p('project', g), pg_temp.p('tdNote', g), pg_temp.p('tdRaw', g), nullif(pg_temp.p('short', g), ''),
    1790000000000 + g, 1790000000000 + g from generate_series(1, ${SYNC}) g;
insert into public.categories (id, user_id, name, color, sort)
  select gen_random_uuid(), '${uid}', left(pg_temp.p('catName', g), greatest(${L.catName} - length(g::text), 1)) || g, '#aabbcc', g from generate_series(1, ${SYNC}) g;
insert into public.notes (id, user_id, title, body, raw_text, created_at, updated_at)
  select gen_random_uuid(), '${uid}', nullif(pg_temp.p('noteTitle', g), ''), pg_temp.p('noteBody', g), pg_temp.p('noteRaw', g),
    1790000000000 + g, 1790000000000 + g from generate_series(1, ${SYNC}) g;
create temp table nids as select id, row_number() over (order by id) rn from public.notes where user_id = '${uid}';
insert into public.note_images (id, user_id, note_id, bucket, path, bytes, width, height, ai_status, ai_desc, ai_tags)
  select x.id, '${uid}', x.nid, 'images', '${uid}/' || x.nid || '/' || x.id || '.webp', 300000, 1600, 1200, 'done',
    nullif(pg_temp.p('imgDesc', x.g), ''), ${MAX ? "array_fill('标签标签'::text, array[12])" : "array['猫','公园','晴天']"}
  from (select gen_random_uuid() id, n.id nid, g from generate_series(1, ${SYNC}) g join nids n on n.rn = 1 + (g - 1) % ${SYNC}) x;
insert into public.note_files (id, user_id, note_id, kind, path, name, mime, bytes, sha256, pages, text_excerpt, check_status, ai_status, ai_desc, ai_tags, created_at, updated_at)
  select x.id, '${uid}', x.nid, 'pdf', '${uid}/' || x.nid || '/' || x.id || '.pdf', pg_temp.p('fileName', x.g) || '.pdf', 'application/pdf', 2000000,
    encode(sha256(x.id::text::bytea), 'hex'), 12, nullif(pg_temp.p('excerpt', x.g), ''), 'ok', 'done', nullif(pg_temp.p('imgDesc', x.g), ''),
    ${MAX ? "array_fill('标签标签'::text, array[12])" : "array['合同']"}, 1790000000000 + x.g, 1790000000000 + x.g
  from (select gen_random_uuid() id, n.id nid, g from generate_series(1, ${SYNC}) g join nids n on n.rn = 1 + (g - 1) % ${SYNC}) x;
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, year, remind_offsets, remind_time, note, created_at, updated_at)
  select gen_random_uuid(), '${uid}', 'birthday', pg_temp.p('annName', g), 'solar', 1 + g % 12, 1 + g % 28, 1990, array[0, 7]::smallint[], '09:00',
    pg_temp.p('annNote', g), 1790000000000 + g, 1790000000000 + g from generate_series(1, ${SYNC}) g;
insert into public.logs (user_id, t, device, kind, act, src, coll, item_id, fields, code)
  select '${uid}', 1790000000000 - g::bigint * 43200, ${MAX ? 'pg_temp.az(64)' : 'gen_random_uuid()::text'}, ${MAX ? 'pg_temp.az(16)' : "'run'"},
    ${MAX ? 'pg_temp.az(32)' : "'update'"}, ${MAX ? 'pg_temp.az(16)' : "'page'"}, ${MAX ? 'pg_temp.az(32)' : "'events'"}, gen_random_uuid(),
    ${MAX ? "array_fill(pg_temp.az(31), array[20])" : "array['title','date']"}, ${MAX ? 'pg_temp.az(64)' : 'null'}
  from generate_series(1, ${LOGS}) g;
select t, n from (
  select 'settings' t, count(*) n from public.settings where user_id = '${uid}' union all
  select 'devices', count(*) from public.devices where user_id = '${uid}' union all
  select 'events', count(*) from public.events where user_id = '${uid}' union all
  select 'todos', count(*) from public.todos where user_id = '${uid}' union all
  select 'categories', count(*) from public.categories where user_id = '${uid}' union all
  select 'notes', count(*) from public.notes where user_id = '${uid}' union all
  select 'note_images', count(*) from public.note_images where user_id = '${uid}' union all
  select 'note_files', count(*) from public.note_files where user_id = '${uid}' union all
  select 'anniversaries', count(*) from public.anniversaries where user_id = '${uid}' union all
  select 'logs', count(*) from public.logs where user_id = '${uid}') c;
`;
const t0 = Date.now();
const seedOut = docker(['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-A', '-t', '-F', '='], sql);
console.log(`造数据 ${((Date.now() - t0) / 1000).toFixed(1)} 秒，profile=${profile}，notes.body=${L.noteBody} 字，excerpt=${L.excerpt} 字`);
console.log(seedOut.trim().split(/\r?\n/).join('  '));

// ---------- OTP 会话（account 拒密码会话） ----------
const link = await j('/auth/v1/admin/generate_link', { method: 'POST', body: JSON.stringify({ type: 'magiclink', email }) });
const hashed = link.hashed_token ?? link.properties?.hashed_token;
const sess = await j('/auth/v1/verify', { method: 'POST', body: JSON.stringify({ type: 'magiclink', token_hash: hashed }) }, ANON);
const jwt = sess.access_token;

// ---------- 函数容器的 CPU、内存（cgroup v2，整个 edge runtime 容器，偏大） ----------
const cg = (f) => docker(['exec', EDGE, 'cat', `/sys/fs/cgroup/${f}`]);
const cpuUsec = () => Number(/usage_usec (\d+)/.exec(cg('cpu.stat'))?.[1] ?? NaN);
const memNow = () => Number(cg('memory.current').trim());
// 先空调一次 status，让 account 的 worker 起来（冷启动不算进导出）
await fetch(`${API}/functions/v1/account`, { method: 'POST', headers: { apikey: ANON, authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: '{"action":"status"}' }).then((r) => r.text());
const mem0 = memNow();
let memMax = mem0;
let polling = true;
const poll = (async () => { while (polling) { try { memMax = Math.max(memMax, memNow()); } catch { /* 采样失败跳过 */ } await new Promise((r) => setTimeout(r, 250)); } })();
const cpu0 = cpuUsec();
const s = performance.now();
const res = await fetch(`${API}/functions/v1/account`, {
  method: 'POST', headers: { apikey: ANON, authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: '{"action":"export"}',
});
const ttfb = performance.now() - s;
const buf = Buffer.from(await res.arrayBuffer());
const total = performance.now() - s;
const cpu1 = cpuUsec();
polling = false;
await poll;

const out = { profile, status: res.status, contentType: res.headers.get('content-type'), contentEncoding: res.headers.get('content-encoding'),
  ttfbMs: Math.round(ttfb), totalMs: Math.round(total), edgeCpuMs: Math.round((cpu1 - cpu0) / 1000),
  edgeMemBaseMB: +(mem0 / 1048576).toFixed(1), edgeMemPeakMB: +(memMax / 1048576).toFixed(1), bodyBytes: buf.length };
if (res.status === 200) {
  let raw = buf;
  try { raw = gunzipSync(buf); out.gzipBytes = buf.length; } catch { out.note = '响应体不是 gzip（可能被 fetch 自动解压）'; }
  out.rawBytes = raw.length;
  out.ratio = +(raw.length / buf.length).toFixed(2);
  const doc = JSON.parse(raw.toString('utf8'));
  out.rows = Object.fromEntries(Object.entries(doc.tables).map(([k, v]) => [k, v.length]));
} else {
  out.error = buf.toString('utf8').slice(0, 300);
}
stdout.write(JSON.stringify(out, null, 1) + '\n');
