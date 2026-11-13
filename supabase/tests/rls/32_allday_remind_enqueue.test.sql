-- 设置改了、时区变了的批量入队（R-411 迁移 20261113100000；方案 docs/10-架构/方案-提醒队列重写.md 5.2 T08、T09，3.3 ②⑥）：
-- private.remind_on_settings（一个触发器 settings_remind，按键分派）→ private.remind_enqueue('allday' / 'anniv')；
-- 时区采纳、切固定时区的 private.enqueue_floating → remind_enqueue('floating')。
-- 取代 B2 迁移 20261104100000 的 enqueue_allday_defaults + settings_allday_defaults_ins/_upd 和 0005 的 enqueue_anniv_defaults + settings_anniv_defaults：
--   纪念日默认的软删、撤销也重算（修 P3）；原样再写不重算（修 P11）；批量只收没到点或还没算的，已经推过、remind_at 已过的不进（修 P16）。
-- 函数一侧按新 default_time 重算在 tests/edge/push-dispatch-allday.test.ts。
-- 日程“换了哪一次”（原 events_occ_reset，R-411 起是 touch() 里调的 private.remind_reset）在 ⑥ 测，期望照旧。
-- 用户：seed 的 A、B。A 的写入用 authenticated 身份（带会话），证明不给 authenticated 执行权也照样触发。
begin;
select plan(41);
\ir _helpers.psql
select tests.seed();

create function tests.a(p_sql text) returns text language sql as $$
  select tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', p_sql, null, 'aaaaaaaa-5555-4000-8000-000000000001')
$$;
create function tests.q() returns text language sql as $$
  select coalesce(string_agg(table_name || ':' || right(id::text, 2), ',' order by table_name, id), '') from private.remind_queue
$$;
-- 清空队列、以 A 的身份跑一句、返回“结果|队列”
create function tests.run(p_sql text) returns text language sql as $$
  delete from private.remind_queue;
  select tests.a(p_sql) || '|' || tests.q();
$$;

-- ① 函数属性：remind_on_settings 是 plpgsql、security definer、search_path 置空；anon、authenticated、PUBLIC 都没有执行权（触发器不需要）
select is((select p.prosecdef and p.proconfig = array['search_path=""'] and l.lanname = 'plpgsql'
   from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = 'private.remind_on_settings()'::regprocedure),
  true, 'remind_on_settings：plpgsql、security definer、search_path 置空');
