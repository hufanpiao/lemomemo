-- 迁移 20261122090000_ai_chat_fn_ai_anniv.sql：fn_ai 读纪念日（列级 select + fn_own 策略）、随手记只读视图 private.ai_chat_notes（R-492）
-- 这里只测授权形状和 RLS、视图本身挡住了什么；store.ts 的四句真 SQL 以 fn_ai 跑的结果在 tests/data-manifest/ai-chat-store.test.ts
--   （直接 import store.ts 导出的 SQL 常量，不手抄）。
-- 覆盖：
--   ① 纪念日授权形状：store 用到的列能读；没有表级 select；头像、提醒、农历变体、闰月、年份读不到；不能写；
--   ② 日程的项目名 fn_ai 读不到（依据行的项目色前端从本机库查）；
--   ③ 视图：fn_ai 只能 select，authenticated、anon 读不到；视图里没有 is_private 这一列；
--   ④ 视图内容：A 的普通随手记出，隐私记不出，B 的不出，没设 app.uid 一行都没有；
--   ⑤ 纪念日 RLS：没设 app.uid 一行都读不到，A 的事务里读不到 B 的纪念日。
-- 用户：A、B（tests.seed）
begin;
select plan(12);
\ir _helpers.psql
select tests.seed();

insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, next_date, note, created_at, updated_at) values
  ('70000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', '妈妈生日', 'solar', 12, 1, '2026-12-01', '买蛋糕', 1, 1),
  ('70000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'birthday', 'B 的生日', 'solar', 12, 1, '2026-12-01', '', 1, 1);
insert into public.notes (id, user_id, title, body, created_at, updated_at) values
  ('70000000-0000-4000-8000-0000000000a5', 'aaaaaaaa-0000-4000-8000-000000000001', '拉面店', '弘大那家一兰拉面不错', 1763600000000, 1),
  ('70000000-0000-4000-8000-0000000000b5', 'bbbbbbbb-0000-4000-8000-000000000002', 'B 的拉面', '', 1763600000000, 1);
insert into public.notes (id, user_id, is_private, body_enc, enc_key_id, created_at, updated_at) values
  ('70000000-0000-4000-8000-0000000000a6', 'aaaaaaaa-0000-4000-8000-000000000001', true, '\x01'::bytea, 1, 1, 1);

-- ===== ① 纪念日授权形状 =====
select ok(has_column_privilege('fn_ai', 'public.anniversaries', 'name', 'SELECT') and has_column_privilege('fn_ai', 'public.anniversaries', 'next_date', 'SELECT')
          and has_column_privilege('fn_ai', 'public.anniversaries', 'month', 'SELECT') and has_column_privilege('fn_ai', 'public.anniversaries', 'archived_at', 'SELECT'),
  'fn_ai 能读 anniversaries 的 name、next_date、month、archived_at 等列');
select ok(not has_table_privilege('fn_ai', 'public.anniversaries', 'SELECT'), 'anniversaries 没有表级 select');
select ok(not has_column_privilege('fn_ai', 'public.anniversaries', 'avatar_id', 'SELECT') and not has_column_privilege('fn_ai', 'public.anniversaries', 'remind_at', 'SELECT')
          and not has_column_privilege('fn_ai', 'public.anniversaries', 'lunar_variant', 'SELECT') and not has_column_privilege('fn_ai', 'public.anniversaries', 'is_leap', 'SELECT')
          and not has_column_privilege('fn_ai', 'public.anniversaries', 'year', 'SELECT'),
  '头像、提醒、农历变体、闰月、年份读不到');
select ok(not has_table_privilege('fn_ai', 'public.anniversaries', 'INSERT') and not has_table_privilege('fn_ai', 'public.anniversaries', 'UPDATE')
          and not has_table_privilege('fn_ai', 'public.anniversaries', 'DELETE'), 'fn_ai 不能写纪念日');

-- ===== ② 日程项目名 =====
select ok(not has_column_privilege('fn_ai', 'public.events', 'project', 'SELECT'), 'fn_ai 读不到 events.project');

-- ===== ③ 视图授权 =====
select ok(has_table_privilege('fn_ai', 'private.ai_chat_notes', 'SELECT') and not has_table_privilege('fn_ai', 'private.ai_chat_notes', 'INSERT')
          and not has_table_privilege('fn_ai', 'private.ai_chat_notes', 'UPDATE') and not has_table_privilege('fn_ai', 'private.ai_chat_notes', 'DELETE'),
  'fn_ai 对 ai_chat_notes 只有 select');
select ok(not has_table_privilege('authenticated', 'private.ai_chat_notes', 'SELECT') and not has_table_privilege('anon', 'private.ai_chat_notes', 'SELECT'),
  'authenticated、anon 读不到 ai_chat_notes');
select is((select array_agg(column_name::text order by column_name) from information_schema.columns where table_schema = 'private' and table_name = 'ai_chat_notes'),
  array['body', 'created_at', 'id', 'title', 'user_id'], '视图只有 id、user_id、title、body、created_at 五列（没有 is_private、密文）');

-- ===== ④ 视图内容 =====
select is(tests.rows_as('fn_ai', null, $$select id from private.ai_chat_notes order by id$$, 'aaaaaaaa-0000-4000-8000-000000000001'),
  '[{"id": "70000000-0000-4000-8000-0000000000a5"}]'::jsonb, 'A 的事务里只有 A 的普通随手记：隐私记、B 的都不出');
select is(tests.rows_as('fn_ai', null, $$select id from private.ai_chat_notes$$), '[]'::jsonb, '没设 app.uid 时视图一行都没有');

-- ===== ⑤ 纪念日 RLS =====
select is(tests.rows_as('fn_ai', null, $$select id from public.anniversaries$$), '[]'::jsonb, '没设 app.uid 时一行纪念日都读不到');
select is(tests.rows_as('fn_ai', null, $$select id from public.anniversaries where id = '70000000-0000-4000-8000-0000000000b1'$$,
  'aaaaaaaa-0000-4000-8000-000000000001'), '[]'::jsonb, 'A 的事务里读不到 B 的纪念日');

select * from finish();
rollback;
