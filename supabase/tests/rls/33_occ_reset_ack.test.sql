-- B2 迁移 20261104110000_core_occ_reset_ack.sql（接手清单 REMIND-offline-ack-merge，做法 ②）：换了“哪一次提醒”时，
-- 客户端写进来的 notified_for 等于 old.remind_at（旧那一次的时刻）照样清空，写别的值照客户端的保留。
-- 触发器 events_occ_reset 的其余语义（清 snooze_at、pushed_for，执行顺序）在 rls/32 ⑧。A 的写入用 authenticated 身份（带会话）。
begin;
select plan(6);
\ir _helpers.psql
select tests.seed();

create function tests.a(p_sql text) returns text language sql as $$
  select tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', p_sql, null, 'aaaaaaaa-5555-4000-8000-000000000001')
$$;
-- 用 postgres 重置这一行：日期 11-05、当天提醒，remind_at（系统列）、notified_for 按参数
create function tests.reset(p_remind bigint, p_notified bigint) returns void language sql as $$
  update public.events set date = '2026-11-05', remind_days = 0, remind_at = p_remind, notified_for = p_notified
   where id = 'e3300000-0000-4000-8000-000000000001'
$$;
create function tests.nf() returns text language sql as $$
  select coalesce(notified_for::text, '空') from public.events where id = 'e3300000-0000-4000-8000-000000000001'
$$;

insert into public.events (id, user_id, title, date, time, tz, remind_min, remind_days, deleted_at, created_at, updated_at) values
  ('e3300000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '全天', '2026-11-05', null, null, null, 0, null, 1, 1);

select is((select p.prosecdef and p.proconfig = array['search_path=""']
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('anon', p.oid, 'EXECUTE')
   from pg_proc p where p.oid = 'private.events_occ_reset()'::regprocedure),
  true, 'create or replace 以后 events_occ_reset 仍是 security definer、search_path 置空，anon、authenticated 没有执行权');

select tests.reset(1000, null);
select is(tests.a($$update public.events set date = '2026-11-06', notified_for = 1000 where id = 'e3300000-0000-4000-8000-000000000001'$$) || '|' || tests.nf(),
  'ok|空', '离线合并出 {date: 新日期, notified_for: 旧时刻}（等于 old.remind_at）：清空');
select tests.reset(1000, null);
select is(tests.a($$update public.events set remind_days = 1, notified_for = 1000 where id = 'e3300000-0000-4000-8000-000000000001'$$) || '|' || tests.nf(),
  'ok|空', '改当天 / 前一天时合并进来的旧时刻：同样清空');
select tests.reset(1000, null);
select is(tests.a($$update public.events set date = '2026-11-06', notified_for = 2000 where id = 'e3300000-0000-4000-8000-000000000001'$$) || '|' || tests.nf(),
  'ok|2000', '客户端写的是新那一次的时刻（不等于 old.remind_at）：照客户端的保留');
select tests.reset(null, null);
select is(tests.a($$update public.events set date = '2026-11-06', notified_for = 1000 where id = 'e3300000-0000-4000-8000-000000000001'$$) || '|' || tests.nf(),
  'ok|1000', 'old.remind_at 为空（服务器还没算过）：没有可比的旧时刻，照客户端的保留');
select tests.reset(1000, null);
select is(tests.a($$update public.events set title = '全天（改名）', notified_for = 1000 where id = 'e3300000-0000-4000-8000-000000000001'$$) || '|' || tests.nf(),
  'ok|1000', '没换哪一次提醒（只改名称）时按“知道了”：触发器不起作用，照写');

select * from finish();
rollback;
