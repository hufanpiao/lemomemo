-- 清系统列三方对照（REMIND-shown-persist 方案修订 1 第 3 节 ③、复审 L6～L8，11-05 后端）：
-- 每条向量 = 表、原行（old）、实际落库的列（applied），看真库 UPDATE 经 events_occ_reset、touch() 以后 pushed_for、defer_until、notified_for、snooze_at
-- （待办另看 due_time、remind_before_min）。同一份向量由 tests/shared/server-reset.test.ts 逐行读出，跑 shared/logic/server-reset.ts 的
-- mergeWithServerResets 和替身 tests/edge/push-dispatch-mem.ts 的 edit()，结果必须和这里写的期望一字不差——纯函数、替身、SQL 三方一致。
-- 向量行的格式必须是一行一条：select is(tests.r38('表', '原行 JSON', '落库列 JSON'), '期望', '说明');（JSON 里不许有单引号）
-- 原行不写的列取 tests.r38 的默认值（TS 那边用同一组默认值）；补丁要改的列，原行里一定写明原值。
-- 审查 S3：SQL 插入时没写的列取表的默认值（如待办 done 是 false），TS 那边没写的列按 null 算；所以补丁里不许把一列写成表的默认值，
--   除非原行里写明了这一列（不然 SQL 判“没变”、TS 判“变了”，三方对不上）。
begin;
\ir _helpers.psql
select plan(48);
select tests.seed();

create function tests.r38_base(p_tbl text) returns jsonb language sql as $$
  select case p_tbl
    when 'events' then '{"title":"测","date":"2026-11-05","remind_days":0,"created_at":1,"updated_at":1}'::jsonb
    when 'todos' then '{"title":"测","created_at":1,"updated_at":1}'::jsonb
    else '{"kind":"birthday","name":"测","calendar":"solar","month":3,"day":5,"created_at":1,"updated_at":1}'::jsonb end
$$;
create function tests.r38(p_tbl text, p_old jsonb, p_applied jsonb) returns text language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
  v_old jsonb := tests.r38_base(p_tbl) || p_old || jsonb_build_object('id', v_id, 'user_id', 'aaaaaaaa-0000-4000-8000-000000000001');
  v_cols text;
  v_set text;
  r jsonb;
begin
  select string_agg(quote_ident(k), ',') into v_cols from jsonb_object_keys(v_old) k;
  execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)', p_tbl, v_cols, v_cols, p_tbl) using v_old;
  select string_agg(quote_ident(k), ',') into v_set from jsonb_object_keys(p_applied) k;
  execute format('update public.%I t set (%s) = (select %s from jsonb_populate_record(t, $1)) where id = $2', p_tbl, v_set, v_set, p_tbl) using p_applied, v_id;
  execute format('select to_jsonb(t) from public.%I t where id = $1', p_tbl) into r using v_id;
  return concat_ws(' ',
    'p=' || coalesce(r->>'pushed_for', '空'), 'd=' || coalesce(r->>'defer_until', '空'),
    'n=' || coalesce(r->>'notified_for', '空'), 's=' || coalesce(r->>'snooze_at', '空'),
    case when p_tbl = 'todos' then 'dt=' || coalesce(r->>'due_time', '空') end,
    case when p_tbl = 'todos' then 'rb=' || coalesce(r->>'remind_before_min', '空') end);
end $$;

