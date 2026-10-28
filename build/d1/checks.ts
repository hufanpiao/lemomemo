// D1：supabase db reset 以后，数据库和数据清单（shared/manifests）、授权白名单（whitelist.ts）逐项比对（2.3、3.5 第 4 点；0.23、0.27、0.29 续）
// 只依赖一个 query 函数：CI 用 Deno + postgres 连本地库（build/check_data_manifest.ts），离线用 PGlite（supabase/tests/offline/run.mjs）
// 返回问题列表，空 = 通过
import type { Manifest, ManifestTable } from '../../shared/schema/manifest.ts';
import { COLUMN_GRANTS, FUNCTION_EXEC, PUBLIC_RPCS, REQUIRED_CONSTRAINTS, TABLE_GRANTS } from './whitelist.ts';

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;
export type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

const key = (schema: string, name: string) => `${schema}.${name}`;
const sorted = (a: Iterable<string>) => [...new Set(a)].sort();
const eq = (a: Iterable<string>, b: Iterable<string>) => sorted(a).join(',') === sorted(b).join(',');
const diff = (want: Iterable<string>, have: Iterable<string>) => {
  const w = new Set(want), h = new Set(have);
  const miss = [...w].filter((x) => !h.has(x)), extra = [...h].filter((x) => !w.has(x));
  return [miss.length ? `少了 ${miss.sort().join(', ')}` : '', extra.length ? `多了 ${extra.sort().join(', ')}` : ''].filter(Boolean).join('；');
};
const minus = (a: readonly string[], b: readonly string[]) => a.filter((x) => !b.includes(x));

