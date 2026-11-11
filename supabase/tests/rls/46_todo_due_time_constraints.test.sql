-- TC-B2-73（B2 QA 缺口 G-04）：todos.due_time、remind_before_min 的库约束和改时刻后 remind_queue 重写（迁移 0002_calendar_todos.sql 第 69～73 行、
-- 20261104130000_core_remind_queue_lease.sql ④）。22_text_constraints 只测了 remind_time，这里补 due_time 和 remind_before_min：
-- ① due_time = 17:00、due 为空：被表级约束 todos_check 拒（有时刻必须有日期）；
-- ② due_time = 24:00、7:00（少一位）、17:60：都被 todos_due_time_check 拒；边界 00:00、23:59 通过；
-- ③ remind_before_min = 15、-1：被 todos_remind_before_min_check 拒；白名单 0、10、30、60、120、1440 逐项通过；
-- ④ 合法的 due_time 加 remind_before_min = 60 insert 成功，再 update 成 30 成功；update 成 -1、due_time 改成 24:00 被拒、行不变；
-- ⑤ 改 due_time、remind_before_min 都让 enqueue_remind 把这一条重新放进 remind_queue；已被 push-dispatch 租着的项清租约、attempts 清零（按新时刻重算）。
-- 写入一律以 A 的 authenticated 身份（同 REST 的写法：只写带上的列）。
begin;
select plan(25);
\ir _helpers.psql
select tests.seed();

create function tests.ins(p_row jsonb) returns text language plpgsql as $$
declare cols text := (select string_agg(quote_ident(k), ',') from jsonb_object_keys(p_row) k);
begin
  return tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
    format('insert into public.todos (%s) select %s from jsonb_populate_record(null::public.todos, %L::jsonb)', cols, cols, p_row));
end $$;
create function tests.todo(p jsonb) returns text language sql as $$
  select tests.ins(jsonb_build_object('id', gen_random_uuid(), 'title', 't', 'created_at', 0, 'updated_at', 0) || p) $$;
create function tests.upd(p_sql text) returns text language sql as $$
  select tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', p_sql) $$;
create function tests.rej(r text, con text) returns boolean language sql as $$ select r like '23514%' and r like '%"' || con || '"%' $$;

-- ① 有时刻必须有日期
select ok(tests.rej(tests.todo('{"due_time": "17:00"}'), 'todos_check'), '① due_time = 17:00、due 为空：被 todos_check 拒');
select is(tests.todo('{"due": "2026-11-12", "due_time": "17:00"}'), 'ok', '① 同样的 due_time 带上 due 就通过');

-- ② 格式约束
select ok(tests.rej(tests.todo('{"due": "2026-11-12", "due_time": "24:00"}'), 'todos_due_time_check'), '② due_time = 24:00 被拒');
select ok(tests.rej(tests.todo('{"due": "2026-11-12", "due_time": "7:00"}'), 'todos_due_time_check'), '② due_time = 7:00（少一位）被拒');
select ok(tests.rej(tests.todo('{"due": "2026-11-12", "due_time": "17:60"}'), 'todos_due_time_check'), '② due_time = 17:60 被拒');
select ok(tests.rej(tests.todo('{"due": "2026-11-12", "due_time": "17:00:00"}'), 'todos_due_time_check'), '② due_time 带秒（17:00:00）被拒');
select is(tests.todo('{"due": "2026-11-12", "due_time": "00:00"}') || ',' || tests.todo('{"due": "2026-11-12", "due_time": "23:59"}'),
  'ok,ok', '② 边界 00:00、23:59 通过');

-- ③ remind_before_min 白名单
select ok(tests.rej(tests.todo('{"due": "2026-11-12", "due_time": "17:00", "remind_before_min": 15}'), 'todos_remind_before_min_check'), '③ remind_before_min = 15 被拒');
select ok(tests.rej(tests.todo('{"due": "2026-11-12", "due_time": "17:00", "remind_before_min": -1}'), 'todos_remind_before_min_check'), '③ remind_before_min = -1 被拒');
select is((select string_agg(tests.todo(jsonb_build_object('due', '2026-11-12', 'due_time', '17:00', 'remind_before_min', m)), ',' order by m)
   from unnest(array[0, 10, 30, 60, 120, 1440]) m), 'ok,ok,ok,ok,ok,ok', '③ 白名单 0、10、30、60、120、1440 逐项通过');
