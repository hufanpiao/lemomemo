-- R-411 迁移 20261113100000_core_remind_queue_rewrite.sql：一行改了要不要入队、要清什么（方案 docs/10-架构/方案-提醒队列重写.md 5.2 T01～T04、T07、T10、T22，
-- 3.3 ①～④）。入队只经 private.remind_enqueue；三张表各一个不带列清单的 after 触发器调 private.enqueue_remind；清列在 touch() 里调的 private.remind_reset。
-- “哪些列算提醒输入”只有 private.table_meta.remind_cols 一份：T01 按它循环，加一列自动多测一条；名单里有、下面的“改成什么值”表里没写的列直接失败。
-- 设置、时区的批量入队在 rls/32，出队在 rls/30，日程“换了哪一次”在 rls/32 ⑥、33。A、B 的写入用 authenticated 身份（带会话）。
begin;
select plan(17);
\ir _helpers.psql
select tests.seed();

create function tests.a(p_sql text) returns text language sql as $$
  select tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', p_sql, null, 'aaaaaaaa-5555-4000-8000-000000000001')
$$;
create function tests.b(p_sql text) returns text language sql as $$
  select tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', p_sql, null, 'bbbbbbbb-5555-4000-8000-000000000002')
$$;
create function tests.q() returns text language sql as $$
  select coalesce(string_agg(table_name || ':' || right(id::text, 2) || ':' || prio || ':' || fresh, ',' order by table_name, id), '') from private.remind_queue
$$;

-- A 的三行：有时刻的日程、有截止时刻的待办、用默认提醒的纪念日
create temp table base (tbl text primary key, id uuid, reset_sql text);
insert into base values
  ('events', 'e4900000-0000-4000-8000-000000000001',
   $$update public.events set date = '2026-11-05', time = '09:00', tz = 'Asia/Seoul', remind_min = 15, remind_days = null, deleted_at = null, snooze_at = null,
       title = 'e', note = '' where id = 'e4900000-0000-4000-8000-000000000001'$$),
  ('todos', 'd4900000-0000-4000-8000-000000000001',
   $$update public.todos set due = '2026-11-05', due_time = '15:00', remind_before_min = 10, remind_days = 0, remind_time = '09:00', done = false, deleted_at = null,
       snooze_at = null, title = 't', note = '' where id = 'd4900000-0000-4000-8000-000000000001'$$),
  ('anniversaries', 'a4900000-0000-4000-8000-000000000001',
   $$update public.anniversaries set kind = 'birthday', calendar = 'solar', lunar_variant = 'cn', month = 3, day = 5, is_leap = false, year = null,
       remind_offsets = null, remind_time = null, after_due = 'archive', deleted_at = null, snooze_at = null, name = 'n', note = '' where id = 'a4900000-0000-4000-8000-000000000001'$$);
