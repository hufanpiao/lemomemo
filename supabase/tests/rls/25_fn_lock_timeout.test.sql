-- 迁移 20261031130000_core_fn_lock_timeout.sql：四个写计数、写账号状态的函数带函数级 lock_timeout = 5s（安全审查第 22 条建议 ②）；
-- 20261031140000_core_restore_lock_timeout.sql 再加 account_restore（LOCK-restore）。
-- 只查定义（pg_proc.proconfig）：PGlite 单连接造不出两个会话抢锁，55P03 的真库实测见迁移文件头；
-- 调用方遇到报错一律回 try_later 由 tests/functions/lock-timeout-callers.test.ts 证明。
begin;
select plan(4);

select is((select string_agg(p.proname || ':' || pg_catalog.array_to_string(p.proconfig, ';'), ',' order by p.proname)
             from pg_catalog.pg_proc p
            where p.pronamespace = 'private'::regnamespace
              and p.proname in ('take_rate', 'export_job_start', 'export_job_take', 'account_request_deletion', 'account_restore')),
  'account_request_deletion:search_path="";lock_timeout=5s,account_restore:search_path="";lock_timeout=5s,export_job_start:search_path="";lock_timeout=5s,'
  || 'export_job_take:search_path="";lock_timeout=5s,take_rate:search_path="";lock_timeout=5s',
  '五个函数的函数级设置是 search_path = '''' 加 lock_timeout = 5s，各只有一个签名');

select is((select string_agg(p.proname, ',' order by p.proname) from pg_catalog.pg_proc p
            where p.pronamespace = 'private'::regnamespace
              and exists (select 1 from pg_catalog.unnest(p.proconfig) c where c like 'statement_timeout=%')),
  null, 'private 里没有一个函数设了 statement_timeout（只管等锁，不管语句跑多久）');

-- 函数级设置只在函数里生效，调用完恢复调用方的值（不会把 5s 漏给同一连接后面的语句）
select is(private.take_rate('lock-test:00000000-0000-0000-0000-000000000000:20261031', 5, 60), true, '没有锁争用时 take_rate 照常放行');
select is(pg_catalog.current_setting('lock_timeout'), (select s.reset_val from pg_catalog.pg_settings s where s.name = 'lock_timeout'),
  '调用 take_rate 之后，本连接的 lock_timeout 还是原来的值');

select * from finish();
rollback;
