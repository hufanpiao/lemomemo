-- B2 迁移 20261103130000_core_remind_queue_pop.sql：push-dispatch 第 0 步的出队函数（B2 任务单 BE-2 第 0 步、K3-remind-orphan、
-- TC-DEL-remind_queue；架构 5.3 第 0 步、0.42 第 1 条）。函数一侧的重算、写回、插回在 tests/edge/push-dispatch-step0.test.ts。
-- 用户：seed 的 A、B 可用，C 是管理员停用；这里另加一个冷静期的 D（disabled_reason = deletion）。
begin;
select plan(21);
\ir _helpers.psql
select tests.seed();

-- ① 执行权：只给 service_role
select ok(tests.try_as('anon', null, $$select * from private.remind_queue_pop(10)$$) like '42501%', 'remind_queue_pop：anon 没有执行权');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select * from private.remind_queue_pop(10)$$, null,
  'aaaaaaaa-5555-4000-8000-000000000001') like '42501%', 'remind_queue_pop：authenticated 没有执行权');
select ok(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
   where p.oid = 'private.remind_queue_pop(int)'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'remind_queue_pop：PUBLIC 没有执行权');
select ok(has_function_privilege('service_role', 'private.remind_queue_pop(int)', 'EXECUTE'), 'remind_queue_pop：service_role 能执行');

-- ② 定义者、search_path 置空、lock_timeout 5s、属主 postgres；返回 (table_name, id, user_id)
select is((select p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres'
          and p.proconfig @> array['search_path=""', 'lock_timeout=5s'] and cardinality(p.proconfig) = 2
   from pg_proc p where p.oid = 'private.remind_queue_pop(int)'::regprocedure), true,
  'remind_queue_pop：security definer、search_path 置空、lock_timeout=5s、属主 postgres');
select is(pg_get_function_result('private.remind_queue_pop(int)'::regprocedure), 'TABLE(table_name text, id uuid, user_id uuid)',
  '返回 table(table_name text, id uuid, user_id uuid)');