-- 日程：换了“哪一次”（events_occ_reset）
select is(tests.r38('events', '{"pushed_for":1000,"defer_until":900,"notified_for":1000,"snooze_at":1100,"remind_at":1000}', '{"date":"2026-11-06"}'), 'p=空 d=空 n=空 s=空', '挪日期：四列都清');
select is(tests.r38('events', '{"pushed_for":1000,"notified_for":1000,"snooze_at":1100,"remind_at":1000}', '{"date":"2026-11-06","notified_for":1000,"snooze_at":1100}'), 'p=空 d=空 n=空 s=空', 'L6：挪日期且显式写了原值，照样清');
select is(tests.r38('events', '{"pushed_for":1000,"notified_for":null,"remind_at":1000}', '{"date":"2026-11-06","notified_for":1000}'), 'p=空 d=空 n=空 s=空', '挪日期时把 notified_for 写成原 remind_at（离线合并来的旧知道了）：清');
select is(tests.r38('events', '{"pushed_for":1000,"notified_for":null,"snooze_at":null,"remind_at":1000}', '{"date":"2026-11-06","notified_for":5000,"snooze_at":6000}'), 'p=空 d=空 n=5000 s=6000', '挪日期且改成了新值：留新值，pushed_for 清');
select is(tests.r38('events', '{"pushed_for":1000,"notified_for":1000,"remind_at":null}', '{"date":"2026-11-06","notified_for":2000}'), 'p=空 d=空 n=2000 s=空', 'remind_at 为空时不按原 remind_at 清');
select is(tests.r38('events', '{"pushed_for":1000,"notified_for":1000,"remind_at":1000,"remind_days":0}', '{"remind_days":1}'), 'p=空 d=空 n=空 s=空', 'remind_days 0→1：清');
select is(tests.r38('events', '{"pushed_for":1000,"notified_for":1000,"remind_at":1000,"remind_days":0}', '{"remind_days":null}'), 'p=空 d=空 n=空 s=空', 'remind_days 0→空：清');
select is(tests.r38('events', '{"pushed_for":1000,"notified_for":1000,"remind_at":1000,"time":"09:00","tz":"Asia/Seoul"}', '{"time":null,"tz":null}'), 'p=空 d=空 n=空 s=空', '有时刻改全天：清');
select is(tests.r38('events', '{"pushed_for":1000,"notified_for":1000,"snooze_at":1100,"remind_at":1000,"time":"09:00","tz":"Asia/Seoul"}', '{"time":"10:00"}'), 'p=空 d=空 n=1000 s=1100', '只改时刻（都非空）：不算换一次，只按 touch 清 pushed_for、defer_until');
select is(tests.r38('events', '{"pushed_for":1000,"defer_until":900,"notified_for":1000,"snooze_at":1100,"remind_at":1000,"date":"2026-11-05"}', '{"date":"2026-11-05","remind_days":0}'), 'p=1000 d=900 n=1000 s=1100', '显式写了原日期、原 remind_days：值没变，什么都不清');
select is(tests.r38('events', '{"pushed_for":1000,"defer_until":900,"notified_for":1000,"snooze_at":1100,"remind_at":1000}', '{"title":"改名"}'), 'p=1000 d=900 n=1000 s=1100', '只改标题：不清');
select is(tests.r38('events', '{"pushed_for":1000,"defer_until":900,"notified_for":null,"remind_at":1000}', '{"notified_for":1000}'), 'p=1000 d=900 n=1000 s=空', '只按知道了：不清');
select is(tests.r38('events', '{"pushed_for":1000,"defer_until":900,"remind_at":1000,"date":"2026-11-05"}', '{"title":"服务器只收了标题"}'), 'p=1000 d=900 n=空 s=空', 'L7：forked 时只有标题落库（日期没落库），不按 sent.data 的日期清');
select is(tests.r38('events', '{"pushed_for":1000,"defer_until":900,"remind_at":1000}', '{"tz":"Asia/Tokyo"}'), 'p=空 d=空 n=空 s=空', '改 tz（touch 的提醒列）：清 pushed_for、defer_until');
select is(tests.r38('events', '{"pushed_for":1000,"defer_until":900,"notified_for":1000,"remind_at":1000}', '{"deleted_at":5}'), 'p=空 d=空 n=1000 s=空', '删除：清 pushed_for、defer_until');
select is(tests.r38('events', '{"pushed_for":1000,"defer_until":900,"remind_at":1000,"remind_min":15}', '{"remind_min":15}'), 'p=1000 d=900 n=空 s=空', '显式写了原 remind_min：不清');

