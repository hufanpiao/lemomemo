-- B1 迁移 20261031100000_core_export_jobs.sql：导出任务 private.export_job_start / export_job_take、库大小 private.db_size_bytes、
-- 导出前的大小预检 private.export_size_over（架构 0.47 第 13、16、17、18 条，0.47 续 ① 列的 pgTAP 条目；安全审查 M1、M3、复核 N1、N3）。函数那一半在 tests/functions/account-export*.test.ts
begin;
select plan(36);
\ir _helpers.psql
select tests.seed();

-- 用到的 id：A、B 是 seed 的两个账号；E 是一个导出任务；S 是 A 的会话，S2 是 A 的另一个会话
create temp table ids as select
  'aaaaaaaa-0000-4000-8000-000000000001'::uuid as a, 'bbbbbbbb-0000-4000-8000-000000000002'::uuid as b,
  'eeeeeeee-0000-4000-8000-0000000000e1'::uuid as e,
  'aaaaaaaa-5555-4000-8000-000000000001'::uuid as s, 'dddddddd-5555-4000-8000-000000000009'::uuid as s2;
grant select on ids to anon, authenticated, service_role;
create temp view job as select c.* from private.counters c, ids
  where c.key = 'export-job:' || ids.a || ':' || ids.e || '.omitted.' || ids.s;
grant select on job to service_role;

-- ① 三个函数只给 service_role：anon、authenticated 调不了
select ok(tests.try_as('anon', null, $$select private.export_job_start(a, e, 'omitted', s) from ids$$) like '42501%', 'export_job_start：anon 没有执行权');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select private.export_job_start(a, e, 'omitted', s) from ids$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') like '42501%',
  'export_job_start：authenticated（本人）也没有执行权');
select ok(tests.try_as('anon', null, $$select * from private.export_job_take(gen_random_uuid(), gen_random_uuid(), 'omitted', gen_random_uuid(), 36, 3600)$$) like '42501%',
  'export_job_take：anon 没有执行权');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select t.* from ids, private.export_job_take(a, e, 'omitted', s, 36, 3600) t$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') like '42501%',
  'export_job_take：authenticated（本人）也没有执行权');
select ok(tests.try_as('anon', null, $$select * from private.db_size_bytes()$$) like '42501%', 'db_size_bytes：anon 没有执行权');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select * from private.db_size_bytes()$$) like '42501%',
  'db_size_bytes：authenticated 没有执行权');

-- ② service_role 建任务：键过得了 counters 的三段约束，count 0，window_start 是真实开始时刻（本事务里就是 now()），返回同一刻
select is(tests.rows_as('service_role', null, $$select private.export_job_start(a, e, 'omitted', s) = now() as same from ids$$),
  '[{"same": true}]'::jsonb, 'export_job_start 返回开始时刻（= now()，不取整）');
select is((select count(*)::int from job), 1, '建出一行任务');
select is((select (count, window_start = now()) from job), (0, true), '任务行 count 0、window_start 是真实开始时刻');

-- ③ N1：同键已有一行时再建报错、不插第二行（counters 主键是 (key, window_start)，单插不报重）
select ok(tests.try_as('service_role', null, $$select private.export_job_start(a, e, 'omitted', s) from ids$$) like '23505%',
  '同键已有一行：export_job_start 报错（N1）');
update private.counters set window_start = window_start - interval '1 minute' where key in (select key from job);
select ok(tests.try_as('service_role', null, $$select private.export_job_start(a, e, 'omitted', s) from ids$$) like '23505%',
  '同键、window_start 不同（不撞主键）也报错（先查再插）');
select is((select count(*)::int from job), 1, '报错以后仍只有一行，没插第二行');

-- ④ 取片：ok、开始时刻和任务行一致、count 原子 +1
select is(tests.rows_as('service_role', null, $$select t.verdict, t.started_at = (select window_start from job) as same
  from ids, private.export_job_take(a, e, 'omitted', s, 3, 3600) t$$), '[{"verdict": "ok", "same": true}]'::jsonb, '第 1 片 ok，started_at = 任务的开始时刻');
select is(tests.rows_as('service_role', null, $$select t.verdict, t.parts from ids, private.export_job_take(a, e, 'omitted', s, 3, 3600) t$$),
  '[{"parts": 2, "verdict": "ok"}]'::jsonb, '第 2 片 ok，parts = 2（取自任务行）');
select is((select count from job), 2, '取了 2 片，count = 2');

