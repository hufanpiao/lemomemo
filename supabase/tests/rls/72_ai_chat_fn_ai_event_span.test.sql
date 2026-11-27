-- 迁移 20261123100000_ai_chat_fn_ai_event_span.sql：fn_ai 读 events.duration_min（R-492 ai-chat 查跨天日程，负责人 11-23 弹窗）
-- 这里只测授权形状和 RLS；store.ts 的 EVENTS_SQL 以 fn_ai 跑的结果在 tests/data-manifest/ai-chat-store.test.ts（直接 import 那句 SQL）。
-- 覆盖：
--   ① fn_ai 能读 duration_min；events 仍没有表级 select，项目名、提醒照旧读不到，不能写；
--   ② RLS：没设 app.uid 一行都读不到，A 的事务里读不到 B 的日程的时长。
-- 用户：A、B（tests.seed）
begin;
select plan(5);
\ir _helpers.psql
select tests.seed();

insert into public.events (id, user_id, title, date, time, tz, duration_min, created_at, updated_at) values
  ('72000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', '跨夜航班', '2026-11-22', '22:00', 'Asia/Seoul', 300, 1, 1),
  ('72000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'B 的航班', '2026-11-22', '22:00', 'Asia/Seoul', 300, 1, 1);

-- ===== ① 授权形状 =====
select ok(has_column_privilege('fn_ai', 'public.events', 'duration_min', 'SELECT'), 'fn_ai 能读 events.duration_min');
select ok(not has_table_privilege('fn_ai', 'public.events', 'SELECT'), 'events 仍没有表级 select');
select ok(not has_column_privilege('fn_ai', 'public.events', 'project', 'SELECT') and not has_column_privilege('fn_ai', 'public.events', 'remind_at', 'SELECT'),
  '项目名、提醒照旧读不到');
select ok(not has_table_privilege('fn_ai', 'public.events', 'INSERT') and not has_table_privilege('fn_ai', 'public.events', 'UPDATE')
          and not has_column_privilege('fn_ai', 'public.events', 'duration_min', 'UPDATE'), 'fn_ai 不能写日程、不能改时长');

-- ===== ② RLS =====
select is(tests.rows_as('fn_ai', null, $$select id, duration_min from public.events where duration_min = 300 order by id$$, 'aaaaaaaa-0000-4000-8000-000000000001'),
  '[{"id": "72000000-0000-4000-8000-0000000000a1", "duration_min": 300}]'::jsonb, 'A 的事务里只读到 A 的日程时长，B 的不出');

select * from finish();
rollback;
