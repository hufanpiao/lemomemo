-- R-434 待办优先级（迁移 20261115100000_todos_priority.sql）：
-- ① A 以 authenticated 身份新建不带 priority 的待办：默认 mid；带 low、high 通过；带不认识的值（urgent）被 todos_priority_in 拒；
-- ② 列级授权：update priority 通过；旧列 important 照样能写（旧版客户端，TC-B0-57 不改名不删列）；
-- ③ apply_patch 的 todos 白名单认 priority：改成 high 以后行里是 high、fv.priority 记了新 rev；
-- ④ intake_insert 的 allowed.todos 认 priority（claude-intake 经 captureRow 整行写）；
-- ⑤ 约束已 validate（不是 not valid 状态）。
begin;
select plan(9);
\ir _helpers.psql
select tests.seed();

create function tests.ins(p jsonb) returns text language plpgsql as $$
declare
  row jsonb := jsonb_build_object('id', gen_random_uuid(), 'title', 't', 'created_at', 0, 'updated_at', 0) || p;
  cols text := (select string_agg(quote_ident(k), ',') from jsonb_object_keys(row) k);
begin
  return tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
    format('insert into public.todos (%s) select %s from jsonb_populate_record(null::public.todos, %L::jsonb)', cols, cols, row));
end $$;
create function tests.ap(p_id uuid, p_patch jsonb, p_base int) returns jsonb language sql as $$
  with x as (select tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
    format('select public.apply_patch(%L, %L::uuid, %L::jsonb, %s, %L::uuid) as r', 'todos', p_id, p_patch, p_base, gen_random_uuid())) j)
  select coalesce(j -> 0 -> 'r', j) from x
$$;

-- ① 默认值、取值约束
select is(tests.ins('{"id": "70000000-0000-4000-8000-0000000000a1"}'), 'ok', '① 不带 priority 新建通过');
select is((select priority from public.todos where id = '70000000-0000-4000-8000-0000000000a1'), 'mid', '① 不带 priority 默认 mid');
select is(tests.ins('{"priority": "low"}') || ',' || tests.ins('{"priority": "high", "important": true}'), 'ok,ok', '① 带 low、high 通过');
select ok(tests.ins('{"priority": "urgent"}') like '23514%todos_priority_in%', '① 不认识的值 urgent 被 todos_priority_in 拒');

-- ② 列级授权：priority 能改，旧列 important 照样能写
select is(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$update public.todos set priority = 'low', important = false, updated_at = 1 where id = '70000000-0000-4000-8000-0000000000a1'$$), 'ok',
  '② authenticated 能 update priority 和旧列 important');

-- ③ apply_patch 认 priority
select is(tests.ap('70000000-0000-4000-8000-0000000000a1', '{"priority": "high", "important": true, "updated_at": 2}',
  (select rev from public.todos where id = '70000000-0000-4000-8000-0000000000a1')) ->> 'status', 'ok', '③ apply_patch 改 priority：ok');
select is((select priority || ':' || important::text || ':' || (fv ->> 'priority' = rev::text)::text from public.todos where id = '70000000-0000-4000-8000-0000000000a1'),
  'high:true:true', '③ 行里是 high、important 双写 true、fv.priority 记了这一版');

-- ④ intake_insert 认 priority
do $$ begin perform private.intake_insert('aaaaaaaa-0000-4000-8000-000000000001', jsonb_build_object('todos', jsonb_build_array(jsonb_build_object(
  'id', '70000000-0000-4000-8000-0000000000a2', 'title', '经连接码', 'due', null, 'important', true, 'priority', 'high', 'project', '', 'note', '',
  'source', 'chat', 'raw_text', '原话', 'batch_id', null, 'short', null, 'short_by', null, 'remind_days', null, 'remind_time', '09:00',
  'due_time', null, 'remind_before_min', null, 'created_at', 1, 'updated_at', 1)))); end $$;
select is((select priority from public.todos where id = '70000000-0000-4000-8000-0000000000a2'), 'high', '④ intake_insert 写进去的 priority 是 high');

-- ⑤ 约束已 validate
select is((select convalidated from pg_constraint where conname = 'todos_priority_in' and conrelid = 'public.todos'::regclass), true, '⑤ todos_priority_in 已 validate');

select * from finish();
rollback;
