-- B2 迁移 20261104100000_core_allday_remind_enqueue.sql：改 remind.default_time 时把这个人的全天日程放进 remind_queue
-- （private.enqueue_allday_defaults + settings_allday_defaults）。函数一侧按新 default_time 重算在 tests/edge/push-dispatch-allday.test.ts。
-- 一次性补算那一句在迁移执行时跑（这里的库在造数据之前就迁移完了），⑥ 把那句原样再执行一次看结果（代码审查 L5）。
-- 同一迁移里 create or replace 的 private.enqueue_floating（时区恢复后补算 remind_at 为空的，代码审查 L2）在 ⑦ 测；
-- events_occ_reset（换了“哪一次提醒”时清空 notified_for、pushed_for，二轮审查 N-M1）在 ⑧ 测。
-- 用户：seed 的 A、B。A 的写入用 authenticated 身份（带会话），证明不给 authenticated 执行权也照样触发。
begin;
select plan(27);
\ir _helpers.psql
select tests.seed();

create function tests.a(p_sql text) returns text language sql as $$
  select tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', p_sql, null, 'aaaaaaaa-5555-4000-8000-000000000001')
$$;
create function tests.q() returns text language sql as $$
  select coalesce(string_agg(table_name || ':' || id::text, ',' order by table_name, id), '') from private.remind_queue
$$;

-- ① 函数属性：security definer、search_path 置空；anon、authenticated、PUBLIC 都没有执行权（触发器不需要）
select is((select p.prosecdef and p.proconfig = array['search_path=""'] and l.lanname = 'plpgsql'
   from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = 'private.enqueue_allday_defaults()'::regprocedure),
  true, 'enqueue_allday_defaults：plpgsql、security definer、search_path 置空');
select ok(not has_function_privilege('authenticated', 'private.enqueue_allday_defaults()', 'EXECUTE')
      and not has_function_privilege('anon', 'private.enqueue_allday_defaults()', 'EXECUTE'), 'anon、authenticated 都没有执行权');