-- 待办（touch()）
select is(tests.r38('todos', '{"due":"2026-11-05","due_time":"08:00","remind_before_min":10,"pushed_for":1000,"defer_until":900,"notified_for":1000}', '{"due":null}'), 'p=空 d=空 n=1000 s=空 dt=空 rb=空', '待办清空截止日期：连带清截止时刻、提前分钟，清 pushed_for、defer_until');
select is(tests.r38('todos', '{"due":"2026-11-05","due_time":"08:00","remind_before_min":10,"pushed_for":1000,"defer_until":900}', '{"done":true}'), 'p=空 d=空 n=空 s=空 dt=08:00 rb=10', '待办做完：清 pushed_for、defer_until');
select is(tests.r38('todos', '{"due":"2026-11-05","due_time":"08:00","remind_before_min":10,"pushed_for":1000,"defer_until":900}', '{"title":"改名","due":"2026-11-05"}'), 'p=1000 d=900 n=空 s=空 dt=08:00 rb=10', '待办改名、显式写了原截止日期：不清');
select is(tests.r38('todos', '{"due":"2026-11-05","due_time":"08:00","pushed_for":1000,"defer_until":900}', '{"due":"2026-11-06"}'), 'p=空 d=空 n=空 s=空 dt=08:00 rb=空', '待办改截止日期：清；日程的换一次规则不管待办（snooze_at 不动）');
select is(tests.r38('todos', '{"due":"2026-11-05","snooze_at":1100,"pushed_for":1000}', '{"due":"2026-11-06"}'), 'p=空 d=空 n=空 s=1100 dt=空 rb=空', '待办改截止日期：snooze_at 照留');

-- 纪念日（touch() 的那一组列）
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900,"month":3}', '{"month":4}'), 'p=空 d=空 n=空 s=空', '纪念日改月份：清');
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900,"remind_offsets":[0,1]}', '{"remind_offsets":[0,1]}'), 'p=1000 d=900 n=空 s=空', '纪念日显式写了原 remind_offsets（数组同值）：不清');
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900,"remind_offsets":[0,1]}', '{"remind_offsets":[0,3]}'), 'p=空 d=空 n=空 s=空', '纪念日改 remind_offsets：清');
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900,"notified_for":1000}', '{"name":"改名","note":"备注"}'), 'p=1000 d=900 n=1000 s=空', '纪念日改名、备注：不清');
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900}', '{"calendar":"lunar","lunar_variant":"cn"}'), 'p=空 d=空 n=空 s=空', '纪念日改历法：清');