insert into public.events (id, user_id, title, date, time, tz, remind_min, created_at, updated_at) values
  ('e4900000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'e', '2026-11-05', '09:00', 'Asia/Seoul', 15, 1, 1);
insert into public.todos (id, user_id, title, due, due_time, remind_before_min, remind_days, created_at, updated_at) values
  ('d4900000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 't', '2026-11-05', '15:00', 10, 0, 1, 1);
insert into public.anniversaries (id, user_id, kind, name, calendar, month, day, created_at, updated_at) values
  ('a4900000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'birthday', 'n', 'solar', 3, 5, 1, 1);

-- ① 新建一律入队、prio 0；待办新建是 fresh（6.3 Q2：第 0 步不传 prevRemindAt，提前量已过时回落到截止时刻）
select is(tests.q(), 'anniversaries:01:0:false,events:01:0:false,todos:01:0:true', '新建：三张表都入队（prio 0），只有待办是 fresh');

-- 每个 remind_cols 列改成什么值（都满足表上的约束；A 有这几列的 update 权限）
create temp table newval (tbl text, col text, v text, primary key (tbl, col));
insert into newval values
  ('events', 'date', $$'2026-11-06'$$), ('events', 'time', $$'10:00'$$), ('events', 'tz', $$'Asia/Tokyo'$$),
  ('events', 'remind_min', '30'), ('events', 'remind_days', '1'), ('events', 'deleted_at', '5'),
  ('todos', 'due', $$'2026-11-06'$$), ('todos', 'due_time', $$'16:00'$$), ('todos', 'remind_before_min', '30'), ('todos', 'remind_days', '1'),
  ('todos', 'remind_time', $$'10:00'$$), ('todos', 'done', 'true'), ('todos', 'deleted_at', '5'),
  ('anniversaries', 'remind_offsets', $${3}$$), ('anniversaries', 'remind_time', $$'08:00'$$), ('anniversaries', 'month', '4'),
  ('anniversaries', 'day', '6'), ('anniversaries', 'calendar', $$'lunar'$$), ('anniversaries', 'lunar_variant', $$'kr'$$),
  ('anniversaries', 'is_leap', 'true'), ('anniversaries', 'year', '2000'), ('anniversaries', 'after_due', $$'yearly'$$),
  ('anniversaries', 'kind', $$'countdown'$$), ('anniversaries', 'deleted_at', '5');
update newval set v = quote_literal(v) where tbl = 'anniversaries' and col = 'remind_offsets';

-- 把一行恢复成 base、再填上 pushed_for = 1、defer_until = 2、清队列；然后以 A 的身份跑一句，返回“结果|队列|pushed_for|defer_until”
create function tests.try_col(p_tbl text, p_sql text) returns text language plpgsql as $$
declare b record; r text; pf text; du text;
begin
  select * into b from base where tbl = p_tbl;
  execute b.reset_sql;   -- 先恢复提醒输入（这一句本身会清 pushed_for、defer_until），再单独填上两列（只写系统列，不入队、不清）
  execute format('update public.%I set pushed_for = 1, defer_until = 2 where id = %L', p_tbl, b.id);
  delete from private.remind_queue;
  r := tests.a(p_sql);
  execute format('select coalesce(pushed_for::text, ''空''), coalesce(defer_until::text, ''空'') from public.%I where id = %L', p_tbl, b.id) into pf, du;
  return r || '|' || tests.q() || '|' || pf || '|' || du;
end $$;
create function tests.upd(p_tbl text, p_set text) returns text language sql as $$
  select format('update public.%I set %s where id = %L', p_tbl, p_set, (select id from base where tbl = p_tbl))
$$;
create function tests.one(p_tbl text, p_fresh boolean) returns text language sql as $$
  select p_tbl || ':01:0:' || p_fresh
$$;

-- ② T01：remind_cols 每一列改值都入队（prio 0），并清 pushed_for、defer_until。按 table_meta.remind_cols 循环，名单为空、少写了改成什么值都失败
select is((select string_agg(m.tbl, ',' order by m.tbl) from private.table_meta m where cardinality(m.remind_cols) > 0),
  'anniversaries,events,todos', 'table_meta：三张提醒表的 remind_cols 都不为空，别的表都为空');
select is((select count(*)::int from private.table_meta m cross join lateral unnest(m.remind_cols) c left join newval n on n.tbl = m.tbl and n.col = c where n.v is null), 0,
  'T01 的“改成什么值”表覆盖了 remind_cols 的每一列（以后加一列忘了补这里就失败）');
select is((select string_agg(m.tbl || '.' || c || '=' || tests.try_col(m.tbl, tests.upd(m.tbl, format('%I = %s', c, n.v))), ',' order by m.tbl, c)
   from private.table_meta m cross join lateral unnest(m.remind_cols) c join newval n on n.tbl = m.tbl and n.col = c),
  (select string_agg(m.tbl || '.' || c || '=ok|' || tests.one(m.tbl, m.tbl = 'todos' and c in ('due', 'due_time', 'remind_before_min')) || '|空|空', ',' order by m.tbl, c)
     from private.table_meta m, unnest(m.remind_cols) c),
  'T01：remind_cols 的 24 列逐列改值：都入队、prio 0，都清 pushed_for、defer_until；待办只有改截止日期、截止时刻、提前量是 fresh');
select is((select count(*)::int from private.table_meta m, unnest(m.remind_cols) c), 24, 'remind_cols 现在共 24 列（日程 6、待办 7、纪念日 11）');

-- ③ snooze_at：三张表都只入队、不清（“稍后”是同一次提醒）
select is((select string_agg(b.tbl || '=' || tests.try_col(b.tbl, tests.upd(b.tbl, 'snooze_at = 1800000000000')), ',' order by b.tbl) from base b),
  'anniversaries=ok|anniversaries:01:0:false|1|2,events=ok|events:01:0:false|1|2,todos=ok|todos:01:0:false|1|2',
  'snooze_at 变了：三张表都入队，pushed_for、defer_until 都不清');

-- ④ T02：改不在名单里的列（标题、备注、名字）：不入队、不清
select is((select string_agg(b.tbl || '=' || tests.try_col(b.tbl, tests.upd(b.tbl, case b.tbl when 'anniversaries' then $$name = 'n2', note = 'x'$$
      else $$title = 'x2', note = 'x'$$ end)), ',' order by b.tbl) from base b),
  'anniversaries=ok||1|2,events=ok||1|2,todos=ok||1|2', 'T02：改标题、备注：不入队、不清');

-- ⑤ T04：原样再写一次（同步时整行写回）：不入队、不清
select is((select string_agg(b.tbl || '=' || tests.try_col(b.tbl, tests.upd(b.tbl, case b.tbl
      when 'events' then 'date = date, time = time, tz = tz, remind_min = remind_min, deleted_at = deleted_at, snooze_at = snooze_at'
      when 'todos' then 'due = due, due_time = due_time, remind_before_min = remind_before_min, done = done, snooze_at = snooze_at'
      else 'remind_offsets = remind_offsets, month = month, kind = kind, snooze_at = snooze_at' end)), ',' order by b.tbl) from base b),
  'anniversaries=ok||1|2,events=ok||1|2,todos=ok||1|2', 'T04：值没变的写：不入队、不清');

-- ⑥ T03：push-dispatch 的系统写（service_role 写 remind_at、next_date、pushed_for、defer_until）：不入队、不清、rev 不变
create function tests.sys(p_tbl text) returns text language plpgsql as $$
declare b record; rev0 int; rev1 int; r text;
begin
  select * into b from base where tbl = p_tbl;
  execute b.reset_sql;
  delete from private.remind_queue;
  execute format('select rev from public.%I where id = %L', p_tbl, b.id) into rev0;
  r := tests.try_as('service_role', null, format('update public.%I set remind_at = 1700000000000, pushed_for = 3, defer_until = 4%s where id = %L',
         p_tbl, case when p_tbl = 'anniversaries' then ', next_date = ''2027-03-05''' else '' end, b.id));
  execute format('select rev from public.%I where id = %L', p_tbl, b.id) into rev1;
  return r || '|' || tests.q() || '|' || (rev1 = rev0)::text;
end $$;
select is((select string_agg(b.tbl || '=' || tests.sys(b.tbl), ',' order by b.tbl) from base b),
  'anniversaries=ok||true,events=ok||true,todos=ok||true', 'T03：service_role 写 remind_at、next_date、pushed_for、defer_until：不入队、rev 不变');
select is((select string_agg(coalesce(pushed_for::text, '空') || '/' || coalesce(defer_until::text, '空'), ',') from public.todos where id = 'd4900000-0000-4000-8000-000000000001'),
  '3/4', '系统写的 pushed_for、defer_until 照写（不会被 remind_reset 清掉）');

-- ⑦ T07：没有名字顺序依赖。三张表各只有一个执行 enqueue_remind 的 after 触发器，没有提醒相关的 before 触发器；touch() 里不再自己清 pushed_for
select is((select string_agg(c.relname || ':' || t.tgname, ',' order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where t.tgfoid = 'private.enqueue_remind()'::regprocedure and (t.tgtype & 2) = 0 and (t.tgtype & 4) = 4 and (t.tgtype & 16) = 16
     and cardinality(t.tgattr::int2[]) = 0),
  'anniversaries:anniversaries_remind,events:events_remind,todos:todos_remind', 'T07：三张表各一个 <表>_remind：after insert or update、不带列清单');
select is((select coalesce(string_agg(c.relname || ':' || t.tgname, ',' order by c.relname, t.tgname), '') from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where c.relname in ('events', 'todos', 'anniversaries') and c.relnamespace = 'public'::regnamespace and not t.tgisinternal
     and (t.tgtype & 2) = 2 and t.tgname not in ('events_touch', 'events_quota', 'todos_touch', 'todos_quota', 'anniversaries_touch', 'anniversaries_quota')),
  '', 'T07：三张表上除 touch、配额外没有别的 before 触发器（events_occ_reset 已删）');
select is((select (prosrc !~ 'pushed_for')::text || ':' || (length(prosrc) - length(replace(prosrc, 'private.remind_reset(', ''))) / length('private.remind_reset(')
   from pg_proc where oid = 'private.touch()'::regprocedure), 'true:1', 'T07：touch() 源码里不再有 pushed_for，只调一次 remind_reset');

-- ⑧ T10：安全，塞别人的队列。B 用 insert … on conflict (id) do nothing 插 A 的待办 id：A 的项（正被租着）claim、attempts、prio、user_id 都不变；
--    B 用 on conflict (id) do update 落到 A 的行上被 RLS 拦下；A 本人重发同一条 insert（客户端新建的写法）也不入队
delete from private.remind_queue;
insert into private.remind_queue (table_name, id, user_id, claim, claimed_at, attempts, prio)
  values ('todos', 'd4900000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'c4900000-0000-4000-8000-000000000001', now(), 2, 1);
create function tests.qa() returns text language sql as $$
  select coalesce(string_agg(left(user_id::text, 8) || ':' || coalesce(right(claim::text, 2), '空') || ':' || attempts || ':' || prio, ','), '')
    from private.remind_queue
$$;
select is(tests.b($$insert into public.todos (id, title, due, created_at, updated_at) values ('d4900000-0000-4000-8000-000000000001', 'B 的', '2026-12-01', 1, 1)
    on conflict (id) do nothing$$) || '|' || tests.qa(), 'ok|aaaaaaaa:01:2:1', 'T10：B 插 A 的 id（do nothing）：队列不多一行，A 的项租约、次数、prio、主人都不变');
select is(left(tests.b($$insert into public.todos (id, title, created_at, updated_at) values ('d4900000-0000-4000-8000-000000000001', 'B 的', 1, 1)
    on conflict (id) do update set title = 'B 改'$$), 5) || '|' || tests.qa(), '42501|aaaaaaaa:01:2:1', 'B 插 A 的 id（do update）：被 RLS 拦下，队列不变');
select is(tests.a($$insert into public.todos (id, title, created_at, updated_at) values ('d4900000-0000-4000-8000-000000000001', 't', 1, 1)
    on conflict (id) do nothing$$) || '|' || tests.qa(), 'ok|aaaaaaaa:01:2:1', 'A 本人重发同一条新建：撞主键不触发，不入队');

-- ⑨ T22：规则版本全量重算 remind_enqueue('all', …, N)：全站设了提醒的日程（有时刻的也收）、待办收日期没过两天以上的，纪念日不看时间；
--   min_ver 取大、prio 按 24 小时分 1、2（口径在迁移 remind_enqueue 的注释上，11-13 整块评审必改 1、建议 2）
delete from private.remind_queue;
update public.events set remind_at = 1000 where id = 'e4900000-0000-4000-8000-000000000001';   -- 日期 2026-11-05 早过了、已推过：不收
insert into public.events (id, user_id, title, date, time, tz, remind_min, remind_days, created_at, updated_at) values
  ('e4900000-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002', 'B 有时刻 没算', current_date + 30, '09:00', 'Asia/Seoul', 15, null, 1, 1),
  ('e4900000-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000002', 'B 有时刻 不提醒', current_date + 30, '09:00', 'Asia/Seoul', null, null, 1, 1),
  ('e4900000-0000-4000-8000-000000000004', 'bbbbbbbb-0000-4000-8000-000000000002', 'B 全天 远期', current_date + 30, null, null, null, 0, 1, 1);
update public.events set remind_at = 9999999999999 where id = 'e4900000-0000-4000-8000-000000000004';
update public.todos set due = current_date + 1 where id = 'd4900000-0000-4000-8000-000000000001';
update public.todos set remind_at = (extract(epoch from now()) * 1000)::bigint + 3600000 where id = 'd4900000-0000-4000-8000-000000000001';   -- 一小时后：prio 1
update public.anniversaries set deleted_at = 5 where id = 'a4900000-0000-4000-8000-000000000001';   -- 删了：不收
delete from private.remind_queue;
insert into private.remind_queue (table_name, id, user_id, min_ver) values ('todos', 'd4900000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 5);
select private.remind_enqueue('all', null, null, null, false, 2::smallint);
select is((select string_agg(table_name || ':' || right(id::text, 2) || ':' || left(user_id::text, 8) || ':' || prio || ':' || min_ver, ',' order by table_name, id) from private.remind_queue),
  'events:02:bbbbbbbb:1:2,events:04:bbbbbbbb:2:2,todos:01:aaaaaaaa:0:5',
  'T22：all 收 B 没算的有时刻日程（prio 1）、B 远期的全天日程（prio 2）；日期早过了的、不提醒的、删了的不收；已在队列里的 prio 取小（0）、min_ver 取大（5）');

select * from finish();
rollback;