select ok(not has_function_privilege('authenticated', 'private.remind_on_settings()', 'EXECUTE')
      and not has_function_privilege('anon', 'private.remind_on_settings()', 'EXECUTE')
      and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
         where p.oid = 'private.remind_on_settings()'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'), 'anon、authenticated、PUBLIC 都没有执行权');
select is((select string_agg(t.tgname || ':' || p.proname, ',' order by t.tgname) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'public.settings'::regclass and not t.tgisinternal and (t.tgname ~ '(remind|default)' or p.proname ~ 'remind')),
  'settings_remind:remind_on_settings', 'settings 上提醒相关的只剩一个触发器 settings_remind（原来三个：settings_anniv_defaults、settings_allday_defaults_ins、_upd）');
select ok(to_regprocedure('private.enqueue_allday_defaults()') is null and to_regprocedure('private.enqueue_anniv_defaults()') is null,
  '被取代的 enqueue_allday_defaults、enqueue_anniv_defaults 已删');

-- 造数据（建行时触发器会入队，造完清空队列）。remind_at 用 postgres 直接写（系统列，不入队）：
-- 1000 = 早就过了（已推过），9999999999999 = 很久以后（批量 prio 2），空 = 还没算
insert into public.events (id, user_id, title, date, time, tz, remind_min, remind_days, deleted_at, created_at, updated_at) values
  ('e3200000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '全天 当天', '2026-11-05', null, null, null, 0, null, 1, 1),
  ('e3200000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', '全天 前一天', '2026-11-05', null, null, null, 1, null, 1, 1),
  ('e3200000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', '全天 不提醒', '2026-11-05', null, null, null, null, null, 1, 1),
  ('e3200000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', '有时刻', '2026-11-05', '15:00', 'Asia/Seoul', 15, null, null, 1, 1),
  ('e3200000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001', '全天 删了', '2026-11-05', null, null, null, 0, 5, 1, 1),
  ('e3200000-0000-4000-8000-000000000006', 'bbbbbbbb-0000-4000-8000-000000000002', 'B 的全天', '2026-11-05', null, null, null, 0, null, 1, 1),
  ('e3200000-0000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-000000000001', '全天 已推过', '2026-11-05', null, null, null, 0, null, 1, 1),
  ('e3200000-0000-4000-8000-000000000008', 'aaaaaaaa-0000-4000-8000-000000000001', '全天 远期', '2026-11-05', null, null, null, 0, null, 1, 1);
insert into public.todos (id, user_id, title, due, due_time, remind_days, remind_before_min, done, created_at, updated_at) values
  ('d3200000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '无时刻 当天提醒', '2026-11-05', null, 0, null, false, 1, 1),
  ('d3200000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', '有时刻 提前 10 分钟', '2026-11-05', '15:00', null, 10, false, 1, 1),
  ('d3200000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', '有时刻 不提醒', '2026-11-05', '15:00', null, null, false, 1, 1),
  ('d3200000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', '无时刻 不提醒', '2026-11-05', null, null, null, false, 1, 1),
  ('d3200000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001', '已完成', '2026-11-05', null, 0, null, true, 1, 1),
  ('d3200000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001', '已推过', '2026-11-05', null, 0, null, false, 1, 1),
  ('d3200000-0000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-000000000001', '远期', '2026-11-05', null, 0, null, false, 1, 1),
  ('d3200000-0000-4000-8000-000000000008', 'aaaaaaaa-0000-4000-8000-000000000001', '没有截止日期', null, null, 0, null, false, 1, 1);
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, remind_offsets, remind_time, deleted_at, created_at, updated_at) values
  ('a3200000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', '用默认', 'solar', 3, 5, null, null, null, 1, 1),
  ('a3200000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', '自己设', 'solar', 3, 5, '{7}', '08:00', null, 1, 1),
  ('a3200000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', '删了', 'solar', 3, 5, null, null, 5, 1, 1),
  ('a3200000-0000-4000-8000-000000000004', 'bbbbbbbb-0000-4000-8000-000000000002', 'birthday', 'B 的', 'solar', 3, 5, null, null, null, 1, 1),
  ('a3200000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', '已推过', 'solar', 3, 5, null, null, null, 1, 1),
  ('a3200000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', '只有时刻用默认', 'solar', 3, 5, '{1}', null, null, 1, 1);
update public.events set remind_at = 1000 where id = 'e3200000-0000-4000-8000-000000000007';
update public.events set remind_at = 9999999999999 where id = 'e3200000-0000-4000-8000-000000000008';
update public.todos set remind_at = 1000 where id = 'd3200000-0000-4000-8000-000000000006';
update public.todos set remind_at = 9999999999999 where id = 'd3200000-0000-4000-8000-000000000007';
update public.anniversaries set remind_at = 1000 where id = 'a3200000-0000-4000-8000-000000000005';
delete from private.remind_queue;

-- 三种批量范围各该入哪些（A 的）：
--   allday：没删、设了提醒、没到点或还没算的全天日程（1 当天、2 前一天、8 远期；7 已推过、3 不提醒、4 有时刻、5 删了、6 B 的都不入）
--   anniv：没删、用默认（remind_offsets 或 remind_time 为空）、没到点或还没算的纪念日（1、6；2 自己设、3 删了、4 B 的、5 已推过不入）
create temp table want (k text primary key, v text);
insert into want values
  ('allday', 'events:01,events:02,events:08'),
  ('anniv', 'anniversaries:01,anniversaries:06');

-- ② T08：三个设置键 × 新建、改值、软删、恢复、撤销、取消撤销（18 条）都入队；值没变的更新不入队（3 条）；入队的是批量项（prio 1、2）
select is(tests.run($$insert into public.settings (id, key, value) values ('5f320000-0000-4000-8000-000000000001', 'remind.default_time', '"08:30"')$$),
  'ok|' || (select v from want where k = 'allday'), 'remind.default_time 新建：入队（authenticated 身份写，不给执行权也能触发）');
select is((select string_agg(right(id::text, 2) || ':' || prio || ':' || fresh, ',' order by id) from private.remind_queue), '01:1:false,02:1:false,08:2:false',
  '批量项的 prio：还没算的记 1、很久以后的记 2；不是 fresh');
select is(tests.run($$update public.settings set value = '"07:00"' where id = '5f320000-0000-4000-8000-000000000001'$$), 'ok|' || (select v from want where k = 'allday'), 'remind.default_time 改值：入队');
select is(tests.run($$update public.settings set deleted_at = 1 where id = '5f320000-0000-4000-8000-000000000001'$$), 'ok|' || (select v from want where k = 'allday'), 'remind.default_time 软删（回到出厂 09:00）：入队');
select is(tests.run($$update public.settings set deleted_at = null where id = '5f320000-0000-4000-8000-000000000001'$$), 'ok|' || (select v from want where k = 'allday'), 'remind.default_time 恢复：入队');
select is(tests.run($$update public.settings set undone = true where id = '5f320000-0000-4000-8000-000000000001'$$), 'ok|' || (select v from want where k = 'allday'), 'remind.default_time 撤销：入队');
select is(tests.run($$update public.settings set undone = false where id = '5f320000-0000-4000-8000-000000000001'$$), 'ok|' || (select v from want where k = 'allday'), 'remind.default_time 取消撤销：入队');
select is(tests.run($$update public.settings set value = '"07:00"', deleted_at = null, undone = false where id = '5f320000-0000-4000-8000-000000000001'$$), 'ok|',
  'remind.default_time 值没变的更新（同步时原样再写一次）：不入队');
select is(tests.run($$insert into public.settings (id, key, value) values ('5f320000-0000-4000-8000-000000000002', 'anniv.default_offsets', '[7, 1]')$$),
  'ok|' || (select v from want where k = 'anniv'), 'anniv.default_offsets 新建：入队');
select is(tests.run($$update public.settings set value = '[3]' where id = '5f320000-0000-4000-8000-000000000002'$$), 'ok|' || (select v from want where k = 'anniv'), 'anniv.default_offsets 改值：入队');
select is(tests.run($$update public.settings set deleted_at = 1 where id = '5f320000-0000-4000-8000-000000000002'$$), 'ok|' || (select v from want where k = 'anniv'), 'anniv.default_offsets 软删：入队（修 P3）');
select is(tests.run($$update public.settings set deleted_at = null where id = '5f320000-0000-4000-8000-000000000002'$$), 'ok|' || (select v from want where k = 'anniv'), 'anniv.default_offsets 恢复：入队（修 P3）');
select is(tests.run($$update public.settings set undone = true where id = '5f320000-0000-4000-8000-000000000002'$$), 'ok|' || (select v from want where k = 'anniv'), 'anniv.default_offsets 撤销：入队（修 P3）');
select is(tests.run($$update public.settings set undone = false where id = '5f320000-0000-4000-8000-000000000002'$$), 'ok|' || (select v from want where k = 'anniv'), 'anniv.default_offsets 取消撤销：入队（修 P3）');
select is(tests.run($$update public.settings set value = '[3]' where id = '5f320000-0000-4000-8000-000000000002'$$), 'ok|',
  'anniv.default_offsets 原样再写：不入队（修 P11）');
select is(tests.run($$insert into public.settings (id, key, value) values ('5f320000-0000-4000-8000-000000000003', 'anniv.default_time', '"08:00"')$$),
  'ok|' || (select v from want where k = 'anniv'), 'anniv.default_time 新建：入队');
select is(tests.run($$update public.settings set value = '"10:00"' where id = '5f320000-0000-4000-8000-000000000003'$$), 'ok|' || (select v from want where k = 'anniv'), 'anniv.default_time 改值：入队');
select is(tests.run($$update public.settings set deleted_at = 1 where id = '5f320000-0000-4000-8000-000000000003'$$), 'ok|' || (select v from want where k = 'anniv'), 'anniv.default_time 软删：入队（修 P3）');
select is(tests.run($$update public.settings set deleted_at = null where id = '5f320000-0000-4000-8000-000000000003'$$), 'ok|' || (select v from want where k = 'anniv'), 'anniv.default_time 恢复：入队（修 P3）');
select is(tests.run($$update public.settings set undone = true where id = '5f320000-0000-4000-8000-000000000003'$$), 'ok|' || (select v from want where k = 'anniv'), 'anniv.default_time 撤销：入队（修 P3）');
select is(tests.run($$update public.settings set undone = false where id = '5f320000-0000-4000-8000-000000000003'$$), 'ok|' || (select v from want where k = 'anniv'), 'anniv.default_time 取消撤销：入队（修 P3）');
select is(tests.run($$update public.settings set value = '"10:00"', deleted_at = null where id = '5f320000-0000-4000-8000-000000000003'$$), 'ok|',
  'anniv.default_time 原样再写：不入队（修 P11）');

-- ③ 别的设置键不入队（改了 value 也不入）
select is(tests.run($$insert into public.settings (id, key, value) values ('5f320000-0000-4000-8000-000000000004', 'remind.show_title', 'false')$$), 'ok|', '新建 remind.show_title：不入队');
select is(tests.run($$update public.settings set value = 'true' where id = '5f320000-0000-4000-8000-000000000004'$$), 'ok|', '改 remind.show_title：不入队');

-- ④ T09 时区采纳、切固定时区：enqueue_floating → remind_enqueue('floating')。没删、没完成、设了提醒、没到点或还没算的全天日程、待办、纪念日入队
--   （纪念日不看是不是用默认）；已推过的（remind_at 已过）、不提醒的、有时刻的日程、删了的、已完成的、没有截止日期的待办、别人的不入。
--   “设了提醒”按 shared/logic/remind.ts 的分支逐个列：待办无时刻看 remind_days（01 入、04 不入），有时刻看 remind_before_min（02 入、03 不入），
--   没有截止日期不提醒（08 不入）；全天日程看 remind_days（01、02 入，03 不入）；纪念日的提醒偏移不会为空数组，没删就算设了
delete from private.remind_queue;
select private.enqueue_floating('aaaaaaaa-0000-4000-8000-000000000001');
select is(tests.q(), 'anniversaries:01,anniversaries:02,anniversaries:06,events:01,events:02,events:08,todos:01,todos:02,todos:07',
  'enqueue_floating：只收没到点或还没算的（修 P16）；纪念日 remind_at 为空也收（修 P3）');
select ok(not has_function_privilege('authenticated', 'private.enqueue_floating(uuid)', 'EXECUTE')
      and not has_function_privilege('service_role', 'private.enqueue_floating(uuid)', 'EXECUTE'), 'create or replace 以后 enqueue_floating 仍不授执行权');
-- 改 tz_mode 到 fixed（tz_fixed_reset 调 enqueue_floating）：同一范围
delete from private.remind_queue;
update public.profiles set current_tz = 'America/New_York' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
update public.profiles set tz_mode = 'fixed' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
select is(tests.q(), 'anniversaries:01,anniversaries:02,anniversaries:06,events:01,events:02,events:08,todos:01,todos:02,todos:07',
  '切固定时区（tz_fixed_reset）：和时区采纳同一范围');

-- ⑤ remind_enqueue 只认五种 scope；不授任何角色
select is(tests.try_as('postgres', null, $$select private.remind_enqueue('bogus', null, null, null, false, 0::smallint)$$), 'P0001 remind_enqueue_scope: bogus',
  'remind_enqueue：不认的 scope 报错');
select is((select (not p.prosecdef)::text || ':' || array_to_string(p.proconfig, ',') || ':' || coalesce(p.proacl::text, '')
   from pg_proc p where p.oid = 'private.remind_enqueue(text, uuid, text, uuid, boolean, smallint)'::regprocedure),
  'true:search_path="":{postgres=X/postgres}', 'remind_enqueue：invoker、search_path 置空、只有属主 postgres 能执行（不授任何角色）');

-- ⑥ 日程“换了哪一次”（原 events_occ_reset，二轮审查 N-M1；R-411 起在 touch() 里调的 remind_reset）：A 用 authenticated 身份编辑；
--    每步之前用 postgres 把三列重新填上。期望逐条照旧
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
select ok(to_regprocedure('private.events_occ_reset()') is null and not exists (select 1 from pg_trigger where tgname = 'events_occ_reset'),
  'events_occ_reset 函数和触发器都已删（判定挪进 remind_reset，不再靠触发器名字排序）');
select tests.mark('e3200000-0000-4000-8000-000000000001');
select is(tests.a($$update public.events set title = '全天 当天（改名）' where id = 'e3200000-0000-4000-8000-000000000001'$$) || '|' ||
  tests.marks('e3200000-0000-4000-8000-000000000001'), 'ok|111|222|444', '只改名称：notified_for、pushed_for、snooze_at 都保留（同一次提醒）');
select is(tests.a($$update public.events set date = '2026-11-06' where id = 'e3200000-0000-4000-8000-000000000001'$$) || '|' ||
  tests.marks('e3200000-0000-4000-8000-000000000001') || '|' ||
  tests.fv_at_rev('e3200000-0000-4000-8000-000000000001'),
  'ok|空|空|空|true',
  '挪日期：三列都清空；fv 里 notified_for、snooze_at 的值等于这次的 rev（remind_reset 在比较 fv 之前跑，三轮审查 R3-L1）');
select tests.mark('e3200000-0000-4000-8000-000000000001');
select is(tests.a($$update public.events set remind_days = 1 where id = 'e3200000-0000-4000-8000-000000000001'$$) || '|' ||
  tests.marks('e3200000-0000-4000-8000-000000000001'), 'ok|空|空|空', '改当天 / 前一天（remind_days）：三列都清空');
select tests.mark('e3200000-0000-4000-8000-000000000001');
select is(tests.a($$update public.events set time = '10:00', tz = 'Asia/Seoul' where id = 'e3200000-0000-4000-8000-000000000001'$$) || '|' ||
  tests.marks('e3200000-0000-4000-8000-000000000001'), 'ok|空|空|空', 'time 从空变有：三列都清空');
select tests.mark('e3200000-0000-4000-8000-000000000004');
select is(tests.a($$update public.events set time = '16:00' where id = 'e3200000-0000-4000-8000-000000000004'$$) || '|' ||
  split_part(tests.marks('e3200000-0000-4000-8000-000000000004'), '|', 1), 'ok|111',
  '有时刻的只改时刻（不是空和非空之间）：不算换了一次，notified_for 保留（pushed_for 照旧按提醒输入变了清）');
select tests.mark('e3200000-0000-4000-8000-000000000002');
select is(tests.a($$update public.events set date = '2026-11-07', notified_for = 333 where id = 'e3200000-0000-4000-8000-000000000002'$$) || '|' ||
  tests.marks('e3200000-0000-4000-8000-000000000002'), 'ok|333|空|空', '同一个补丁里显式写了 notified_for：照客户端的值，pushed_for、snooze_at 照清');
select tests.mark('e3200000-0000-4000-8000-000000000002');
select is(tests.a($$update public.events set date = '2026-11-08', snooze_at = 555 where id = 'e3200000-0000-4000-8000-000000000002'$$) || '|' ||
  tests.marks('e3200000-0000-4000-8000-000000000002'), 'ok|空|空|555', '同一个补丁里显式写了 snooze_at：照客户端的值，notified_for、pushed_for 照清（R3-L2）');

select * from finish();
rollback;