-- M4（11-05 审查）：touch() 那 20 列里原来没有向量的 10 列各补一条“只改这一列就清”，可空的列再补“空改成值”“值改成空”
select is(tests.r38('events', '{"pushed_for":1000,"defer_until":900,"remind_min":15}', '{"remind_min":30}'), 'p=空 d=空 n=空 s=空', 'M4：remind_min 15→30：清');
select is(tests.r38('events', '{"pushed_for":1000,"defer_until":900,"remind_min":null}', '{"remind_min":15}'), 'p=空 d=空 n=空 s=空', 'M4：remind_min 空→15：清');
select is(tests.r38('events', '{"pushed_for":1000,"defer_until":900,"remind_min":15}', '{"remind_min":null}'), 'p=空 d=空 n=空 s=空', 'M4：remind_min 15→空：清');
select is(tests.r38('todos', '{"due":"2026-11-05","due_time":"08:00","remind_before_min":10,"pushed_for":1000,"defer_until":900}', '{"due_time":"09:00"}'), 'p=空 d=空 n=空 s=空 dt=09:00 rb=10', 'M4：待办 due_time 改值：清');
select is(tests.r38('todos', '{"due":"2026-11-05","due_time":null,"remind_before_min":10,"pushed_for":1000,"defer_until":900}', '{"due_time":"08:00"}'), 'p=空 d=空 n=空 s=空 dt=08:00 rb=10', 'M4：待办 due_time 空→值：清');
select is(tests.r38('todos', '{"due":"2026-11-05","due_time":"08:00","remind_before_min":10,"pushed_for":1000,"defer_until":900}', '{"due_time":null}'), 'p=空 d=空 n=空 s=空 dt=空 rb=10', 'M4：待办 due_time 值→空：清');
select is(tests.r38('todos', '{"due":"2026-11-05","due_time":"08:00","remind_before_min":10,"pushed_for":1000,"defer_until":900}', '{"remind_before_min":30}'), 'p=空 d=空 n=空 s=空 dt=08:00 rb=30', 'M4：待办 remind_before_min 改值：清');
select is(tests.r38('todos', '{"due":"2026-11-05","due_time":"08:00","remind_before_min":null,"pushed_for":1000,"defer_until":900}', '{"remind_before_min":10}'), 'p=空 d=空 n=空 s=空 dt=08:00 rb=10', 'M4：待办 remind_before_min 空→值：清');
select is(tests.r38('todos', '{"due":"2026-11-05","due_time":"08:00","remind_before_min":10,"pushed_for":1000,"defer_until":900}', '{"remind_before_min":null}'), 'p=空 d=空 n=空 s=空 dt=08:00 rb=空', 'M4：待办 remind_before_min 值→空：清');
select is(tests.r38('todos', '{"due":"2026-11-05","due_time":"08:00","remind_before_min":10,"pushed_for":1000,"defer_until":900,"remind_time":"09:00"}', '{"remind_time":"10:00"}'), 'p=空 d=空 n=空 s=空 dt=08:00 rb=10', 'M4：待办 remind_time 改值：清');
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900,"day":5}', '{"day":6}'), 'p=空 d=空 n=空 s=空', 'M4：纪念日 day 改值：清');
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900,"calendar":"lunar","lunar_variant":"cn"}', '{"lunar_variant":"kr"}'), 'p=空 d=空 n=空 s=空', 'M4：纪念日只改 lunar_variant：清');
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900,"calendar":"lunar","is_leap":false}', '{"is_leap":true}'), 'p=空 d=空 n=空 s=空', 'M4：纪念日 is_leap 改值：清');
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900,"year":null}', '{"year":1990}'), 'p=空 d=空 n=空 s=空', 'M4：纪念日 year 空→值：清');
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900,"year":1990}', '{"year":null}'), 'p=空 d=空 n=空 s=空', 'M4：纪念日 year 值→空：清');
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900,"after_due":"archive"}', '{"after_due":"yearly"}'), 'p=空 d=空 n=空 s=空', 'M4：纪念日 after_due 改值：清');
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900,"kind":"birthday"}', '{"kind":"anniversary"}'), 'p=空 d=空 n=空 s=空', 'M4：纪念日 kind 改值：清');
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900,"remind_time":null}', '{"remind_time":"08:00"}'), 'p=空 d=空 n=空 s=空', 'M4：纪念日 remind_time 空→值：清');
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900,"remind_time":"08:00"}', '{"remind_time":null}'), 'p=空 d=空 n=空 s=空', 'M4：纪念日 remind_time 值→空：清');
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900,"remind_time":"08:00"}', '{"remind_time":"09:00"}'), 'p=空 d=空 n=空 s=空', 'M4：纪念日 remind_time 改值：清');
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900,"remind_offsets":null}', '{"remind_offsets":[0]}'), 'p=空 d=空 n=空 s=空', 'M4：纪念日 remind_offsets 空→值：清');
select is(tests.r38('anniversaries', '{"pushed_for":1000,"defer_until":900,"remind_offsets":[0,1]}', '{"remind_offsets":null}'), 'p=空 d=空 n=空 s=空', 'M4：纪念日 remind_offsets 值→空：清');

select * from finish();
rollback;
