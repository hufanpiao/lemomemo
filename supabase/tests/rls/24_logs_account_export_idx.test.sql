-- B1 迁移 20261031120000_core_logs_account_export_idx.sql：account 查自己写的 logs 用的索引 (user_id, act, src, code)（架构 0.47 第 22 条 T2）。
-- 函数那一半（没有发起记录回 410、不读数据）在 tests/functions/account-export-timeout.test.ts；D1 的存在和定义核对在 build/d1/required-indexes.ts。
begin;
select plan(6);
\ir _helpers.psql
select tests.seed();

-- ① 索引在、定义一字不差（普通索引四列；部分索引在参数化的通用计划下用不上，见迁移文件头）
select is((select indexdef from pg_indexes where schemaname = 'public' and indexname = 'logs_account_export_idx'),
  'CREATE INDEX logs_account_export_idx ON public.logs USING btree (user_id, act, src, code)',
  'logs_account_export_idx 的定义：(user_id, act, src, code) 普通 B 树');

-- ② account 那条查询（index.ts 的 exportStarted：四个条件）按 PostgREST 的样子参数化、强制通用计划，也能走这个索引
create temp table plan_out(line text);
set local enable_seqscan = off;   -- 空表上默认会选顺序扫描，这里只证明“能用上”
set local plan_cache_mode = force_generic_plan;
prepare started_q(uuid, text, text, text) as
  select id from public.logs where user_id = $1 and act = $2 and src = $3 and code = $4 limit 1;
do $$
declare r record;
begin
  for r in execute $q$explain execute started_q('aaaaaaaa-0000-4000-8000-000000000001', 'export', 'account', 'eeeeeeee-0000-4000-8000-0000000000e1')$q$
  loop insert into plan_out values (r."QUERY PLAN"); end loop;
end $$;
deallocate started_q;
reset plan_cache_mode;
reset enable_seqscan;
select ok(exists (select 1 from plan_out where line like '%logs_account_export_idx%'), 'exportStarted 的查询（参数化、通用计划）能走 logs_account_export_idx');

-- ③ 查询语义：只认本人、src = account、act = export、code 对上的那一行
insert into public.logs (user_id, t, kind, act, src, code) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 1, 'run', 'export', 'account', 'eeeeeeee-0000-4000-8000-0000000000e1'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 2, 'run', 'export', 'app', 'eeeeeeee-0000-4000-8000-0000000000e2'),       -- 客户端自己记的同名 act
  ('aaaaaaaa-0000-4000-8000-000000000001', 3, 'run', 'export_done', 'account', 'eeeeeeee-0000-4000-8000-0000000000e3'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 4, 'run', 'export', 'account', 'eeeeeeee-0000-4000-8000-0000000000e4');   -- 别人的
create function pg_temp.started(u uuid, c text) returns boolean language sql as $$
  select exists (select 1 from public.logs where user_id = u and act = 'export' and src = 'account' and code = c)
$$;
select ok(pg_temp.started('aaaaaaaa-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-0000000000e1'), '本人 account 写的 export 记录：查得到');
select ok(not pg_temp.started('aaaaaaaa-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-0000000000e2'), 'src 不是 account（客户端记的）：不算');
select ok(not pg_temp.started('aaaaaaaa-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-0000000000e3'), 'act 是 export_done：不算');
select ok(not pg_temp.started('aaaaaaaa-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-0000000000e4'), '别人的 export 记录：不算');

select * from finish();
rollback;
