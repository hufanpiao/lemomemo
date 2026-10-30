-- B1 迁移 20261031100000_core_export_jobs.sql 四个函数的属性（pg_proc 断言）：TC-B1-131 ②、TC-B1-143 ②（B1 QA 报告 6.2 节的缺口）。
-- 21_export_jobs.test.sql 测行为；这里只查定义：security invoker、search_path = ''、没有 statement_timeout、语言、签名和返回类型、
-- 执行权（anon、authenticated 没有，service_role 有，不给 PUBLIC）、export_size_over 的动态 SQL 只经 format('… public.%I …') 拼表名。
-- grant 行和 3.3 C、附录 A 授权汇总的逐行比对由 check_backend.py M4 做，不在这里重复。
begin;
select plan(14);

create temp view f as
  select p.oid, p.proname, p.prosecdef, p.proconfig, l.lanname, p.prosrc, p.proacl,
         pg_catalog.pg_get_function_arguments(p.oid) as args, pg_catalog.pg_get_function_result(p.oid) as result
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
   where p.pronamespace = 'private'::regnamespace
     and p.proname in ('export_job_start', 'export_job_take', 'db_size_bytes', 'export_size_over');

-- ① 每个函数只有一个签名，参数和返回类型和架构写的一样
select is((select count(*)::int from f), 4, '四个函数各只有一个重载');
select is((select string_agg(proname || '(' || args || ') -> ' || result, ' | ' order by proname) from f),
  'db_size_bytes() -> TABLE(bytes bigint, at timestamp with time zone)'
  || ' | export_job_start(p_user uuid, p_export_id uuid, p_mode text, p_session uuid) -> timestamp with time zone'
  || ' | export_job_take(p_user uuid, p_export_id uuid, p_mode text, p_session uuid, p_max integer, p_ttl_s integer) -> TABLE(verdict text, started_at timestamp with time zone, parts integer)'
  || ' | export_size_over(p_user uuid, p_mode text, p_limit bigint, p_budget_ms integer) -> bigint',
  '签名和返回类型：export_size_over 是 (p_user, p_mode, p_limit, p_budget_ms) returns bigint，没有 p_tables');

-- ② security invoker、search_path = ''、没有别的函数级设置（含 statement_timeout）
select is((select string_agg(proname, ',' order by proname) from f where prosecdef), null, '四个函数都是 security invoker（没有一个 definer）');
select is((select string_agg(proname || ':' || coalesce(pg_catalog.array_to_string(proconfig, ';'), '-'), ',' order by proname) from f),
  'db_size_bytes:search_path="",export_job_start:search_path="",export_job_take:search_path="",export_size_over:search_path=""',
  '四个函数的函数级设置只有 search_path = ''''（没有 set statement_timeout）');
select is((select string_agg(proname, ',' order by proname) from f where prosrc ~* 'statement_timeout'), null,
  '函数体里也没有 statement_timeout（Q2：超时靠 p_budget_ms 比 clock_timestamp）');

-- ③ 语言
select is((select string_agg(proname || ':' || lanname, ',' order by proname) from f),
  'db_size_bytes:sql,export_job_start:plpgsql,export_job_take:plpgsql,export_size_over:plpgsql',
  '语言：export_size_over、export_job_start、export_job_take 是 plpgsql，db_size_bytes 是 sql');

-- ④ 执行权：只给 service_role
select is((select string_agg(proname, ',' order by proname) from f where pg_catalog.has_function_privilege('anon', oid, 'EXECUTE')), null,
  'anon 不能执行这四个函数');
select is((select string_agg(proname, ',' order by proname) from f where pg_catalog.has_function_privilege('authenticated', oid, 'EXECUTE')), null,
  'authenticated 不能执行这四个函数');
select is((select string_agg(proname, ',' order by proname) from f where pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE')),
  'db_size_bytes,export_job_start,export_job_take,export_size_over', 'service_role 四个都能执行');
select is((select string_agg(proname, ',' order by proname) from f
            where proacl is null or exists (select 1 from pg_catalog.aclexplode(proacl) a where a.grantee = 0)), null,
  '没有一个给 PUBLIC 执行权（proacl 不为空、里面没有 PUBLIC）');

-- ⑤ 动态 SQL：只有 export_size_over 有 execute，只有一处，表名经 format 的 %I 进来、user_id 用 using 传参
select is((select string_agg(proname || ':' || (select count(*) from pg_catalog.regexp_matches(prosrc, '\mexecute\M', 'gi')), ',' order by proname) from f),
  'db_size_bytes:0,export_job_start:0,export_job_take:0,export_size_over:1', '动态 SQL 只在 export_size_over 里出现一次');
select ok((select prosrc ~ 'for b in execute pg_catalog\.format\(\s*''select pg_catalog\.octet_length\(pg_catalog\.row_to_json\(x\.\*\)::text\)::bigint from public\.%I x where x\.user_id = \$1%s'', tn, cond\)\s*using p_user loop'
  from f where proname = 'export_size_over'),
  'execute 的语句是 format(''… from public.%I x where x.user_id = $1%s'', tn, cond) using p_user：表名用 %I，user_id 用 $1 传参');
select ok((select prosrc !~ 'execute\s+[^p]' and prosrc !~ 'execute\s+pg_catalog\.format\([^)]*\|\|' from f where proname = 'export_size_over'),
  'execute 后面直接就是 pg_catalog.format(，format 的参数里没有 || 字符串拼接');
-- %s 只填 cond，cond 只从 case 里的几个写死的串取（不来自参数）
select ok((select prosrc ~ 'cond := case when p_mode = ''cipher'' then ''''\s+when tn = ''notes'' then '' and x\.is_private is not true''\s+when tn = ''note_images'' then '' and x\.bucket is distinct from ''''vault-images''''''\s+when tn = ''note_files'' then '' and x\.is_vault is not true''\s+else '''' end;'
             and (select count(*) from pg_catalog.regexp_matches(prosrc, '\mcond\s*:=', 'g')) = 1
  from f where proname = 'export_size_over'),
  '%s 填的 cond 只在一处赋值，取值都是写死的串（隐私记过滤条件），不拼参数');

select * from finish();
rollback;