select is(tests.todo('{"due": "2026-11-12", "due_time": "17:00", "remind_before_min": null}'), 'ok', '③ remind_before_min 为空（不提醒）通过');

-- ④ insert 60 → update 30；改成非法值被拒、行不变
select is(tests.ins('{"id": "d4600000-0000-4000-8000-000000000001", "title": "T", "due": "2026-11-12", "due_time": "17:00", "remind_before_min": 60, "created_at": 1, "updated_at": 1}'),
  'ok', '④ 合法的 due_time 加 remind_before_min = 60：insert 成功');
select is(tests.upd($$update public.todos set remind_before_min = 30 where id = 'd4600000-0000-4000-8000-000000000001'$$), 'ok', '④ update 成 30 成功');
select ok(tests.rej(tests.upd($$update public.todos set remind_before_min = -1 where id = 'd4600000-0000-4000-8000-000000000001'$$), 'todos_remind_before_min_check'),
  '④ update 成 -1 被拒');
select ok(tests.rej(tests.upd($$update public.todos set due_time = '24:00' where id = 'd4600000-0000-4000-8000-000000000001'$$), 'todos_due_time_check'),
  '④ update due_time 成 24:00 被拒');
select is((select due_time || '/' || remind_before_min from public.todos where id = 'd4600000-0000-4000-8000-000000000001'), '17:00/30',
  '④ 被拒的两次 update 不改行（仍是 17:00 / 30）');

-- ⑤ 改时刻后 remind_queue 重写
create function tests.q(p_id uuid) returns text language sql as $$
  select coalesce((select coalesce(claim::text, '空') || '|' || attempts from private.remind_queue where table_name = 'todos' and id = p_id), '不在队列')
$$;
select is(tests.q('d4600000-0000-4000-8000-000000000001'), '空|0', '⑤ insert / update 后这一条在 remind_queue 里');
delete from private.remind_queue where id = 'd4600000-0000-4000-8000-000000000001';
select is(tests.upd($$update public.todos set due_time = '18:30' where id = 'd4600000-0000-4000-8000-000000000001'$$) || '|' || tests.q('d4600000-0000-4000-8000-000000000001'),
  'ok|空|0', '⑤ 只改 due_time：enqueue_remind 重新入队');
delete from private.remind_queue where id = 'd4600000-0000-4000-8000-000000000001';
select is(tests.upd($$update public.todos set remind_before_min = 120 where id = 'd4600000-0000-4000-8000-000000000001'$$) || '|' || tests.q('d4600000-0000-4000-8000-000000000001'),
  'ok|空|0', '⑤ 只改 remind_before_min：重新入队');
delete from private.remind_queue where id = 'd4600000-0000-4000-8000-000000000001';
select is(tests.upd($$update public.todos set title = 'T 改名' where id = 'd4600000-0000-4000-8000-000000000001'$$) || '|' || tests.q('d4600000-0000-4000-8000-000000000001'),
  'ok|不在队列', '⑤ 只改标题：不入队（触发器只看提醒相关列）');
-- 正被 push-dispatch 租着（claim 非空、取过 2 次）时改时刻：清租约、attempts 清零，下一轮按新时刻重算
insert into private.remind_queue (table_name, id, claim, claimed_at, attempts)
  values ('todos', 'd4600000-0000-4000-8000-000000000001', 'c4600000-0000-4000-8000-000000000001', now(), 2);
select is(tests.q('d4600000-0000-4000-8000-000000000001'), 'c4600000-0000-4000-8000-000000000001|2', '⑤ 造一个被租着的项');
select is(tests.upd($$update public.todos set due_time = '19:00' where id = 'd4600000-0000-4000-8000-000000000001'$$) || '|' || tests.q('d4600000-0000-4000-8000-000000000001'),
  'ok|空|0', '⑤ 租着时改 due_time：清租约、attempts 清零');
select is((select count(*)::int from private.remind_queue where id = 'd4600000-0000-4000-8000-000000000001'), 1, '⑤ 队列里这一条只有一项（不重复）');
-- 被拒的写入不入队
delete from private.remind_queue where id = 'd4600000-0000-4000-8000-000000000001';
select is(tests.upd($$update public.todos set due_time = '17:60' where id = 'd4600000-0000-4000-8000-000000000001'$$) like '23514%', true, '⑤ 改成 17:60 被拒');
select is(tests.q('d4600000-0000-4000-8000-000000000001'), '不在队列', '⑤ 被拒的写入不入队（随语句回滚）');

select * from finish();
rollback;