-- ⑤ 别的用户、别的会话、别的模式：一律 expired（同一个回应，M3），也不动任务行
select is(tests.rows_as('service_role', null, $$select t.* from ids, private.export_job_take(b, e, 'omitted', s, 3, 3600) t$$),
  '[{"parts": null, "verdict": "expired", "started_at": null}]'::jsonb, '别的用户拿这个 export_id：expired');
select is(tests.rows_as('service_role', null, $$select t.* from ids, private.export_job_take(a, e, 'omitted', s2, 3, 3600) t$$),
  '[{"parts": null, "verdict": "expired", "started_at": null}]'::jsonb, '同一用户别的会话：expired');
select is(tests.rows_as('service_role', null, $$select t.* from ids, private.export_job_take(a, e, 'cipher', s, 3, 3600) t$$)
  || tests.rows_as('service_role', null, $$select t.* from private.export_job_take('aaaaaaaa-0000-4000-8000-000000000001', gen_random_uuid(), 'omitted', 'aaaaaaaa-5555-4000-8000-000000000001', 3, 3600) t$$),
  '[{"parts": null, "verdict": "expired", "started_at": null}, {"parts": null, "verdict": "expired", "started_at": null}]'::jsonb, '模式不一致、任务不存在：同样 expired');
select is((select count from job), 2, '这几次 expired 都没动任务行');

-- ⑥ 超上限：第 3 片 ok，第 4 片 too_many（超了的这次也算）
select tests.rows_as('service_role', null, $$select * from ids, private.export_job_take(a, e, 'omitted', s, 3, 3600)$$);
select is(tests.rows_as('service_role', null, $$select t.verdict, t.started_at is not null as has_start from ids, private.export_job_take(a, e, 'omitted', s, 3, 3600) t$$),
  '[{"verdict": "too_many", "has_start": true}]'::jsonb, '超过 p_max：too_many，带开始时刻；count = 4');

-- ⑦ 跨 UTC 整点继续：开始时刻挪到上一个整点之前 1 秒，仍在 3600 秒内 → ok，分片数接着算、不清零
update private.counters set window_start = date_trunc('hour', now()) - interval '1 second' where key in (select key from job);
create temp table cross_hour as select tests.rows_as('service_role', null, $$select t.verdict from ids, private.export_job_take(a, e, 'omitted', s, 36, 3600) t$$) as r;
select is((select r from cross_hour) || jsonb_build_array(jsonb_build_object('n', (select count from job))),
  '[{"verdict": "ok"}, {"n": 5}]'::jsonb, '跨 UTC 整点：不过期，分片数从 4 接着到 5（不按整点清零）');

-- ⑧ 3600 秒边界：开始满 3599 秒仍 ok，满 3600 秒 expired
update private.counters set window_start = now() - interval '3599 seconds' where key in (select key from job);
select is(tests.rows_as('service_role', null, $$select t.verdict from ids, private.export_job_take(a, e, 'omitted', s, 36, 3600) t$$),
  '[{"verdict": "ok"}]'::jsonb, '开始 3599 秒：ok');
update private.counters set window_start = now() - interval '3600 seconds' where key in (select key from job);
select is(tests.rows_as('service_role', null, $$select t.verdict from ids, private.export_job_take(a, e, 'omitted', s, 36, 3600) t$$),
  '[{"verdict": "expired"}]'::jsonb, '开始满 3600 秒：expired');

-- ⑨ 参数不对报错（不悄悄放行）
select ok(tests.try_as('service_role', null, $$select private.export_job_start(a, gen_random_uuid(), 'plain', s) from ids$$) like '22023%'
  and tests.try_as('service_role', null, $$select * from ids, private.export_job_take(a, e, 'omitted', s, 0, 3600)$$) like '22023%'
  and tests.try_as('service_role', null, $$select private.export_job_start(a, gen_random_uuid(), 'omitted', null) from ids$$) like '22023%',
  '模式不认识、p_max < 1、会话为空：bad_export_job_args');

-- ⑩ db_size_bytes：service_role 读得到库大小和数据库当前时刻（N3：at 就是运行开始时刻）
select is(tests.rows_as('service_role', null, $$select bytes > 0 as has_size, at = now() as is_now from private.db_size_bytes()$$),
  '[{"has_size": true, "is_now": true}]'::jsonb, 'db_size_bytes：bytes > 0，at = 数据库的 now()');

-- ⑪ export_size_over（0.47 第 18、19 条，安全复核 Q1～Q3、回查 R1）：只给 service_role；表清单固定在函数里；只算本人的行；
--    超过 p_limit 提前返回；时间预算用完返回 -1；没解锁不算隐私记行。
--    “拿不到锁返回 -2”要另一个会话先拿住锁，离线 PGlite 只有一个会话、同一会话的 advisory 锁可重入，这里测不了，函数单测和 R5 实测覆盖
select ok(tests.try_as('anon', null, $$select private.export_size_over(a, 'omitted', 1000, 15000) from ids$$) like '42501%'
  and tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
    $$select private.export_size_over(a, 'omitted', 1000, 15000) from ids$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') like '42501%',
  'export_size_over：anon、authenticated（本人）都没有执行权');
