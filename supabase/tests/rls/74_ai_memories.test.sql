-- 迁移 20261123130000_ai_memories.sql：长期记忆表 private.ai_memories（R-495）
-- 覆盖：
--   ① 授权：anon、authenticated 一律没有；service_role 只读（账号导出用）；fn_ai 增删改查；
--   ② RLS：没设 app.uid 一行都没有；A 读不到、改不了、删不了 B 的；不能替 B 写；
--   ③ check：字数上限、来源只能是 chat；同一个人没删的 norm 不重复，删了的不占位；
--   ④ 账号注销级联删，别人的不动；⑤ 软删过期清理任务在。
-- 用户：A、B（tests.seed）
begin;
select plan(19);
\ir _helpers.psql
select tests.seed();

insert into private.ai_memories (id, user_id, text, norm, created_at, updated_at) values
  ('73000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', '对花生过敏', '对花生过敏', 1, 1),
  ('73000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', 'B 的记忆', 'b的记忆', 1, 1);

-- ===== ① 授权 =====
select ok(not has_table_privilege('anon', 'private.ai_memories', 'SELECT') and not has_table_privilege('anon', 'private.ai_memories', 'INSERT'), 'anon 没有权限');
select ok(not has_table_privilege('authenticated', 'private.ai_memories', 'SELECT') and not has_table_privilege('authenticated', 'private.ai_memories', 'DELETE'), 'authenticated 没有权限');
select ok(has_table_privilege('service_role', 'private.ai_memories', 'SELECT')
          and not has_table_privilege('service_role', 'private.ai_memories', 'INSERT')
          and not has_table_privilege('service_role', 'private.ai_memories', 'UPDATE')
          and not has_table_privilege('service_role', 'private.ai_memories', 'DELETE'), 'service_role 只读（账号导出用）');
select ok(has_table_privilege('fn_ai', 'private.ai_memories', 'SELECT') and has_table_privilege('fn_ai', 'private.ai_memories', 'INSERT')
          and has_table_privilege('fn_ai', 'private.ai_memories', 'UPDATE') and has_table_privilege('fn_ai', 'private.ai_memories', 'DELETE'), 'fn_ai 增删改查');
select ok(not has_table_privilege('fn_vault', 'private.ai_memories', 'SELECT'), 'fn_vault 读不到');

-- ===== ② RLS =====
select is(tests.rows_as('fn_ai', null, $$select id from private.ai_memories$$), '[]'::jsonb, '没设 app.uid 一行都没有');
select is(tests.rows_as('fn_ai', null, $$select id from private.ai_memories order by id$$, 'aaaaaaaa-0000-4000-8000-000000000001'),
  '[{"id": "73000000-0000-4000-8000-0000000000a1"}]'::jsonb, 'A 只读到自己的');
do $d$ begin
  perform tests.try_as('fn_ai', null, $$update private.ai_memories set text = 'x' where id = '73000000-0000-4000-8000-0000000000b1'$$, 'aaaaaaaa-0000-4000-8000-000000000001');
  perform tests.try_as('fn_ai', null, $$delete from private.ai_memories where id = '73000000-0000-4000-8000-0000000000b1'$$, 'aaaaaaaa-0000-4000-8000-000000000001');
end $d$;
select is((select text from private.ai_memories where id = '73000000-0000-4000-8000-0000000000b1'), 'B 的记忆', 'A 改不了 B 的');
select is((select count(*)::int from private.ai_memories where id = '73000000-0000-4000-8000-0000000000b1'), 1, 'A 删不了 B 的');
select ok(tests.try_as('fn_ai', null, $$insert into private.ai_memories (user_id, text, norm, created_at, updated_at) values ('bbbbbbbb-0000-4000-8000-000000000002', '代写', '代写', 1, 1)$$, 'aaaaaaaa-0000-4000-8000-000000000001') like '42501%', 'A 不能替 B 写');

-- ===== ③ check 和判重 =====
select ok(tests.try_as('fn_ai', null, $$insert into private.ai_memories (user_id, text, norm, created_at, updated_at) values ('aaaaaaaa-0000-4000-8000-000000000001', repeat('长', 201), 'x', 1, 1)$$, 'aaaaaaaa-0000-4000-8000-000000000001') like '23514%', '超过 200 字拦下');
select ok(tests.try_as('fn_ai', null, $$insert into private.ai_memories (user_id, text, norm, source, created_at, updated_at) values ('aaaaaaaa-0000-4000-8000-000000000001', '笔记', '笔记', 'note', 1, 1)$$, 'aaaaaaaa-0000-4000-8000-000000000001') like '23514%', '来源只能是 chat');
select ok(tests.try_as('fn_ai', null, $$insert into private.ai_memories (user_id, text, norm, created_at, updated_at) values ('aaaaaaaa-0000-4000-8000-000000000001', '对花生 过敏', '对花生过敏', 1, 1)$$, 'aaaaaaaa-0000-4000-8000-000000000001') like '23505%', '同一个人没删的不重复');
update private.ai_memories set deleted_at = 5 where id = '73000000-0000-4000-8000-0000000000a1';
select is(tests.try_as('fn_ai', null, $$insert into private.ai_memories (id, user_id, text, norm, created_at, updated_at) values ('73000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', '对花生过敏', '对花生过敏', 2, 2)$$, 'aaaaaaaa-0000-4000-8000-000000000001'), 'ok', '删了的不占位');

-- ===== 检索词条：列在、默认空、有上限；按词条查也只读到本人的 =====
select ok(tests.try_as('fn_ai', null, $$insert into private.ai_memories (user_id, text, norm, grams, created_at, updated_at) values ('aaaaaaaa-0000-4000-8000-000000000001', '词条超限', '词条超限', array(select 'g' || i from generate_series(1, 201) i), 1, 1)$$, 'aaaaaaaa-0000-4000-8000-000000000001') like '23514%', '词条最多 200 个');
update private.ai_memories set grams = '{花生}' where id = '73000000-0000-4000-8000-0000000000b1';
select is(tests.rows_as('fn_ai', null, $$select id from private.ai_memories where grams && array['花生']$$, 'aaaaaaaa-0000-4000-8000-000000000001'), '[]'::jsonb, 'A 按词条查不到 B 的');

-- ===== ④ 级联删 =====
delete from auth.users where id = 'bbbbbbbb-0000-4000-8000-000000000002';
select is((select count(*)::int from private.ai_memories where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'), 0, 'B 注销，B 的记忆跟着删');
select is((select count(*)::int from private.ai_memories where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 2, 'A 的不动');

-- ===== ⑤ 过期清理 =====
select is((select count(*)::int from cron.job where jobname = 'ai-memories-expire'
  and command like 'set statement_timeout = ''4min''; delete from private.ai_memories where deleted_at < %'), 1, '清理任务在，只删已软删的');

select * from finish();
rollback;
