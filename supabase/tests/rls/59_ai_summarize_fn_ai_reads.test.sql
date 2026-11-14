-- 迁移 20261115050000_ai_summarize_fn_ai_reads.sql：fn_ai 补读 events (date, time, tz, undone)、todos (due, due_time, done, undone)、notes (created_at, undone)
-- 覆盖：
--   ① 授权形状：这几列能读；三张表照旧没有表级 select；别的列（例如 events.raw_text、todos.raw_text、notes.raw_text）照旧读不到；
--   ② ai-summarize 的三句查询（supabase/functions/ai-summarize/store.ts）以 fn_ai 跑得通：本人没删、没撤销的读得到，删了的、撤销的读不到；
--      隐私记那一行照样读得到 is_private（函数据此整次拒绝 mixed_scope）；
--   ③ RLS 照旧：A 的事务里读不到 B 的行。
-- 用户：A、B（tests.seed）
begin;
select plan(10);
\ir _helpers.psql
select tests.seed();

insert into public.events (id, user_id, title, date, time, tz, location, note, deleted_at, undone, created_at, updated_at) values
  ('58000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', '开会', '2026-11-02', '15:00', 'Asia/Seoul', '三楼', '带电脑', null, false, 1, 1),
  ('58000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', '删了的', '2026-11-02', null, null, '', '', 5, false, 1, 1),
  ('58000000-0000-4000-8000-0000000000a3', 'aaaaaaaa-0000-4000-8000-000000000001', '撤销的', '2026-11-02', null, null, '', '', null, true, 1, 1),
  ('58000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'B 的会', '2026-11-02', null, null, '', '', null, false, 1, 1);
insert into public.todos (id, user_id, title, due, due_time, done, note, created_at, updated_at) values
  ('58000000-0000-4000-8000-0000000000a4', 'aaaaaaaa-0000-4000-8000-000000000001', '交报价单', '2026-11-03', '17:00', true, '给 NEOX', 1, 1);
insert into public.notes (id, user_id, title, body, created_at, updated_at) values
  ('58000000-0000-4000-8000-0000000000a5', 'aaaaaaaa-0000-4000-8000-000000000001', '想法', '正文', 1730000000000, 1);
insert into public.notes (id, user_id, is_private, body_enc, enc_key_id, created_at, updated_at) values
  ('58000000-0000-4000-8000-0000000000a6', 'aaaaaaaa-0000-4000-8000-000000000001', true, '\x01'::bytea, 1, 1, 1);

-- ===== ① 授权形状 =====
select ok(has_column_privilege('fn_ai', 'public.events', 'date', 'SELECT') and has_column_privilege('fn_ai', 'public.events', 'time', 'SELECT')
          and has_column_privilege('fn_ai', 'public.events', 'tz', 'SELECT') and has_column_privilege('fn_ai', 'public.events', 'undone', 'SELECT'), 'fn_ai 能读 events.date、time、tz、undone');
select ok(has_column_privilege('fn_ai', 'public.todos', 'due', 'SELECT') and has_column_privilege('fn_ai', 'public.todos', 'due_time', 'SELECT')
          and has_column_privilege('fn_ai', 'public.todos', 'done', 'SELECT') and has_column_privilege('fn_ai', 'public.todos', 'undone', 'SELECT'),
  'fn_ai 能读 todos.due、due_time、done、undone');
select ok(has_column_privilege('fn_ai', 'public.notes', 'created_at', 'SELECT') and has_column_privilege('fn_ai', 'public.notes', 'undone', 'SELECT'),
  'fn_ai 能读 notes.created_at、undone');
select ok(not has_table_privilege('fn_ai', 'public.events', 'SELECT') and not has_table_privilege('fn_ai', 'public.todos', 'SELECT')
          and not has_table_privilege('fn_ai', 'public.notes', 'SELECT'), '三张表照旧没有表级 select');
select ok(not has_column_privilege('fn_ai', 'public.events', 'raw_text', 'SELECT') and not has_column_privilege('fn_ai', 'public.todos', 'raw_text', 'SELECT')
          and not has_column_privilege('fn_ai', 'public.notes', 'raw_text', 'SELECT'), '原话 raw_text 照旧读不到');

-- ===== ② store.ts 的三句 =====
select is(tests.rows_as('fn_ai', null, $$select id, title, date::text as date, time, tz, location, note from public.events
    where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and id = any(array['58000000-0000-4000-8000-0000000000a1', '58000000-0000-4000-8000-0000000000a2',
      '58000000-0000-4000-8000-0000000000a3', '58000000-0000-4000-8000-0000000000b1']::uuid[]) and deleted_at is null and not undone$$,
  'aaaaaaaa-0000-4000-8000-000000000001'),
  '[{"id": "58000000-0000-4000-8000-0000000000a1", "date": "2026-11-02", "note": "带电脑", "time": "15:00", "title": "开会", "tz": "Asia/Seoul", "location": "三楼"}]'::jsonb,
  '日程：只读到本人没删、没撤销的那一条（B 的、删了的、撤销的都没有）');
select is(tests.rows_as('fn_ai', null, $$select id, title, due::text as due, due_time, done, note from public.todos
    where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and id = any(array['58000000-0000-4000-8000-0000000000a4']::uuid[]) and deleted_at is null and not undone$$,
  'aaaaaaaa-0000-4000-8000-000000000001'),
  '[{"id": "58000000-0000-4000-8000-0000000000a4", "due": "2026-11-03", "done": true, "note": "给 NEOX", "title": "交报价单", "due_time": "17:00"}]'::jsonb,
  '待办：读得到截止日子、时刻、做没做完');
select is(tests.rows_as('fn_ai', null, $$select id, title, body, is_private, created_at from public.notes
    where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and id = any(array['58000000-0000-4000-8000-0000000000a5', '58000000-0000-4000-8000-0000000000a6']::uuid[])
      and deleted_at is null and not undone order by id$$,
  'aaaaaaaa-0000-4000-8000-000000000001'),
  '[{"id": "58000000-0000-4000-8000-0000000000a5", "body": "正文", "title": "想法", "created_at": 1730000000000, "is_private": false},
    {"id": "58000000-0000-4000-8000-0000000000a6", "body": null, "title": null, "created_at": 1, "is_private": true}]'::jsonb,
  '随手记：读得到写下的时间；隐私记那一行读得到 is_private（标题正文为空）');

-- ===== ③ RLS 照旧 =====
select is(tests.rows_as('fn_ai', null, $$select id from public.events where id = '58000000-0000-4000-8000-0000000000b1'$$,
  'aaaaaaaa-0000-4000-8000-000000000001'), '[]'::jsonb, 'A 的事务里读不到 B 的日程');
select is(tests.rows_as('fn_ai', null, $$select id from public.todos$$), '[]'::jsonb, '没设 app.uid 时一行都读不到');

select * from finish();
rollback;
