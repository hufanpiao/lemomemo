-- B2 迁移 20261103140000_core_remind_due.sql：push-dispatch 第 1 步的 private.remind_due、resolve 候选的 private.remind_pushed、
-- 三张表 snooze_at 的取值约束（B2 BE-2 安全审查必改 1、代码审查 M2、R-317）。函数一侧的对拍在 tests/edge/push-dispatch-due.test.ts、
-- push-dispatch-r316.test.ts（内存替身照这里的 SQL 写）。
-- 用户：seed 的 A、B 可用，C 是管理员停用。时间用小数字：窗口 (1000000, 2000000]。
begin;
select plan(20);
\ir _helpers.psql
select tests.seed();

-- ① 执行权：只给 service_role；定义者、search_path 置空、lock_timeout 5s
select ok(tests.try_as('anon', null, $$select * from private.remind_due(0, 1, 1, 1)$$) like '42501%', 'remind_due：anon 没有执行权');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select * from private.remind_pushed(0, 1, 1, 1)$$, null,
  'aaaaaaaa-5555-4000-8000-000000000001') like '42501%', 'remind_pushed：authenticated 没有执行权');
select ok(has_function_privilege('service_role', 'private.remind_due(bigint, bigint, int, int)', 'EXECUTE')
      and has_function_privilege('service_role', 'private.remind_pushed(bigint, bigint, int, int)', 'EXECUTE'), '两个函数 service_role 都能执行');
select ok(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
   where p.oid in ('private.remind_due(bigint, bigint, int, int)'::regprocedure, 'private.remind_pushed(bigint, bigint, int, int)'::regprocedure)
     and a.grantee = 0 and a.privilege_type = 'EXECUTE'), '两个函数 PUBLIC 都没有执行权');
select is((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""', 'lock_timeout=5s'] and cardinality(p.proconfig) = 2)
   from pg_proc p where p.oid in ('private.remind_due(bigint, bigint, int, int)'::regprocedure, 'private.remind_pushed(bigint, bigint, int, int)'::regprocedure)),
  true, '两个函数：security definer、search_path 置空、lock_timeout=5s');

