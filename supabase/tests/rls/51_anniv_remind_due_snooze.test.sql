-- 迁移 20261114191000_anniv_remind_due_snooze.sql（B5 整块评审第 1 条）：纪念日推过以后 remind_at 已挪到下一次时，
-- private.remind_due 按推过以后的稍后（snooze_at > pushed_for，连同免打扰顺延落在窗口里）判到点；private.remind_pushed 不因 remind_at 挪了就收回。
-- 日程、待办两支的条件不变，由 31_remind_due.test.sql 照旧守着。函数一侧的对拍在 tests/edge/push-dispatch-anniv.test.ts。
-- 时间用小数字：窗口 (1000000, 2000000]；remind_at = 5000000 表示“已挪到下一次”。
begin;
select plan(4);
\ir _helpers.psql
select tests.seed();

insert into public.devices (id, user_id, platform, label, session_id, push_endpoint, p256dh, auth) values
  ('d5100000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'web', 'A', null, 'https://fcm.googleapis.com/fcm/send/a51',
   'BA' || repeat('B', 84) || 'A', repeat('A', 21) || 'g');

insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, created_at, updated_at, remind_at, pushed_for, snooze_at, defer_until, notified_for) values
  ('a5100000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', 'n', 'solar', 11, 20, 1, 1, 5000000, 1100000, 1500000, null, null),     -- 推过以后按了稍后：1500000 到点
  ('a5100000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', 'n', 'solar', 11, 20, 1, 1, 5000000, 1100000, null, null, null),        -- 推过、没处理：不到点、不收回
  ('a5100000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', 'n', 'solar', 11, 20, 1, 1, 5000000, 1100000, 3000000, null, null),     -- 稍后在窗口外：不到点；推过以后按了稍后：收回
  ('a5100000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', 'n', 'solar', 11, 20, 1, 1, 5000000, 1500000, 1500000, null, null),     -- 稍后那一次推过了：不到点、不收回
  ('a5100000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', 'n', 'solar', 11, 20, 1, 1, 5000000, 1100000, null, null, 1100000),     -- 按了“知道了”：收回
  ('a5100000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', 'n', 'solar', 11, 20, 1, 1, null, 1100000, null, null, null),           -- 提醒关了：收回
  ('a5100000-0000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', 'n', 'solar', 11, 20, 1, 1, 5000000, 1100000, 1400000, 1600000, null),  -- 稍后被免打扰顺延：1600000 到点
  ('a5100000-0000-4000-8000-000000000008', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', 'n', 'solar', 11, 20, 1, 1, 5000000, 1100000, 500000, null, null);       -- 稍后早于推送（旧值）：不到点、不收回

select is((select string_agg(id::text || '@' || due_at, ',' order by due_at, id) from private.remind_due(1000000, 2000000, 20, 500) where table_name = 'anniversaries'),
  'a5100000-0000-4000-8000-000000000001@1500000,a5100000-0000-4000-8000-000000000007@1600000',
  'remind_due：推过以后的稍后按 greatest(snooze_at, defer_until) 判到点，不被挪过的 remind_at 吞掉');
select is((select string_agg(id::text, ',' order by id) from private.remind_pushed(1000000, 2000000, 20, 500) where table_name = 'anniversaries'),
  'a5100000-0000-4000-8000-000000000003,a5100000-0000-4000-8000-000000000005,a5100000-0000-4000-8000-000000000006',
  'remind_pushed：纪念日只在按了稍后、知道了、关了提醒时收回；remind_at 挪到下一次不算');
select ok(has_function_privilege('service_role', 'private.remind_due(bigint, bigint, int, int)', 'EXECUTE')
      and has_function_privilege('service_role', 'private.remind_pushed(bigint, bigint, int, int)', 'EXECUTE')
      and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
         where p.oid in ('private.remind_due(bigint, bigint, int, int)'::regprocedure, 'private.remind_pushed(bigint, bigint, int, int)'::regprocedure)
           and a.grantee = 0 and a.privilege_type = 'EXECUTE'), 'create or replace 后：service_role 照旧能执行、PUBLIC 照旧没有');
select is((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""', 'lock_timeout=5s'] and cardinality(p.proconfig) = 2)
   from pg_proc p where p.oid in ('private.remind_due(bigint, bigint, int, int)'::regprocedure, 'private.remind_pushed(bigint, bigint, int, int)'::regprocedure)),
  true, '两个函数：security definer、search_path 置空、lock_timeout=5s');

select * from finish();
rollback;
