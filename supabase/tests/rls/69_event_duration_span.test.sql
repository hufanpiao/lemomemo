-- R-444 跨天日程：events.duration_min 的库约束放宽到 1～44640（31 天，迁移 20261117120000_events_duration_span.sql）。
-- ① 1、1440（原上限）、1441、44640（新上限）都能 insert；② 0、44641 被 events_duration_min_check 拒；
-- ③ 已有的行 update 成 4320（跨 3 天）成功，update 成 44641 被拒、行不变；④ 经 apply_patch 改 duration_min 同样认新上限；
-- ⑤ 改 duration_min 不让 enqueue_remind 重新入队（提醒只看开始时刻，和时长无关）。
-- 写入一律以 A 的 authenticated 身份（同 REST 的写法：只写带上的列）。
begin;
select plan(11);
\ir _helpers.psql
select tests.seed();

create function tests.ins(p_row jsonb) returns text language plpgsql as $$
declare cols text := (select string_agg(quote_ident(k), ',') from jsonb_object_keys(p_row) k);
begin
  return tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
    format('insert into public.events (%s) select %s from jsonb_populate_record(null::public.events, %L::jsonb)', cols, cols, p_row));
end $$;
create function tests.ev(p_dur int) returns text language sql as $$
  select tests.ins(jsonb_build_object('id', gen_random_uuid(), 'title', 'e', 'date', '2026-11-17', 'time', '09:00', 'tz', 'Asia/Seoul',
    'duration_min', p_dur, 'created_at', 0, 'updated_at', 0)) $$;
create function tests.upd(p_sql text) returns text language sql as $$
  select tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', p_sql) $$;
create function tests.rej(r text) returns boolean language sql as $$ select r like '23514%' and r like '%"events_duration_min_check"%' $$;

-- ① 合法范围
select is((select string_agg(tests.ev(m), ',' order by m) from unnest(array[1, 1440, 1441, 44640]) m), 'ok,ok,ok,ok',
  '① 1、1440、1441、44640（31 天）都能 insert');

-- ② 超出范围
select ok(tests.rej(tests.ev(0)), '② duration_min = 0 被拒');
select ok(tests.rej(tests.ev(44641)), '② duration_min = 44641（超过 31 天）被拒');

-- ③ update
select is(tests.ins('{"id": "e6900000-0000-4000-8000-000000000001", "title": "出差", "date": "2026-11-18", "time": "09:00", "tz": "Asia/Seoul", "duration_min": 60, "remind_min": 15, "created_at": 1, "updated_at": 1}'),
  'ok', '③ 先建一条 1 小时的日程');
select is(tests.upd($$update public.events set duration_min = 4320 where id = 'e6900000-0000-4000-8000-000000000001'$$), 'ok', '③ update 成 4320（跨 3 天）成功');
select ok(tests.rej(tests.upd($$update public.events set duration_min = 44641 where id = 'e6900000-0000-4000-8000-000000000001'$$)), '③ update 成 44641 被拒');
select is((select duration_min from public.events where id = 'e6900000-0000-4000-8000-000000000001'), 4320, '③ 被拒的 update 不改行');

-- ④ apply_patch（客户端同步走这条）
-- 同 14_apply_patch 的 tests.ap：以 A 的身份调 public.apply_patch，取回它的返回值
create function tests.patch(p_patch jsonb) returns jsonb language sql as $$
  with x as (select tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
    format('select public.apply_patch(%L, %L::uuid, %L::jsonb, %s, %L::uuid) as r', 'events', 'e6900000-0000-4000-8000-000000000001', p_patch,
      (select rev from public.events where id = 'e6900000-0000-4000-8000-000000000001'), gen_random_uuid())) j)
  select coalesce(j -> 0 -> 'r', j) from x
$$;
select is(tests.patch('{"duration_min": 44640}') ->> 'status', 'ok', '④ apply_patch 改成 44640 成功');
select is((select duration_min from public.events where id = 'e6900000-0000-4000-8000-000000000001'), 44640, '④ 行里是 44640');

-- ⑤ 改时长不重新入队提醒
delete from private.remind_queue where id = 'e6900000-0000-4000-8000-000000000001';
select is(tests.upd($$update public.events set duration_min = 2880 where id = 'e6900000-0000-4000-8000-000000000001'$$), 'ok', '⑤ 只改 duration_min 成功');
select is((select count(*)::int from private.remind_queue where id = 'e6900000-0000-4000-8000-000000000001'), 0, '⑤ 只改 duration_min：不入队（提醒按开始时刻，和时长无关）');

select * from finish();
rollback;
