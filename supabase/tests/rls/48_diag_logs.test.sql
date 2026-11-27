-- 迁移 20261111200000_core_diag_logs.sql：诊断日志一键发送
-- 钉住：① 本人写、再发覆盖（客户端用的 insert … on conflict (user_id) do update）；② 别人读不到、改不了、冒名写不进；
-- ③ 停用账号写不进；④ anon 什么都不能做；⑤ 超长写不进；⑥ 7 天清理任务在、删的是 7 天前的。
-- 用户：A、B、停用的 C（tests.seed）
begin;
select plan(12);
\ir _helpers.psql
select tests.seed();

-- ① 本人写、再发覆盖
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.diag_logs (app_version, body, sent_at) values ('4.0.0-preview.1@abc', 'first', now())
  on conflict (user_id) do update set app_version = excluded.app_version, body = excluded.body, sent_at = excluded.sent_at$$),
  'ok', 'A 第一次发送');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.diag_logs (app_version, body, sent_at) values ('4.0.0-preview.2@def', 'second', now())
  on conflict (user_id) do update set app_version = excluded.app_version, body = excluded.body, sent_at = excluded.sent_at$$),
  'ok', 'A 再发一次（覆盖）');
select is((select body || '|' || app_version from public.diag_logs where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'second|4.0.0-preview.2@def', '覆盖后只有一行、是新的那份');
select is(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', 'select body from public.diag_logs'),
  '[{"body": "second"}]'::jsonb, 'A 读得到自己这一行');

-- ② 别人读不到、改不了、冒名写不进
select is(tests.rows_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', 'select count(*)::int as n from public.diag_logs'),
  '[{"n": 0}]'::jsonb, 'B 读不到 A 的');
select is(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$update public.diag_logs set body = 'x'$$)
  || '|' || (select body from public.diag_logs where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 'ok|second', 'B 改 A 的：一行都没改到');
select ok(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002',
  $$insert into public.diag_logs (user_id, body) values ('aaaaaaaa-0000-4000-8000-000000000001', 'fake')$$) like '42501%',
  'B 冒充 A 写：user_id 列没授 insert');

-- ③ 停用账号写不进
select ok(tests.try_as('authenticated', 'cccccccc-0000-4000-8000-000000000003',
  $$insert into public.diag_logs (body) values ('c')$$) like '42501%', '停用的 C 写不进（RLS）');

-- ④ anon
select ok(tests.try_as('anon', null, $$insert into public.diag_logs (body) values ('x')$$) like '42501%', 'anon 写不进');
select ok(tests.try_as('anon', null, $$select 1 from public.diag_logs$$) like '42501%', 'anon 读不了');

-- ⑤ 超长
select ok(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002',
  format('insert into public.diag_logs (body) values (%L)', repeat('x', 300001))) like '23514%', '超过 30 万字写不进');

-- ⑥ 7 天清理
select is((select count(*)::int from cron.job where jobname = 'diag-logs-expire'
  and command like 'set statement_timeout = ''4min''; delete from public.diag_logs where sent_at < now() - interval ''7 days''%'), 1, '清理任务在，删 7 天前的');

select * from finish();
rollback;