select ok(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
   where p.oid = 'private.enqueue_allday_defaults()'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'), 'PUBLIC 没有执行权');

-- 造数据（建行时 events_remind 会入队，造完清空队列）
insert into public.events (id, user_id, title, date, time, tz, remind_min, remind_days, deleted_at, created_at, updated_at) values
  ('e3200000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '全天 当天', '2026-11-05', null, null, null, 0, null, 1, 1),
  ('e3200000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', '全天 前一天', '2026-11-05', null, null, null, 1, null, 1, 1),
  ('e3200000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', '全天 不提醒', '2026-11-05', null, null, null, null, null, 1, 1),
  ('e3200000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', '有时刻', '2026-11-05', '15:00', 'Asia/Seoul', 15, null, null, 1, 1),
  ('e3200000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001', '全天 删了', '2026-11-05', null, null, null, 0, 5, 1, 1),
  ('e3200000-0000-4000-8000-000000000006', 'bbbbbbbb-0000-4000-8000-000000000002', 'B 的全天', '2026-11-05', null, null, null, 0, null, 1, 1);
insert into public.todos (id, user_id, title, due, due_time, remind_days, remind_before_min, done, remind_at, created_at, updated_at) values
  ('d3200000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '无时刻 当天提醒', '2026-11-05', null, 0, null, false, null, 1, 1),
  ('d3200000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', '有时刻 提前 10 分钟', '2026-11-05', '15:00', null, 10, false, null, 1, 1),
  ('d3200000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', '有时刻 不提醒', '2026-11-05', '15:00', null, null, false, null, 1, 1),
  ('d3200000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', '无时刻 不提醒', '2026-11-05', null, null, null, false, null, 1, 1),
  ('d3200000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001', '已完成', '2026-11-05', null, 0, null, true, null, 1, 1);
delete from private.remind_queue;

select is((select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = 'public.settings'::regclass and tgname like 'settings_allday%'),
  'settings_allday_defaults_ins,settings_allday_defaults_upd', '触发器拆成新建、更新两个（代码审查 L3）');

-- ② 新建 remind.default_time：A 的两条全天日程（当天、前一天）入队；不提醒的、有时刻的、删了的、B 的都不入队
select is(tests.a($$insert into public.settings (id, key, value) values ('5f320000-0000-4000-8000-000000000001', 'remind.default_time', '"08:30"')$$), 'ok',
  'A 用 authenticated 身份新建 remind.default_time：写得进去（不给执行权也能触发）');
select is(tests.q(), 'events:e3200000-0000-4000-8000-000000000001,events:e3200000-0000-4000-8000-000000000002',
  '新建：只入队 A 没删的、remind_days 不为空的全天日程');

-- ③ 改值、软删、恢复、撤销、取消撤销都入队；已经在队列里的不重复（on conflict do nothing）；值没变的更新不入队
delete from private.remind_queue;
select is(tests.a($$update public.settings set value = '"07:00"' where id = '5f320000-0000-4000-8000-000000000001'$$), 'ok', '改值：写得进去');
select is(tests.q(), 'events:e3200000-0000-4000-8000-000000000001,events:e3200000-0000-4000-8000-000000000002', '改值：入队');
select is(tests.a($$update public.settings set value = '"06:00"' where id = '5f320000-0000-4000-8000-000000000001'$$) || '|' ||
  (select count(*)::text from private.remind_queue), 'ok|2', '再改一次：已在队列里的不重复、不报错');
delete from private.remind_queue;
select is(tests.a($$update public.settings set value = '"06:00"', deleted_at = null, undone = false where id = '5f320000-0000-4000-8000-000000000001'$$) || '|' || tests.q(),
  'ok|', '值没变的更新（同步时原样再写一次 value、deleted_at、undone）：不入队（代码审查 L3）');
select is(tests.a($$update public.settings set deleted_at = 1 where id = '5f320000-0000-4000-8000-000000000001'$$) || '|' || tests.q(),
  'ok|events:e3200000-0000-4000-8000-000000000001,events:e3200000-0000-4000-8000-000000000002', '软删（回到出厂 09:00）：入队');
delete from private.remind_queue;
select is(tests.a($$update public.settings set deleted_at = null where id = '5f320000-0000-4000-8000-000000000001'$$) || '|' || tests.q(),
  'ok|events:e3200000-0000-4000-8000-000000000001,events:e3200000-0000-4000-8000-000000000002', '恢复（只改 deleted_at）：入队');
delete from private.remind_queue;
select is(tests.a($$update public.settings set undone = true where id = '5f320000-0000-4000-8000-000000000001'$$) || '|' || tests.q(),
  'ok|events:e3200000-0000-4000-8000-000000000001,events:e3200000-0000-4000-8000-000000000002', '撤销（只改 undone = true）：入队');
delete from private.remind_queue;
select is(tests.a($$update public.settings set undone = false where id = '5f320000-0000-4000-8000-000000000001'$$) || '|' || tests.q(),
  'ok|events:e3200000-0000-4000-8000-000000000001,events:e3200000-0000-4000-8000-000000000002', '取消撤销（只改 undone = false）：入队');

-- ④ 别的设置键不入队
delete from private.remind_queue;
select is(tests.a($$insert into public.settings (id, key, value) values ('5f320000-0000-4000-8000-000000000002', 'remind.show_title', 'false')$$) || '|' || tests.q(),
  'ok|', '改 remind.show_title：不入队');

-- ⑥ 一次性补算那一句原样再执行一次：A、B 没删的、remind_days 不为空的全天日程都入队（不分人）；不提醒的、有时刻的、删了的不入
delete from private.remind_queue;
insert into private.remind_queue (table_name, id)
  select 'events', e.id from public.events e
   where e.time is null and e.remind_days is not null and e.deleted_at is null
on conflict do nothing;
select is((select string_agg(id::text, ',' order by id) from private.remind_queue where id::text like 'e32%'),
  'e3200000-0000-4000-8000-000000000001,e3200000-0000-4000-8000-000000000002,e3200000-0000-4000-8000-000000000006',
  '补算：A 的当天、前一天和 B 的全天日程入队；不提醒的、有时刻的、删了的不入（代码审查 L5）');

-- ⑦ 时区恢复后的 enqueue_floating：remind_at 为空但设了提醒的全天日程、待办也入队（代码审查 L2）
delete from private.remind_queue;
select private.enqueue_floating('aaaaaaaa-0000-4000-8000-000000000001');
select is((select string_agg(table_name || ':' || id::text, ',' order by table_name, id) from private.remind_queue where id::text like 'e32%' or id::text like 'd32%'),
  'events:e3200000-0000-4000-8000-000000000001,events:e3200000-0000-4000-8000-000000000002,'
  || 'todos:d3200000-0000-4000-8000-000000000001,todos:d3200000-0000-4000-8000-000000000002',
  'enqueue_floating：remind_at 为空、设了提醒的全天日程（当天、前一天）和待办（无时刻看 remind_days、有时刻看 remind_before_min）入队；不提醒的、有时刻的日程、删了的、已完成的、别人的不入');
select ok(not has_function_privilege('authenticated', 'private.enqueue_floating(uuid)', 'EXECUTE')
      and not has_function_privilege('service_role', 'private.enqueue_floating(uuid)', 'EXECUTE'), 'create or replace 以后 enqueue_floating 仍不授执行权');

-- ⑧ events_occ_reset（二轮审查 N-M1）：A 用 authenticated 身份编辑；每步之前用 postgres 把两列重新填上
create function tests.mark(p_id uuid) returns void language sql as $$
  update public.events set notified_for = 111, pushed_for = 222, snooze_at = 444 where id = p_id
$$;
create function tests.marks(p_id uuid) returns text language sql as $$
  select coalesce(notified_for::text, '空') || '|' || coalesce(pushed_for::text, '空') || '|' || coalesce(snooze_at::text, '空') from public.events where id = p_id
$$;
-- 函数里查（新快照）：同一条 select 里直接写子查询会用语句开始时的快照，看不到 tests.a 里那次更新
create function tests.fv_at_rev(p_id uuid) returns text language sql as $$
  select ((fv->>'notified_for')::int = rev and (fv->>'snooze_at')::int = rev)::text from public.events where id = p_id
$$;
select is((select p.prosecdef and p.proconfig = array['search_path=""'] and l.lanname = 'plpgsql'
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('anon', p.oid, 'EXECUTE')
   from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = 'private.events_occ_reset()'::regprocedure),
  true, 'events_occ_reset：plpgsql、security definer、search_path 置空，anon、authenticated 没有执行权');
select tests.mark('e3200000-0000-4000-8000-000000000001');
select is(tests.a($$update public.events set title = '全天 当天（改名）' where id = 'e3200000-0000-4000-8000-000000000001'$$) || '|' ||
  tests.marks('e3200000-0000-4000-8000-000000000001'), 'ok|111|222|444', '只改名称：notified_for、pushed_for、snooze_at 都保留（同一次提醒）');
select is(tests.a($$update public.events set date = '2026-11-06' where id = 'e3200000-0000-4000-8000-000000000001'$$) || '|' ||
  tests.marks('e3200000-0000-4000-8000-000000000001') || '|' ||
  tests.fv_at_rev('e3200000-0000-4000-8000-000000000001'),
  'ok|空|空|空|true',
  '挪日期：三列都清空；fv 里 notified_for、snooze_at 的值等于这次的 rev（touch 在清空之后才跑，才会给它们记这次的版本号，三轮审查 R3-L1）');
select ok((select string_agg(tgname, ',' order by tgname collate "C") from pg_trigger
   where tgrelid = 'public.events'::regclass and tgname in ('events_occ_reset', 'events_touch')) = 'events_occ_reset,events_touch',
  '同一时机的 before 行触发器按名字排序执行：events_occ_reset 排在 events_touch 前面（R3-L1）');
select tests.mark('e3200000-0000-4000-8000-000000000001');
select is(tests.a($$update public.events set remind_days = 1 where id = 'e3200000-0000-4000-8000-000000000001'$$) || '|' ||
  tests.marks('e3200000-0000-4000-8000-000000000001'), 'ok|空|空|空', '改当天 / 前一天（remind_days）：三列都清空');
select tests.mark('e3200000-0000-4000-8000-000000000001');
select is(tests.a($$update public.events set time = '10:00', tz = 'Asia/Seoul' where id = 'e3200000-0000-4000-8000-000000000001'$$) || '|' ||
  tests.marks('e3200000-0000-4000-8000-000000000001'), 'ok|空|空|空', 'time 从空变有：三列都清空');
select tests.mark('e3200000-0000-4000-8000-000000000004');
select is(tests.a($$update public.events set time = '16:00' where id = 'e3200000-0000-4000-8000-000000000004'$$) || '|' ||
  split_part(tests.marks('e3200000-0000-4000-8000-000000000004'), '|', 1), 'ok|111',
  '有时刻的只改时刻（不是空和非空之间）：这个触发器不动 notified_for（pushed_for 照旧由 touch 清）');
select tests.mark('e3200000-0000-4000-8000-000000000002');
select is(tests.a($$update public.events set date = '2026-11-07', notified_for = 333 where id = 'e3200000-0000-4000-8000-000000000002'$$) || '|' ||
  tests.marks('e3200000-0000-4000-8000-000000000002'), 'ok|333|空|空', '同一个补丁里显式写了 notified_for：照客户端的值，pushed_for、snooze_at 照清');
select tests.mark('e3200000-0000-4000-8000-000000000002');
select is(tests.a($$update public.events set date = '2026-11-08', snooze_at = 555 where id = 'e3200000-0000-4000-8000-000000000002'$$) || '|' ||
  tests.marks('e3200000-0000-4000-8000-000000000002'), 'ok|空|空|555', '同一个补丁里显式写了 snooze_at：照客户端的值，notified_for、pushed_for 照清（R3-L2）');

select * from finish();
rollback;