-- 造数据：A 有日程、待办、纪念日各一条；B 一条待办；C（停用）、D（冷静期）各一条待办；另有三条孤儿
insert into auth.users (id, email) values ('dddddddd-0000-4000-8000-000000000004', 'd@test.local');
insert into public.profiles (user_id, disabled_at, disabled_reason) values ('dddddddd-0000-4000-8000-000000000004', now(), 'deletion');
insert into public.events (id, user_id, title, date, created_at, updated_at) values
  ('e0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'e', '2026-11-03', 1, 1);
insert into public.todos (id, user_id, title, created_at, updated_at) values
  ('70000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1),
  ('70000000-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000002', 't', 1, 1),
  ('70000000-0000-4000-8000-00000000000c', 'cccccccc-0000-4000-8000-000000000003', 't', 1, 1),
  ('70000000-0000-4000-8000-00000000000d', 'dddddddd-0000-4000-8000-000000000004', 't', 1, 1);
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, created_at, updated_at) values
  ('a0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', 'n', 'solar', 1, 1, 1, 1);
-- 触发器已经把上面几行入队了；清掉重来，只留下面明写的这些
delete from private.remind_queue;
insert into private.remind_queue (table_name, id) values
  ('events', 'e0000000-0000-4000-8000-00000000000a'),
  ('todos', '70000000-0000-4000-8000-00000000000a'),
  ('anniversaries', 'a0000000-0000-4000-8000-00000000000a'),
  ('todos', '70000000-0000-4000-8000-00000000000b'),
  ('todos', '70000000-0000-4000-8000-00000000000c'),
  ('todos', '70000000-0000-4000-8000-00000000000d'),
  ('events', 'e0000000-0000-4000-8000-0000000000ff'),          -- 孤儿：没有这一行
  ('todos', 'e0000000-0000-4000-8000-00000000000a'),           -- 孤儿：id 在 events 里、todos 里没有（按表名找，不串表）
  ('anniversaries', '70000000-0000-4000-8000-00000000000a');   -- 孤儿：同上

-- ③ p_limit = 0：只删孤儿，一条都不出队
select is((select count(*)::int from private.remind_queue_pop(0)), 0, 'p_limit = 0：不出队');
select is((select count(*)::int from private.remind_queue), 6, 'p_limit = 0 也删了三条孤儿（K3-remind-orphan），其余 6 条还在');

-- ④ 上限：p_limit = 2 只出队 2 条；按人公平（安全审查必改 2）：每人按 (table_name, id) 编号、先比编号，所以是 A 的第 1 条和 B 的第 1 条；出队即删
create temp table got1 as select * from private.remind_queue_pop(2);
select is((select string_agg(table_name || ':' || id::text, ',' order by table_name, id) from got1),
  'anniversaries:a0000000-0000-4000-8000-00000000000a,todos:70000000-0000-4000-8000-00000000000b', '上限 2：先取每人第 1 条（A 的纪念日、B 的待办），不是 A 的前两条');
select is((select count(*)::int from private.remind_queue q join got1 g on g.table_name = q.table_name and g.id = q.id), 0, '出队即删：取到的已不在队列里');

-- ⑤ 余下：只出队可用账号（A）的；停用的 C、冷静期的 D 跳过、不出队（0.42 第 1 条）
create temp table got2 as select * from private.remind_queue_pop(500);
select is((select string_agg(id::text || '@' || user_id::text, ',' order by id) from got2),
  '70000000-0000-4000-8000-00000000000a@aaaaaaaa-0000-4000-8000-000000000001,e0000000-0000-4000-8000-00000000000a@aaaaaaaa-0000-4000-8000-000000000001',
  '余下只出队可用账号 A 的两条，返回 user_id');
select is((select string_agg(id::text, ',' order by id) from private.remind_queue),
  '70000000-0000-4000-8000-00000000000c,70000000-0000-4000-8000-00000000000d', '停用（C）和冷静期（D）的留在队列里');

-- ⑥ 恢复以后下一轮照常出队
update public.profiles set disabled_at = null, disabled_reason = null where user_id = 'dddddddd-0000-4000-8000-000000000004';
select is((select string_agg(id::text, ',') from private.remind_queue_pop(500)), '70000000-0000-4000-8000-00000000000d', '冷静期恢复后下一轮出队');

-- ⑦ 上限封顶 500、负数按 0；null 按 0
select is((select count(*)::int from private.remind_queue_pop(-5)), 0, '负数按 0');
select is((select count(*)::int from private.remind_queue_pop(null)), 0, 'null 按 0');

-- ⑧ TC-DEL-remind_queue：注销满 7 天、account-purge 删掉 auth 用户后（外键级联删掉行），下一轮队列里这个人的项清为 0
delete from auth.users where id = 'cccccccc-0000-4000-8000-000000000003';
select is((select count(*)::int from private.remind_queue_pop(0)), 0, '下一轮：C 的项已是孤儿，不出队');
select is((select count(*)::int from private.remind_queue), 0, 'C 的账号删掉后，它的队列项作为孤儿在下一轮清为 0（分两句：同一语句看不到函数里的删除）');

-- ⑨ 按人公平（安全审查必改 2）：B 有 60 条、id 全从 00000000… 开始，A 一条 ffffffff…；一轮里 B 最多出 50 条，A 的照样出队
delete from private.remind_queue;
insert into public.todos (id, user_id, title, created_at, updated_at)
  select format('00000000-0000-4000-8000-%s', lpad(to_hex(i), 12, '0'))::uuid, 'bbbbbbbb-0000-4000-8000-000000000002', 't', 1, 1 from generate_series(1, 60) i;
insert into public.todos (id, user_id, title, created_at, updated_at) values ('ffffffff-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1);
delete from private.remind_queue;
insert into private.remind_queue (table_name, id)
  select 'todos', t.id from public.todos t where t.id::text like '00000000-%' or t.id = 'ffffffff-0000-4000-8000-000000000001';
create temp table got3 as select * from private.remind_queue_pop(500);
select is((select count(*)::int from got3 where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'), 50, '一个人一轮最多出队 50 条');
select ok(exists (select 1 from got3 where id = 'ffffffff-0000-4000-8000-000000000001'), '别人 id 排在最后的照样出队（插不了队）');
select is((select count(*)::int from private.remind_queue), 10, 'B 余下 10 条留到下一轮');

-- ⑩ 总数封顶 500（代码审查建议 ⑨）：另造 11 个可用账号各 50 条，加上 B 余下的 10 条共 560 条，一轮只回 500
insert into auth.users (id, email)
  select format('f%s-0000-4000-8000-000000000000', lpad(i::text, 7, '0'))::uuid, format('f%s@test.local', i) from generate_series(1, 11) i;
insert into public.profiles (user_id)
  select format('f%s-0000-4000-8000-000000000000', lpad(i::text, 7, '0'))::uuid from generate_series(1, 11) i
  on conflict do nothing;
insert into public.todos (id, user_id, title, created_at, updated_at)
  select format('%s-0000-4000-8000-%s', lpad(to_hex(i), 8, '0'), lpad(to_hex(j), 12, '0'))::uuid,
         format('f%s-0000-4000-8000-000000000000', lpad(i::text, 7, '0'))::uuid, 't', 1, 1
    from generate_series(1, 11) i, generate_series(1, 50) j;
delete from private.remind_queue where id::text not like '00000000-%';
insert into private.remind_queue (table_name, id)
  select 'todos', t.id from public.todos t where t.user_id::text like 'f00000%';
select is((select count(*)::int from private.remind_queue_pop(500)), 500, '队列 560 条：一轮只回 500');

select * from finish();
rollback;