-- ② snooze_at 约束：为空或 0～4102444800000
select ok(tests.try_as('postgres', null, $$insert into public.todos (id, user_id, title, created_at, updated_at, snooze_at)
  values ('71000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1, 4102444800001)$$) like '23514%', 'todos.snooze_at 超过 2100 年：拒');
select ok(tests.try_as('postgres', null, $$insert into public.events (id, user_id, title, date, created_at, updated_at, snooze_at)
  values ('e1000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'e', '2026-11-03', 1, 1, -1)$$) like '23514%', 'events.snooze_at 负数：拒');
select ok(tests.try_as('postgres', null, $$insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, created_at, updated_at, snooze_at)
  values ('a1000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', 'n', 'solar', 1, 1, 1, 1, 9000000000000000)$$) like '23514%', 'anniversaries.snooze_at 超界：拒');
select is(tests.try_as('postgres', null, $$insert into public.todos (id, user_id, title, created_at, updated_at, snooze_at)
  values ('71000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1, 4102444800000)$$), 'ok', 'snooze_at = 上限：收');
delete from public.todos where id = '71000000-0000-4000-8000-000000000002';

-- 造数据（A、C 各若干；B 造 500 条“remind_at 很早、snooze_at 很远”的攻击行，再加一条正常到点的）
insert into public.todos (id, user_id, title, created_at, updated_at, remind_at, snooze_at, pushed_for, notified_for, done, deleted_at, undone) values
  ('72000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1, 1100000, null, null, null, false, null, false),     -- 到点
  ('72000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1, 1100000, 3000000, null, null, false, null, false),  -- 稍后到窗口外
  ('72000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1, 1200000, null, 1200000, null, false, null, false),  -- 推过了
  ('72000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1, 1300000, null, null, 1300000, false, null, false),  -- 按过“知道了”
  ('72000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1, 1400000, null, null, null, true, null, false),      -- 完成了
  ('72000000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1, 1500000, null, null, null, false, 5, false),        -- 删了
  ('72000000-0000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1, 900000, 1600000, null, null, false, null, false),   -- 稍后落进窗口
  ('72000000-0000-4000-8000-000000000008', 'cccccccc-0000-4000-8000-000000000003', 't', 1, 1, 1100000, null, null, null, false, null, false),     -- 停用账号
  ('72000000-0000-4000-8000-000000000009', 'bbbbbbbb-0000-4000-8000-000000000002', 't', 1, 1, 1800000, null, null, null, false, null, false);     -- B 正常到点
insert into public.todos (id, user_id, title, created_at, updated_at, remind_at, snooze_at)
  select format('00000000-0000-4000-8000-%s', lpad(to_hex(i), 12, '0'))::uuid, 'bbbbbbbb-0000-4000-8000-000000000002', 't', 1, 1, i, 4000000000000
    from generate_series(1, 500) i;
insert into public.events (id, user_id, title, date, created_at, updated_at, remind_at, undone) values
  ('e2000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'e', '2026-11-03', 1, 1, 1500000, false),
  ('e2000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'e', '2026-11-03', 1, 1, 1500000, true);   -- 撤销了

-- 可推设备（M4：remind_due 只回至少有一台未删、push_endpoint 不空的设备的人）。A、B 各一台；C 是停用账号，本来就不回
insert into public.devices (id, user_id, platform, label, session_id, push_endpoint, p256dh, auth) values
  ('d3100000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'web', 'A', null, 'https://fcm.googleapis.com/fcm/send/a31',
   'BA' || repeat('B', 84) || 'A', repeat('A', 21) || 'g'),
  ('d3100000-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000002', 'web', 'B', null, 'https://fcm.googleapis.com/fcm/send/b31',
   'BA' || repeat('B', 84) || 'A', repeat('A', 21) || 'g');

-- ③ remind_due：精确条件；B 的 500 条攻击行占不住名额
select is((select string_agg(table_name || ':' || id::text || '@' || due_at, ',' order by due_at, table_name, id) from private.remind_due(1000000, 2000000, 20, 500)),
  'todos:72000000-0000-4000-8000-000000000001@1100000,events:e2000000-0000-4000-8000-000000000001@1500000,'
  || 'todos:72000000-0000-4000-8000-000000000007@1600000,todos:72000000-0000-4000-8000-000000000009@1800000',
  'remind_due：只回到点、没推过、没确认、没完成、没删、没撤销、账号可用的；due_at 按 greatest 算；500 条攻击行一条不占');
select is((select string_agg(id::text, ',' order by due_at) from private.remind_due(1000000, 2000000, 1, 500)),
  '72000000-0000-4000-8000-000000000001,72000000-0000-4000-8000-000000000009', '每人上限 1：A、B 各回最早的一条');
select is((select count(*)::int from private.remind_due(1000000, 2000000, 20, 2)), 2, '总数上限 2');
select is((select count(*)::int from private.remind_due(1000000, 2000000, 20, 100000)), 4, '总数上限封顶 500，多给不报错');
select is((select count(*)::int from private.remind_due(1000000, 2000000, null, null)), 0, 'null 按 0');
-- M4：没有可推设备的人不返回——B 的设备软删了、或者只剩没地址的行，B 那条到点的（…0009）就不回，A 的照回
update public.devices set deleted_at = 5 where id = 'd3100000-0000-4000-8000-00000000000b';
insert into public.devices (id, user_id, platform, label, session_id) values
  ('d3100000-0000-4000-8000-00000000000c', 'bbbbbbbb-0000-4000-8000-000000000002', 'web', 'B 没订阅', null);
select is((select string_agg(id::text, ',' order by due_at, table_name, id) from private.remind_due(1000000, 2000000, 20, 500)),
  '72000000-0000-4000-8000-000000000001,e2000000-0000-4000-8000-000000000001,72000000-0000-4000-8000-000000000007',
  'M4：B 只有软删的设备和没地址的设备：B 的到点条目不返回，A 的照回');
update public.devices set deleted_at = null where id = 'd3100000-0000-4000-8000-00000000000b';
select is((select count(*)::int from private.remind_due(1000000, 2000000, 20, 500) where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'), 1,
  'M4：B 的设备恢复后，B 那条到点的又回了');

-- ④ remind_pushed：resolve 候选（R-317 含完成、删除、撤销、关掉提醒）
update public.todos set pushed_for = 1100000 where id in ('72000000-0000-4000-8000-000000000005', '72000000-0000-4000-8000-000000000006');
update public.events set pushed_for = 1500000 where id = 'e2000000-0000-4000-8000-000000000002';
insert into public.todos (id, user_id, title, created_at, updated_at, remind_at, pushed_for, notified_for, snooze_at) values
  ('73000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1, 1200000, 1200000, 1200000, null),   -- 按过“知道了”
  ('73000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1, 1200000, 1200000, null, 1700000),    -- 按了“稍后”
  ('73000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 't', 1, 1, null, 1200000, null, null),          -- 提醒关了
  ('73000000-0000-4000-8000-000000000004', 'cccccccc-0000-4000-8000-000000000003', 't', 1, 1, 1200000, 1200000, 1200000, null);    -- 停用账号
select is((select string_agg(table_name || ':' || id::text, ',' order by table_name, id) from private.remind_pushed(1000000, 2000000, 20, 500)),
  'events:e2000000-0000-4000-8000-000000000002,todos:72000000-0000-4000-8000-000000000005,todos:72000000-0000-4000-8000-000000000006,'
  || 'todos:73000000-0000-4000-8000-000000000001,todos:73000000-0000-4000-8000-000000000002,todos:73000000-0000-4000-8000-000000000003',
  'remind_pushed：撤销、完成、删除、按过知道了、按了稍后、关了提醒的都回；推过没处理的（…0003）和停用账号的不回');
select is((select count(*)::int from private.remind_pushed(1000000, 2000000, 2, 500)), 2, 'remind_pushed 每人上限 2');
select is((select count(*)::int from private.remind_pushed(1200000, 2000000, 20, 500)), 1, 'pushed_for 不在 (lo, hi] 里的不回（只剩撤销的日程 1500000）');

-- ⑤ B 再造 520 条推过、没处理的行：resolve 候选照样回 A 的
insert into public.todos (id, user_id, title, created_at, updated_at, remind_at, pushed_for)
  select format('01000000-0000-4000-8000-%s', lpad(to_hex(i), 12, '0'))::uuid, 'bbbbbbbb-0000-4000-8000-000000000002', 't', 1, 1, 1000000 + i, 1000000 + i
    from generate_series(1, 520) i;
select is((select count(*)::int from private.remind_pushed(1000000, 2000000, 20, 500)), 6, 'B 的 520 条推过没处理的行一条不回，A 的 6 条照样回');

select * from finish();
rollback;