-- 用一个新用户 C：只有这里造的行，期望值按 11 张表逐表算（seed 给 A、B 造的行不掺进来）
create temp table cu as select 'cccccccc-0000-4000-8000-0000000000c3'::uuid as c;
grant select on cu to service_role;
insert into auth.users (id, email) select c, 'size-c@lemomemo.test' from cu;
insert into public.logs (user_id, t, kind, act, src, code) select cu.c, g, 'run', 'sync', 'app', repeat('x', 40) from cu, generate_series(1, 5) g;
insert into public.logs (user_id, t, kind, act, src, code) select ids.b, g, 'run', 'sync', 'app', repeat('y', 60) from ids, generate_series(1, 7) g;
create function pg_temp.size_of(p uuid, p_vault boolean) returns bigint language sql as $f$
  select coalesce(sum(n), 0)::bigint from (
    select octet_length(row_to_json(x.*)::text) n from public.profiles x where x.user_id = p
    union all select octet_length(row_to_json(x.*)::text) from public.settings x where x.user_id = p
    union all select octet_length(row_to_json(x.*)::text) from public.devices x where x.user_id = p
    union all select octet_length(row_to_json(x.*)::text) from public.logs x where x.user_id = p
    union all select octet_length(row_to_json(x.*)::text) from public.events x where x.user_id = p
    union all select octet_length(row_to_json(x.*)::text) from public.todos x where x.user_id = p
    union all select octet_length(row_to_json(x.*)::text) from public.categories x where x.user_id = p
    union all select octet_length(row_to_json(x.*)::text) from public.notes x where x.user_id = p and (p_vault or not x.is_private)
    union all select octet_length(row_to_json(x.*)::text) from public.note_images x where x.user_id = p and (p_vault or x.bucket is distinct from 'vault-images')
    union all select octet_length(row_to_json(x.*)::text) from public.note_files x where x.user_id = p and (p_vault or not x.is_vault)
    union all select octet_length(row_to_json(x.*)::text) from public.anniversaries x where x.user_id = p) s
$f$;
create temp table size_c as select pg_temp.size_of(cu.c, false) as n from cu;
grant select on size_c to service_role;
select is(tests.rows_as('service_role', null, $$select private.export_size_over(c, 'omitted', 1000000000, 15000) = (select n from size_c) as same from cu$$),
  '[{"same": true}]'::jsonb, '没超上限：返回本人 11 张表各行 JSON 原文字节合计（别人的行不算）');
select is(tests.rows_as('service_role', null, $$select (r > 0 and r < (select n from size_c)) as early
  from (select private.export_size_over(c, 'omitted', 0, 15000) as r from cu) x$$),
  '[{"early": true}]'::jsonb, '超过 p_limit 提前返回：p_limit = 0 时读到第一行就停，返回当时的合计（> p_limit、< 全部）');
select is(tests.rows_as('service_role', null, $$select private.export_size_over(gen_random_uuid(), 'omitted', 0, 15000) as r$$),
  '[{"r": 0}]'::jsonb, '没有行的用户：0');
select is(tests.rows_as('service_role', null, $$select private.export_size_over(c, 'omitted', 1000000000, 0) as r from cu$$),
  '[{"r": -1}]'::jsonb, '时间预算 0 毫秒：每张表开始扫之前比一次时钟，返回 -1（Q2、回查 R1）');
-- 没解锁不算隐私记行：给 C 造一条普通记事、一条隐私记（只有密文列），omitted 只多普通那条，cipher 两条都算
insert into public.notes (id, user_id, title, body, created_at, updated_at) select 'cccccccc-1111-4000-8000-0000000000c1', cu.c, 't', repeat('p', 300), 1, 1 from cu;
insert into public.notes (id, user_id, is_private, body_enc, enc_key_id, created_at, updated_at)
  select 'cccccccc-2222-4000-8000-0000000000c2', cu.c, true, decode(repeat('ab', 500), 'hex'), 1, 1, 1 from cu;
