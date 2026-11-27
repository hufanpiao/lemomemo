-- R-429 拖动排序（迁移 20261116090000_sort_key.sql）：
-- ① 列级授权：authenticated 新建时不能带 sort_key（只能 update，清单 updateOnly）；update todos、notes 的 sort_key 通过；
-- ② 格式约束：末位是 0、带字母、超过 128 位被 todos_sort_key_fmt / notes_sort_key_fmt 拒；
-- ③ apply_patch 的 todos、notes 白名单认 sort_key：改完行里是新值、fv.sort_key 记了这一版；
-- ④ 隐私记行的明文列 sort_key 必须为空（notes_sort_key_private）：fn_vault 移进隐私记时带着排序值被拒，清空了才通过；
-- ⑤ 约束都已 validate。
begin;
select plan(12);
\ir _helpers.psql
select tests.seed();

create function tests.ap(p_table text, p_id uuid, p_patch jsonb) returns jsonb language plpgsql as $$
declare
  base int;
  j jsonb;
begin
  execute format('select rev from public.%I where id = %L', p_table, p_id) into base;
  j := tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
    format('select public.apply_patch(%L, %L::uuid, %L::jsonb, %s, %L::uuid) as r', p_table, p_id, p_patch, base, gen_random_uuid()));
  return coalesce(j -> 0 -> 'r', j);
end $$;

insert into public.todos (id, user_id, title, created_at, updated_at) values ('71000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1);
insert into public.notes (id, user_id, body, created_at, updated_at) values ('71000000-0000-4000-8000-0000000000b1', 'aaaaaaaa-0000-4000-8000-000000000001', 'n', 1, 1);

-- ① 列级授权
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.todos (id, title, sort_key, created_at, updated_at) values (gen_random_uuid(), 'x', '17', 1, 1)$$) like '42501%',
  '① authenticated 新建待办不能带 sort_key');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.notes (id, body, sort_key, created_at, updated_at) values (gen_random_uuid(), 'x', '17', 1, 1)$$) like '42501%',
  '① authenticated 新建随手记不能带 sort_key');
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  update public.todos set sort_key = '1735', updated_at = 2 where id = '71000000-0000-4000-8000-0000000000a1'$$)
  || ',' || tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  update public.notes set sort_key = '1735' where id = '71000000-0000-4000-8000-0000000000b1'$$), 'ok,ok',
  '① authenticated 能 update todos、notes 的 sort_key');

-- ② 格式约束
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  update public.todos set sort_key = '170' where id = '71000000-0000-4000-8000-0000000000a1'$$) like '23514%todos_sort_key_fmt%', '② 末位是 0 被拒');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  update public.notes set sort_key = '1a' where id = '71000000-0000-4000-8000-0000000000b1'$$) like '23514%notes_sort_key_fmt%', '② 带字母被拒');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', format(
  $$update public.todos set sort_key = %L where id = '71000000-0000-4000-8000-0000000000a1'$$, repeat('1', 129))) like '23514%todos_sort_key_fmt%', '② 超过 128 位被拒');

-- ③ apply_patch 认 sort_key
select is(tests.ap('todos', '71000000-0000-4000-8000-0000000000a1', '{"sort_key": "15", "updated_at": 3}') ->> 'status', 'ok', '③ apply_patch 改 todos.sort_key：ok');
select is((select sort_key || ':' || (fv ->> 'sort_key' = rev::text)::text from public.todos where id = '71000000-0000-4000-8000-0000000000a1'),
  '15:true', '③ todos 行里是新值、fv.sort_key 记了这一版');
select is(tests.ap('notes', '71000000-0000-4000-8000-0000000000b1', '{"sort_key": "16", "updated_at": 3}') ->> 'status', 'ok', '③ apply_patch 改 notes.sort_key：ok');
select is((select sort_key from public.notes where id = '71000000-0000-4000-8000-0000000000b1'), '16', '③ notes 行里是新值');

-- ④ 隐私记行不能留明文的排序值
select ok(tests.try_as('fn_vault', null, $$
  update public.notes set title = null, body = null, is_private = true, body_enc = '\x01', enc_key_id = 1 where id = '71000000-0000-4000-8000-0000000000b1'$$,
  'aaaaaaaa-0000-4000-8000-000000000001') like '23514%notes_sort_key_private%', '④ 移进隐私记时明文列还带着 sort_key 被拒');

-- ⑤ 约束已 validate
select is((select count(*)::int from pg_constraint where conname in ('todos_sort_key_fmt', 'notes_sort_key_fmt', 'notes_sort_key_private') and convalidated), 3,
  '⑤ 三个约束都已 validate');

select * from finish();
rollback;