export async function runD1(q: Query, manifests: readonly Manifest[]): Promise<string[]> {
  const out: string[] = [];
  const bad = (s: string) => out.push(s);

  // ---------- 1. 表：数据库里的每张表都登记了，登记的每张表都在；一张表只有一个主人 ----------
  const owner = new Map<string, string>();
  const tables: ManifestTable[] = [];
  for (const m of manifests) for (const t of m.tables) {
    const k = key(t.schema, t.name);
    if (owner.has(k)) bad(`表 ${k} 被 ${owner.get(k)} 和 ${m.feature} 两份清单登记`);
    owner.set(k, m.feature); tables.push(t);
  }
  const dbTables = (await q(`select n.nspname as s, c.relname as t, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname in ('public', 'private')`));
  const dbSet = new Set(dbTables.map((r) => key(r.s, r.t)));
  for (const k of dbSet) if (!owner.has(k)) bad(`数据库有表 ${k}，没登记进任何清单`);
  for (const k of owner.keys()) if (!dbSet.has(k)) bad(`清单登记了 ${k}（${owner.get(k)}），数据库里没有`);
  for (const r of dbTables) if (r.s === 'public' && !r.rls) bad(`public.${r.t} 没开 RLS`);
  const has = (t: ManifestTable) => dbSet.has(key(t.schema, t.name));

  // 列
  const colRows = await q(`select table_schema as s, table_name as t, column_name as c from information_schema.columns where table_schema in ('public', 'private')`);
  const colsOf = (s: string, t: string) => colRows.filter((r) => r.s === s && r.t === t).map((r) => r.c as string);

  // ---------- 2. 桶 ----------
  const dbBuckets = await q(`select id, public, file_size_limit, allowed_mime_types from storage.buckets`);
  const bucketOwner = new Map<string, string>();
  for (const m of manifests) for (const b of m.buckets) if (b.limits) {
    if (bucketOwner.has(b.name)) bad(`桶 ${b.name} 有两个主人：${bucketOwner.get(b.name)}、${m.feature}`);
    bucketOwner.set(b.name, m.feature);
    const d = dbBuckets.find((x) => x.id === b.name);
    if (!d) { bad(`清单登记了桶 ${b.name}（${m.feature}），数据库里没有`); continue; }
    if (d.public) bad(`桶 ${b.name} 是公开的`);
    if (Number(d.file_size_limit) !== b.limits.fileSizeLimit) bad(`桶 ${b.name} 的 file_size_limit 是 ${d.file_size_limit}，清单写 ${b.limits.fileSizeLimit}`);
    if (!eq(d.allowed_mime_types ?? [], b.limits.allowedMimeTypes)) bad(`桶 ${b.name} 的 allowed_mime_types：${diff(b.limits.allowedMimeTypes, d.allowed_mime_types ?? [])}`);
  }
  for (const d of dbBuckets) if (!bucketOwner.has(d.id)) bad(`数据库有桶 ${d.id}，没登记进任何清单`);
  for (const m of manifests) for (const b of m.buckets) if (!b.limits && !bucketOwner.has(b.name)) bad(`${m.feature} 登记了桶 ${b.name} 的一段路径，但这个桶没有主人`);
  // 存储策略里的路径正则和清单的 pathPattern 一字不差（images、files 两个有客户端策略的桶）
  const storagePolicies = (await q(`select coalesce(with_check, qual) as expr from pg_policies where schemaname = 'storage' and tablename = 'objects'`)).map((r) => String(r.expr));
  for (const m of manifests) for (const b of m.buckets) if (b.name === 'images') {
    if (!storagePolicies.some((p) => p.includes(b.pathPattern))) bad(`images 桶的存储策略里找不到 ${m.feature} 的 pathPattern ${b.pathPattern}`);
  }

  // ---------- 3. Realtime ----------
  const pub = (await q(`select schemaname as s, tablename as t from pg_publication_tables where pubname = 'supabase_realtime'`)).map((r) => key(r.s, r.t));
  const wantPub = tables.filter((t) => t.realtime).map((t) => key(t.schema, t.name));
  if (!eq(pub, wantPub)) bad(`supabase_realtime 里的表：${diff(wantPub, pub)}`);

  // ---------- 4. 客户端授权：表级、列级 ----------
  const tg = await q(`select table_schema as s, table_name as t, grantee as g, privilege_type as p from information_schema.role_table_grants
    where grantee in ('anon', 'authenticated', 'service_role', 'fn_vault', 'fn_ai')`);
  const cg = await q(`select table_schema as s, table_name as t, column_name as c, grantee as g, privilege_type as p from information_schema.column_privileges
    where grantee in ('anon', 'authenticated', 'fn_vault', 'fn_ai')`);
  const tableLevel = (g: string, s: string, t: string) => tg.filter((r) => r.g === g && r.s === s && r.t === t).map((r) => r.p as string);
  const colLevel = (g: string, s: string, t: string, p: string) => cg.filter((r) => r.g === g && r.s === s && r.t === t && r.p === p).map((r) => r.c as string);
  for (const t of tables.filter((t) => t.schema === 'public' && has(t))) {
    const name = `public.${t.name}`;
    const wantTable = ['SELECT', ...(t.clientDelete ? ['DELETE'] : [])];
    if (!eq(tableLevel('authenticated', 'public', t.name), wantTable)) bad(`${name} 给 authenticated 的表级授权：${diff(wantTable, tableLevel('authenticated', 'public', t.name))}`);
    if (tableLevel('anon', 'public', t.name).length) bad(`${name} 给 anon 有表级授权：${tableLevel('anon', 'public', t.name).join(', ')}`);
    const wantIns = minus(t.clientWritable, t.updateOnly), wantUpd = minus(t.clientWritable, t.insertOnly);
    if (!eq(colLevel('authenticated', 'public', t.name, 'INSERT'), wantIns)) bad(`${name} 的 insert 列授权和 clientWritable 不一致：${diff(wantIns, colLevel('authenticated', 'public', t.name, 'INSERT'))}`);
    if (!eq(colLevel('authenticated', 'public', t.name, 'UPDATE'), wantUpd)) bad(`${name} 的 update 列授权和 clientWritable 不一致：${diff(wantUpd, colLevel('authenticated', 'public', t.name, 'UPDATE'))}`);
    if (!eq(colLevel('anon', 'public', t.name, 'SELECT'), t.anonReadable)) bad(`${name} 给 anon 的列：${diff(t.anonReadable, colLevel('anon', 'public', t.name, 'SELECT'))}`);
    const cols = colsOf('public', t.name);
    for (const c of t.clientWritable) if (!cols.includes(c)) bad(`${name} 的 clientWritable 有 ${c}，表里没有这一列`);
  }
  // private：anon、authenticated 一律没有
  for (const r of tg) if (r.s === 'private' && (r.g === 'anon' || r.g === 'authenticated')) bad(`private.${r.t} 给了 ${r.g} ${r.p}`);
  for (const r of cg) if (r.s === 'private' && (r.g === 'anon' || r.g === 'authenticated')) bad(`private.${r.t}.${r.c} 给了 ${r.g} ${r.p}`);

  // ---------- 5. service_role、fn_vault、fn_ai 和白名单逐项比对 ----------
  for (const role of ['service_role', 'fn_vault', 'fn_ai'] as const) {
    const want = Object.entries(TABLE_GRANTS[role]).flatMap(([t, ps]) => ps.map((p) => `${t}:${p}`));
    const haveRows = tg.filter((r) => r.g === role && (role !== 'service_role' || r.s === 'private'));
    const have = haveRows.map((r) => `${r.s}.${r.t}:${r.p}`);
    if (!eq(have, want)) bad(`${role} 的表级授权和白名单不一致：${diff(want, have)}`);
    if (role === 'service_role') continue;
    const wantCols = Object.entries(COLUMN_GRANTS[role]).flatMap(([k, cs]) => cs.map((c) => `${k}:${c}`));
    const haveCols = cg.filter((r) => r.g === role && !have.includes(`${r.s}.${r.t}:${r.p}`)).map((r) => `${r.s}.${r.t}:${r.p}:${r.c}`);
    if (!eq(haveCols, wantCols)) bad(`${role} 的列级授权和白名单不一致：${diff(wantCols, haveCols)}`);
  }
  // 函数角色：属性和成员关系（TC-B0-33、77、83）
  const roles = await q(`select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolbypassrls from pg_roles where rolname in ('fn_vault', 'fn_ai')`);
  if (roles.length !== 2) bad('fn_vault、fn_ai 没建全');
  for (const r of roles) if (r.rolsuper || r.rolinherit || r.rolcreaterole || r.rolcreatedb || r.rolbypassrls) bad(`${r.rolname} 的角色属性不对（要 nosuperuser noinherit nocreaterole nocreatedb nobypassrls）`);
  const members = await q(`select r.rolname as role, u.rolname as member from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
    where r.rolname in ('fn_vault', 'fn_ai') or u.rolname in ('fn_vault', 'fn_ai')`);
  for (const m of members) {
    // PG16：建角色的 postgres 自动成为带 ADMIN、不带 INHERIT 和 SET 的成员，D1 只放过这一条
    if (m.member === 'postgres' && (m.role === 'fn_vault' || m.role === 'fn_ai')) continue;
    bad(`角色成员关系多了：${m.member} 是 ${m.role} 的成员`);
  }

  // ---------- 6. 函数执行权、属主、public RPC ----------
  const fns = await q(`select p.proname as f, pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer,
      p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role, has_function_privilege('fn_vault', p.oid, 'EXECUTE') as fn_vault,
      has_function_privilege('fn_ai', p.oid, 'EXECUTE') as fn_ai, n.nspname as s
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')`);
  for (const f of fns.filter((f) => f.s === 'private')) {
    if (f.pub) bad(`private.${f.f} 给了 PUBLIC 执行权`);
    if (f.owner !== 'postgres') bad(`private.${f.f} 的属主是 ${f.owner}，不是 postgres`);
    if (f.anon) bad(`private.${f.f} anon 能执行`);
    for (const role of ['authenticated', 'service_role', 'fn_vault', 'fn_ai'] as const) {
      if (f[role] && !FUNCTION_EXEC[role].includes(f.f)) bad(`private.${f.f} 给了 ${role} 执行权，不在白名单里`);
      if (!f[role] && FUNCTION_EXEC[role].includes(f.f)) bad(`private.${f.f} 在白名单里，却没给 ${role} 执行权`);
    }
  }
  for (const f of fns.filter((f) => f.s === 'public')) {
    if (!PUBLIC_RPCS.includes(f.f)) bad(`public.${f.f} 不在 3.3 D 的八个 RPC 里`);
    if (f.definer) bad(`public.${f.f} 是 security definer（public 里一律 invoker）`);
    if (f.anon || f.service_role) bad(`public.${f.f} 给了 anon 或 service_role 执行权`);
    if (!f.authenticated) bad(`public.${f.f} 没给 authenticated 执行权`);
  }
  // 视图：public 一律 security_invoker；private（扫描视图）一律 security_barrier
  const views = await q(`select n.nspname as s, c.relname as v, coalesce(array_to_string(c.reloptions, ','), '') as opts
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'v' and n.nspname in ('public', 'private')`);
  for (const v of views) {
    if (v.s === 'public' && !v.opts.includes('security_invoker=true')) bad(`public.${v.v} 没设 security_invoker`);
    if (v.s === 'private' && !v.opts.includes('security_barrier=true')) bad(`private.${v.v} 没设 security_barrier`);
  }

  // ---------- 7. 同步表：synced_at 和索引；软删除；触发器 ----------
  const idx = await q(`select tablename as t, indexdef as d from pg_indexes where schemaname = 'public'`);
  const trig = await q(`select n.nspname as s, c.relname as t, p.proname as f, t.tgname as name,
      array(select a.attname::text from unnest(t.tgattr::int2[]) k join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = k) as cols
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal and n.nspname in ('public', 'private')`);
  const trigTables = (f: string) => trig.filter((r) => r.f === f).map((r) => key(r.s, r.t));
  const syncTables = tables.filter((t) => t.sync === true).map((t) => key(t.schema, t.name));
  for (const t of tables.filter((t) => t.sync === true && has(t))) {
    if (!colsOf(t.schema, t.name).includes('synced_at')) bad(`${t.name} 同步却没有 synced_at`);
    if (!idx.some((r) => r.t === t.name && r.d.includes('(user_id, synced_at)'))) bad(`${t.name} 没有 (user_id, synced_at) 索引`);
  }
  for (const t of tables.filter((t) => t.schema === 'public' && has(t))) {   // private 的 deleted_at 是时间戳（deleted_accounts），不是软删除
    const hasDel = colsOf(t.schema, t.name).includes('deleted_at');
    if (t.softDelete !== hasDel && t.name !== 'tombstones') bad(`${t.name}：softDelete 写 ${t.softDelete}，表里${hasDel ? '有' : '没有'} deleted_at`);
  }
  if (!eq(trigTables('write_tombstone'), syncTables)) bad(`write_tombstone() 挂的表：${diff(syncTables, trigTables('write_tombstone'))}`);
  const touchWant = tables.filter((t) => t.systemCols).map((t) => key(t.schema, t.name));
  if (!eq(trigTables('touch'), touchWant)) bad(`touch() 挂的表和写了 systemCols 的表不一致：${diff(touchWant, trigTables('touch'))}`);
  const quotaWant = [...syncTables, 'public.logs'];
  if (!eq(trigTables('row_quota'), quotaWant)) bad(`row_quota() 挂的表：${diff(quotaWant, trigTables('row_quota'))}`);

  // ---------- 8. table_meta 和清单的 systemCols、noConflict ----------
  const meta = await q(`select tbl, system_cols, no_conflict from private.table_meta`);
  for (const t of tables.filter((t) => t.systemCols)) {
    const m = meta.find((r) => r.tbl === t.name);
    if (!m) { bad(`${t.name} 挂了 touch()，private.table_meta 里没有它的行`); continue; }
    if (!eq(m.system_cols, t.systemCols!)) bad(`table_meta.${t.name}.system_cols 和清单不一致：${diff(t.systemCols!, m.system_cols)}`);
    if (!eq(m.no_conflict, t.noConflict!)) bad(`table_meta.${t.name}.no_conflict 和清单不一致：${diff(t.noConflict!, m.no_conflict)}`);
    const cols = colsOf(t.schema, t.name);
    for (const c of [...t.systemCols!, ...t.noConflict!]) if (!cols.includes(c)) bad(`${t.name} 的 systemCols / noConflict 有 ${c}，表里没有`);
  }
  for (const m of meta) if (!tables.some((t) => t.name === m.tbl && t.systemCols)) bad(`table_meta 有 ${m.tbl}，清单里没写 systemCols`);

  // ---------- 9. vaultRows：每一列都归了类（TC-B0-25） ----------
  for (const t of tables.filter((t) => t.vaultRows && has(t))) {
    const v = t.vaultRows!;
    const classified = new Set([...v.cipherCols, ...v.plainColsMustBeNull, ...v.neutralCols]);
    for (const c of colsOf(t.schema, t.name)) if (!classified.has(c)) bad(`${t.name}.${c} 没归进 vaultRows 的 cipherCols / plainColsMustBeNull / neutralCols`);
    for (const c of classified) if (!colsOf(t.schema, t.name).includes(c)) bad(`${t.name} 的 vaultRows 写了 ${c}，表里没有`);
  }

  // ---------- 10. recordKinds（0.27 第 2 点） ----------
  const kinds = manifests.flatMap((m) => m.recordKinds);
  const vecKinds = kinds.filter((k) => k.vector).map((k) => k.kind);
  const cons = await q(`select n.nspname as s, c.relname as t, pg_get_constraintdef(k.oid) as d from pg_constraint k
    join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private')`);
  for (const t of ['note_vectors', 'embed_queue']) {
    const d = cons.find((r) => r.s === 'private' && r.t === t && /^CHECK \(\(kind = ANY/.test(r.d));
    const inDb = d ? [...String(d.d).matchAll(/'([a-z]+)'::text/g)].map((x) => x[1]) : [];
    if (!eq(inDb, vecKinds)) bad(`private.${t} 的 kind 约束和带 vector 的 recordKinds 不一致：${diff(vecKinds, inDb)}`);
  }
  for (const k of kinds.filter((k) => k.vector)) {
    const re = new RegExp(`^FOREIGN KEY \\(${k.vector!.fk}, user_id\\) REFERENCES (public\\.)?${k.table}\\(id, user_id\\) ON DELETE CASCADE$`);
    if (!cons.some((r) => r.s === 'private' && r.t === 'note_vectors' && re.test(r.d))) bad(`note_vectors 缺 ${k.kind} 的外键 ${k.vector!.fk} → ${k.table}`);
  }
  const vectors: Record<string, string[]> = {};
  for (const m of manifests) Object.assign(vectors, m.ai?.vectors ?? {});
  const extra = manifests.flatMap((m) => m.extraEmbedSources);
  const embedTrig = trig.filter((r) => r.f === 'enqueue_embed');
  for (const k of kinds.filter((k) => k.vector)) if (!vectors[k.table]) bad(`${k.kind} 进向量，但清单没写 ai.vectors.${k.table}`);
  for (const [t, cs] of Object.entries(vectors)) {
    const r = embedTrig.find((x) => x.s === 'public' && x.t === t);
    if (!r) bad(`enqueue_embed() 没挂在 ${t} 上`);
    else if (!eq(r.cols, cs)) bad(`${t} 的 enqueue_embed() 触发列和 ai.vectors 不一致：${diff(cs, r.cols)}`);
  }
  for (const r of embedTrig) if (!vectors[r.t] && !extra.includes(key(r.s, r.t))) bad(`enqueue_embed() 挂在 ${key(r.s, r.t)} 上，清单没登记`);
  const featDefault = (await q(`select pg_get_expr(d.adbin, d.adrelid) as e from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    where d.adrelid = 'public.app_config'::regclass and a.attname = 'features'`))[0]?.e ?? '';
  const featKeys = Object.keys(JSON.parse((/'(.*)'::jsonb/s.exec(featDefault) ?? ['', '{}'])[1]));
  for (const f of new Set(kinds.map((k) => k.flag))) if (!featKeys.includes(f)) bad(`开关 ${f} 不在 app_config.features 的默认值里`);

  // ---------- 11. 必须有的约束 ----------
  for (const [t, re] of REQUIRED_CONSTRAINTS) {
    const [s, n] = t.split('.');
    if (!cons.some((r) => r.s === s && r.t === n && re.test(r.d))) bad(`${t} 缺约束 ${re.source}`);
  }

  // ---------- 12. cron：动用户表的命令一律带超时（0.29 续第 141 条） ----------
  const jobs = await q(`select jobname, command from cron.job`);
  for (const j of jobs) if (/\bprivate\.\w+_batch\(|\b(update|delete)\s+(from\s+)?public\./i.test(j.command) && !/^set statement_timeout = '4min';/.test(j.command)) {
    bad(`cron 任务 ${j.jobname} 动用户表，却不以 set statement_timeout 开头`);
  }
  return out;
}