create temp table size_c2 as select pg_temp.size_of(cu.c, false) as omitted_n, pg_temp.size_of(cu.c, true) as cipher_n from cu;
grant select on size_c2 to service_role;
select is(tests.rows_as('service_role', null, $$select
    private.export_size_over(c, 'omitted', 1000000000, 15000) = (select omitted_n from size_c2) as omitted_ok,
    private.export_size_over(c, 'cipher', 1000000000, 15000) = (select cipher_n from size_c2) as cipher_ok,
    (select cipher_n > omitted_n from size_c2) as differs from cu$$),
  '[{"omitted_ok": true, "cipher_ok": true, "differs": true}]'::jsonb, '没解锁（omitted）不算隐私记行；解锁（cipher）整行都算');
-- 胖行（回查 R1）：notes 里 300 行、每行正文 2 万个汉字约 6 万字节（不到 1,000 行、合计超 16 MB）；预算 1 毫秒时返回 -1（每 16 MB 比一次时钟），
--   预算够时照常算完、合计超 16 MB。“满 16 MB 那一次”比时钟的分支在下面单独锁住（代码审查）。
--   原来用 anniversaries.note 造 6 MB 的行；迁移 20261031110000 给它加了 2000 字上限，现在库里最胖的是 notes.body（≤ 20000 字）
insert into public.notes (id, user_id, title, body, created_at, updated_at)
  select gen_random_uuid(), cu.c, 'fat', repeat('汉', 20000), 1, 1 from cu, generate_series(1, 300);
select is(tests.rows_as('service_role', null, $$select private.export_size_over(c, 'omitted', 100000000000, 1) as r from cu$$),
  '[{"r": -1}]'::jsonb, '胖行（300 行合计约 18 MB）：预算 1 毫秒返回 -1');
select is(tests.rows_as('service_role', null, $$select private.export_size_over(c, 'omitted', 100000000000, 60000) > 16777216 as big from cu$$),
  '[{"big": true}]'::jsonb, '同样的胖行、预算够：照常算完，合计超 16 MB');
-- 锁住“满 16 MB 那一次”比时钟的分支（代码审查）：两处比时钟都回 -1，靠两点分开——
--   ① 本事务里临时把 note_images 改名：notes 读完走到下一张表会先报 bad_export_table（22023，查表在比时钟之前），不会回 -1；
--   ② notes 的扫描次数（pg_stat_xact_user_tables）：表开头那一次退出时 notes 没扫（+0），扫进 notes 以后退出才 +1。
--   所以“回 -1 且 notes 扫了一次”只能是 notes 里 n < 1000、满 16 MB 那一次比出来的。预算从 1 毫秒往上试（机器快慢不同），有一个预算满足就算锁住
alter table public.note_images rename to note_images_b10;
create function pg_temp.mid_notes_exit(p uuid) returns text language plpgsql as $f$
declare b int; r bigint; s0 bigint; s1 bigint; seen text := '';
begin
  for b in 1..60 loop
    select seq_scan + coalesce(idx_scan, 0) into s0 from pg_catalog.pg_stat_xact_user_tables where relid = 'public.notes'::regclass;
    begin
      r := private.export_size_over(p, 'omitted', 100000000000, b);
    exception when sqlstate '22023' then
      r := null;   -- notes 读完了，走到改了名的 note_images
    end;
    select seq_scan + coalesce(idx_scan, 0) into s1 from pg_catalog.pg_stat_xact_user_tables where relid = 'public.notes'::regclass;
    if r = -1 and s1 = s0 + 1 then
      return 'mid';
    end if;
    seen := seen || b || ':' || coalesce(r::text, 'read_all') || '/' || (s1 - s0) || ' ';
  end loop;
  return seen;
end $f$;
select is((select pg_temp.mid_notes_exit(c) from cu), 'mid',
  '胖行：有一个预算让 notes 扫到一半、满 16 MB 那一次比时钟回 -1（不是表开头那一次，也没读完）');
alter table public.note_images_b10 rename to note_images;
select ok(tests.try_as('service_role', null, $$select private.export_size_over(a, 'plain', 1, 15000) from ids$$) like '22023%'
  and tests.try_as('service_role', null, $$select private.export_size_over(a, 'omitted', null, 15000) from ids$$) like '22023%'
  and tests.try_as('service_role', null, $$select private.export_size_over(a, 'omitted', 1, -1) from ids$$) like '22023%'
  and tests.try_as('service_role', null, $$select private.export_size_over(null, 'omitted', 1, 15000)$$) like '22023%',
  '模式不认识、上限为空、预算为负、用户为空：bad_export_size_args');
select is((select pronargs::int from pg_proc where oid = 'private.export_size_over(uuid, text, bigint, int)'::regprocedure), 4,
  '签名是 (用户, 模式, 上限, 预算)：不收表名参数（Q3）');

select * from finish();
rollback;
