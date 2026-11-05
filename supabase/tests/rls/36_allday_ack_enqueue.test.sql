-- B2 迁移 20261105120000_core_allday_ack_enqueue.sql（REMIND-shown-persist S1，11-05 主持人定修；方案 docs/03-评审/B2/B2-方案-提醒响过持久化.md 第 7 节）：
-- 全天日程改了 remind.default_time 以后 R-336 把 remind_at 压在旧时刻，客户端“知道了”写的是本机现算的新时刻，notified_for ≠ remind_at，
-- 这一行又不在 remind_queue 里，第 0 步不会再看它，resolve 永远不成立。触发器 events_allday_ack_enqueue：全天日程（time 为空、没删）
-- 的 notified_for 改成了一个不等于 remind_at 的值时，照 events_remind 的入口（private.enqueue_remind）入队；第 0 步遇到 notified_for 正好等于
-- 新算出的 remind_at 就写回（tests/edge/push-dispatch-allday-ack.test.ts）。A 的写入用 authenticated 身份（带会话）。
begin;
select plan(12);
\ir _helpers.psql
select tests.seed();

create function tests.a(p_sql text) returns text language sql as $$
  select tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', p_sql, null, 'aaaaaaaa-5555-4000-8000-000000000001')
$$;
create function tests.q() returns text language sql as $$
  select coalesce(string_agg(table_name || ':' || id::text || ':' || coalesce(claim::text, '-') || ':' || attempts, ',' order by table_name, id), '')
    from private.remind_queue where id::text like 'e36%'
$$;
-- 用 postgres 重置：全天、当天提醒，remind_at = pushed_for = 1000（07:00 推过、R-336 压住），notified_for 空，清队列
create function tests.reset(p_time text default null, p_deleted bigint default null) returns void language sql as $$
  update public.events set time = p_time, tz = case when p_time is null then null else 'Asia/Seoul' end, remind_days = 0,
         remind_at = 1000, pushed_for = 1000, notified_for = null, deleted_at = p_deleted
   where id = 'e3600000-0000-4000-8000-000000000001';
  delete from private.remind_queue where id::text like 'e36%';
$$;
create function tests.ack(p_v text) returns text language sql as $$
  select tests.a(format('update public.events set notified_for = %s where id = %L', p_v, 'e3600000-0000-4000-8000-000000000001')) || '|' || tests.q()
$$;

insert into public.events (id, user_id, title, date, time, tz, remind_min, remind_days, deleted_at, created_at, updated_at) values
  ('e3600000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '全天', '2026-11-05', null, null, null, 0, null, 1, 1);

-- ① 结构：after update of notified_for、每行、复用 private.enqueue_remind（不新建入队函数，D1 的 remind-lease 检查不用改）
select is((select t.tgfoid = 'private.enqueue_remind()'::regprocedure and t.tgenabled = 'O'
      and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 0 and (t.tgtype & 16) = 16
      and (select array_agg(a.attname::text) from pg_attribute a where a.attrelid = t.tgrelid and a.attnum = any(t.tgattr)) = array['notified_for']
   from pg_trigger t where t.tgrelid = 'public.events'::regclass and t.tgname = 'events_allday_ack_enqueue'),
  true, 'events_allday_ack_enqueue：after update of notified_for、for each row、执行 private.enqueue_remind');

-- ② 复现：改了默认时刻以后按“知道了”，写的是本机现算的新时刻
select tests.reset();
select is(tests.ack('2000'), 'ok|events:e3600000-0000-4000-8000-000000000001:-:0',
  '全天日程 notified_for 写成不等于 remind_at 的值：入 remind_queue（第 0 步重算后写回，resolve 才成立）');

-- ③～⑦ 不入队的情况
select tests.reset();
select is(tests.ack('1000'), 'ok|', 'notified_for 等于 remind_at（照常的“知道了”）：不入队，resolve 本来就成立');
select tests.reset();
update public.events set notified_for = 2000 where id = 'e3600000-0000-4000-8000-000000000001';
delete from private.remind_queue where id::text like 'e36%';
select is(tests.a($$update public.events set title = '全天（改名）', notified_for = 2000 where id = 'e3600000-0000-4000-8000-000000000001'$$) || '|' || tests.q(),
  'ok|', '整行写回、notified_for 没变：不入队');
select tests.reset();
update public.events set notified_for = 2000 where id = 'e3600000-0000-4000-8000-000000000001';
delete from private.remind_queue where id::text like 'e36%';
select is(tests.ack('null'), 'ok|', 'notified_for 改成空：不入队');
select tests.reset('09:00');
select is(tests.ack('2000'), 'ok|', '有时刻的日程：不入队（R-336 只管全天日程，有时刻的按 tag 精确比）');
select tests.reset(null, 5);
select is(tests.ack('2000'), 'ok|', '已删的行：不入队');

-- ⑧ 正被租着、取过的项：照 enqueue_remind 的语义清租约、attempts 清零（迁移 20261104130000 ④）
select tests.reset();
insert into private.remind_queue (table_name, id, claim, claimed_at, attempts)
  values ('events', 'e3600000-0000-4000-8000-000000000001', 'e3600000-9999-4000-8000-000000000001', now(), 2);
select is(tests.ack('2000'), 'ok|events:e3600000-0000-4000-8000-000000000001:-:0', '已在队列里、正被租着：清租约、attempts 清零（按新值再算一次）');

-- ⑨ 和 events_occ_reset 一起：挪日期时合并进来的 notified_for 被清空，这条触发器看的是清空后的值（不入队；挪日期本身由 events_remind 入队）
select tests.reset();
select is(tests.a($$update public.events set date = '2026-11-06', notified_for = 1000 where id = 'e3600000-0000-4000-8000-000000000001'$$)
    || '|' || (select coalesce(notified_for::text, '空') from public.events where id = 'e3600000-0000-4000-8000-000000000001'),
  'ok|空', '挪日期 + 旧时刻：events_occ_reset 先清空 notified_for');
select is((select count(*)::int from private.remind_queue where id::text like 'e36%'), 1, '只有一项（events_remind 入的），不重复');

-- ⑩ 别人的行：RLS 照旧，A 改不到 B 的行，也就不会替 B 入队
insert into public.events (id, user_id, title, date, time, tz, remind_min, remind_days, deleted_at, created_at, updated_at) values
  ('e3600000-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002', 'B 的全天', '2026-11-05', null, null, null, 0, null, 1, 1);
update public.events set remind_at = 1000 where id = 'e3600000-0000-4000-8000-000000000002';
delete from private.remind_queue where id::text like 'e36%';
select is(tests.a($$update public.events set notified_for = 2000 where id = 'e3600000-0000-4000-8000-000000000002'$$) || '|' || tests.q(),
  'ok|', 'A 改 B 的行：RLS 下更新 0 行，不入队');

-- ⑪ 不提醒的全天日程（remind_days 为空）：按知道了（或整行写回带了 notified_for）不入队（11-05 安全审查 A1）
select tests.reset();
update public.events set remind_days = null where id = 'e3600000-0000-4000-8000-000000000001';
delete from private.remind_queue where id::text like 'e36%';
select is(tests.ack('2000'), 'ok|', '不提醒的全天日程写 notified_for：不入队');

select * from finish();
rollback;
