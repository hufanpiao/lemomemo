-- B3（架构审第九节第 8 条；TC-B3-29、TC-B3-64；架构 0.38 第 5、9 条）：迁移 20261107100000_core_my_ai_usage.sql
--   ① private.ai_quota_take / ai_quota_refund：原子预扣、退回，按同一个键所有窗口行合计（一个太平洋日期偶尔跨两个 take_rate 窗口）；
--   ② private.my_ai_usage_impl / public.my_ai_usage：设置里看到的次数 = 服务器扣的次数，只算本人；门在 impl 里；
--   ③ private.intake_insert：claude-intake 三张表一个事务写完，只 insert，不准带 user_id。
begin;
select plan(43);
\ir _helpers.psql
select tests.seed();

-- 今天（太平洋日期）的个人额度键
create function tests.k(p_uid uuid) returns text language sql as $$
  select 'ai:' || p_uid::text || ':' || to_char((now() at time zone 'America/Los_Angeles')::date, 'YYYY-MM-DD') $$;
create function tests.total(p_key text) returns int language sql as $$
  select coalesce(sum(count), 0)::int from private.counters where key = p_key $$;
create function tests.svc(p_sql text) returns jsonb language sql as $$
  select tests.rows_as('service_role', null, p_sql) $$;
create function tests.try_claims(p_claims jsonb, p_sql text) returns text language plpgsql as $$
declare r text := 'ok';
begin
  begin
    perform set_config('request.jwt.claims', p_claims::text, true);
    set local role authenticated;
    execute p_sql;
    reset role;
  exception when others then
    r := sqlstate || ' ' || sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;

-- ================= 一、预扣、退回 =================
select is(tests.svc(format($$select private.ai_quota_take(%L, 2) as n$$, tests.k('aaaaaaaa-0000-4000-8000-000000000001'))),
  '[{"n": 1}]'::jsonb, 'take 第 1 次：返回扣后的合计 1');
select is(tests.svc(format($$select private.ai_quota_take(%L, 2) as n$$, tests.k('aaaaaaaa-0000-4000-8000-000000000001'))),
  '[{"n": 2}]'::jsonb, 'take 第 2 次：2');
select is(tests.svc(format($$select private.ai_quota_take(%L, 2) as n$$, tests.k('aaaaaaaa-0000-4000-8000-000000000001'))),
  '[{"n": null}]'::jsonb, 'take 第 3 次（上限 2）：null，不扣');
select is(tests.total(tests.k('aaaaaaaa-0000-4000-8000-000000000001')), 2, '到上限时没记上那一次：合计 2，不超过上限（TC-B3-58）');
select is(tests.svc(format($$select count(*)::int as ok from (select private.ai_quota_refund(%L)) x$$, tests.k('aaaaaaaa-0000-4000-8000-000000000001'))),
  '[{"ok": 1}]'::jsonb, 'refund 一次');
select is(tests.total(tests.k('aaaaaaaa-0000-4000-8000-000000000001')), 1, '退回后合计 1');
select is(tests.svc(format($$select (select count(*)::int from (select private.ai_quota_refund(%L)) x) + (select count(*)::int from (select private.ai_quota_refund(%L)) y) as n$$,
  tests.k('aaaaaaaa-0000-4000-8000-000000000001'), tests.k('aaaaaaaa-0000-4000-8000-000000000001'))), '[{"n": 2}]'::jsonb, '再退两次（多退一次）');
select is(tests.total(tests.k('aaaaaaaa-0000-4000-8000-000000000001')), 0, '不会减到 0 以下');

-- 跨窗口：同一个太平洋日期在上一个窗口里已经扣了 2 次（造一行旧窗口），上限 3 时只能再扣 1 次
insert into private.counters (key, window_start, count) values
  (tests.k('bbbbbbbb-0000-4000-8000-000000000002'), to_timestamp(floor(extract(epoch from now()) / 2678400) * 2678400 - 2678400), 2);
select is(tests.svc(format($$select private.ai_quota_take(%L, 3) as n$$, tests.k('bbbbbbbb-0000-4000-8000-000000000002'))),
  '[{"n": 3}]'::jsonb, '跨窗口合计：旧窗口 2 次 + 这次 = 3');
select is(tests.svc(format($$select private.ai_quota_take(%L, 3) as n$$, tests.k('bbbbbbbb-0000-4000-8000-000000000002'))),
  '[{"n": null}]'::jsonb, '跨窗口合计到上限：不扣');
select is((select count from private.counters where key = tests.k('bbbbbbbb-0000-4000-8000-000000000002')
            and window_start = to_timestamp(floor(extract(epoch from now()) / 2678400) * 2678400)), 1, '当前窗口只有 1 次');
select is(tests.svc(format($$select count(*)::int as ok from (select private.ai_quota_refund(%L)) x$$, tests.k('bbbbbbbb-0000-4000-8000-000000000002'))),
  '[{"ok": 1}]'::jsonb, '跨窗口退回一次');
select is((select jsonb_agg(count order by window_start) from private.counters where key = tests.k('bbbbbbbb-0000-4000-8000-000000000002')),
  '[2, 0]'::jsonb, '退回从最新的窗口行减（旧窗口不动）');

select ok(tests.svc($$select private.ai_quota_take('rate:aaaaaaaa-0000-4000-8000-000000000001:x', 5)$$) ->> 'error' like '22023 bad_quota_args%', '只认 ai: 开头的键');
select ok(tests.svc(format($$select private.ai_quota_take(%L, -1)$$, tests.k('aaaaaaaa-0000-4000-8000-000000000001'))) ->> 'error' like '22023%', '上限为负报错');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private' and p.proname in ('ai_quota_take', 'ai_quota_refund', 'intake_insert')
              and p.proconfig = array['search_path=""', 'lock_timeout=5s']), 3, '三个函数都带 search_path 空和 lock_timeout 5s');

-- 执行权：只给 service_role
select ok(tests.try_as('anon', null, format($$select private.ai_quota_take(%L, 50)$$, tests.k('aaaaaaaa-0000-4000-8000-000000000001'))) like '42501%', 'anon 调不了 ai_quota_take');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', format($$select private.ai_quota_take(%L, 50)$$, tests.k('aaaaaaaa-0000-4000-8000-000000000001')), null, 'aaaaaaaa-5555-4000-8000-000000000001') like '42501%', 'authenticated 调不了 ai_quota_take（不能给自己刷额度）');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', format($$select private.ai_quota_refund(%L)$$, tests.k('aaaaaaaa-0000-4000-8000-000000000001')), null, 'aaaaaaaa-5555-4000-8000-000000000001') like '42501%', 'authenticated 调不了 ai_quota_refund');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select private.intake_insert('aaaaaaaa-0000-4000-8000-000000000001', '{}')$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') like '42501%', 'authenticated 调不了 intake_insert');

-- ================= 二、my_ai_usage（TC-B3-29、64） =================
-- A 今天扣 3 次（经 ai_quota_take，和服务器同一条路）；B 另有 1 次（上面跨窗口那组之外再造一个人：C 停用不算）
select tests.svc(format($$select private.ai_quota_take(%L, 50), private.ai_quota_take(%L, 50), private.ai_quota_take(%L, 50)$$,
  tests.k('aaaaaaaa-0000-4000-8000-000000000001'), tests.k('aaaaaaaa-0000-4000-8000-000000000001'), tests.k('aaaaaaaa-0000-4000-8000-000000000001')));
select is(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select public.my_ai_usage() as u$$, null, 'aaaaaaaa-5555-4000-8000-000000000001'),
  jsonb_build_array(jsonb_build_object('u', jsonb_build_object('ai_used', 3, 'ai_limit', 50,
    'pacific_date', to_char((now() at time zone 'America/Los_Angeles')::date, 'YYYY-MM-DD'),
    'media_used', 0, 'media_limit', 52428800))),   -- B4 迁移 20261111100000 加了存储用量两个键（44_media_quota 详测）
  'TC-B3-29：A 看到的次数 = 服务器扣的 3 次，上限 50，带太平洋日期');
select is(tests.rows_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', $$select public.my_ai_usage() ->> 'ai_used' as n$$, null, 'bbbbbbbb-5555-4000-8000-000000000002'),
  '[{"n": "2"}]'::jsonb, 'B 跨窗口合计（旧窗口 2 + 当前退回后 0）= 2，A 的不算进来');
select is(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select private.my_ai_usage_impl() as u$$, null, 'aaaaaaaa-5555-4000-8000-000000000001'),
  tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select public.my_ai_usage() as u$$, null, 'aaaaaaaa-5555-4000-8000-000000000001'),
  'TC-B3-64 ③：A 直接调 impl 和经包装结果完全相同');
select ok(tests.rows_as('anon', null, $$select public.my_ai_usage()$$) ->> 'error' like '42501%', 'TC-B3-64 ①：anon 调 my_ai_usage 被拒');
select ok(tests.rows_as('anon', null, $$select private.my_ai_usage_impl()$$) ->> 'error' like '42501%', 'TC-B3-64 ②：anon 直接调 impl 被拒');
select ok(tests.try_claims('{"sub": "aaaaaaaa-0000-4000-8000-000000000001", "role": "authenticated", "session_id": "aaaaaaaa-5555-4000-8000-000000000001", "amr": [{"method": "password"}]}',
  $$select private.my_ai_usage_impl()$$) like '%session_revoked%', 'TC-B3-64 ④：密码会话直接调 impl：session_revoked');
select ok(tests.try_as('authenticated', 'cccccccc-0000-4000-8000-000000000003', $$select public.my_ai_usage()$$) like '%account_disabled%', '停用账号：account_disabled');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select public.my_ai_usage()$$, null, 'aaaaaaaa-9999-4000-8000-000000000001') like '%session_revoked%', '会话不在：session_revoked');
select ok(tests.rows_as('service_role', null, $$select public.my_ai_usage()$$) ->> 'error' like '42501%', 'service_role 调 public 包装被拒（public RPC 只给 authenticated）');
update public.app_config set ai = jsonb_set(ai, '{per_user_daily}', '7') where id = 1;
select is(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select public.my_ai_usage() ->> 'ai_limit' as n$$, null, 'aaaaaaaa-5555-4000-8000-000000000001'),
  '[{"n": "7"}]'::jsonb, '上限读 app_config.ai.per_user_daily');
update public.app_config set ai = jsonb_set(ai, '{per_user_daily}', '"x"') where id = 1;
select is(tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select public.my_ai_usage() ->> 'ai_limit' as n$$, null, 'aaaaaaaa-5555-4000-8000-000000000001'),
  '[{"n": "50"}]'::jsonb, '格式不对按 50（同 router.ts readAiConfig）');

-- ================= 三、intake_insert（代码审建议 3） =================
select is(tests.svc($$select count(*)::int as ok from (select private.intake_insert('aaaaaaaa-0000-4000-8000-000000000001', '{
  "events": [{"id": "e1000000-0000-4000-8000-000000000001", "title": "开会", "date": "2026-10-29", "time": "15:00", "tz": "Asia/Seoul", "source": "chat", "created_at": 1761620000000, "updated_at": 1761620000000}],
  "todos": [{"id": "e2000000-0000-4000-8000-000000000001", "title": "交报告", "due": "2026-10-30", "source": "chat", "created_at": 1761620000000, "updated_at": 1761620000000},
            {"id": "e2000000-0000-4000-8000-000000000002", "title": "买牛奶", "created_at": 1761620000000, "updated_at": 1761620000000}]}')) x$$),
  '[{"ok": 1}]'::jsonb, '一次写进一条日程、两条待办');
select is((select jsonb_agg(jsonb_build_array(user_id, title, project, duration_min) order by id) from public.events where id = 'e1000000-0000-4000-8000-000000000001'),
  '[["aaaaaaaa-0000-4000-8000-000000000001", "开会", "", 60]]'::jsonb, 'user_id 由参数给；没带的列走默认值（project 空串、时长 60）');
select is((select jsonb_agg(jsonb_build_array(title, source) order by id) from public.todos where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  '[["交报告", "chat"], ["买牛奶", "page"]]'::jsonb, '逐行按自己带的列写：第二条没带 source 就是默认 page，不是 null');
select ok(tests.svc($$select private.intake_insert('aaaaaaaa-0000-4000-8000-000000000001', '{
  "events": [{"id": "e1000000-0000-4000-8000-000000000002", "title": "第二场", "date": "2026-10-29", "created_at": 1761620000000, "updated_at": 1761620000000}],
  "todos": [{"id": "e2000000-0000-4000-8000-000000000003", "title": "", "created_at": 1761620000000, "updated_at": 1761620000000}]}')$$) ->> 'error' like '23514%', '后一张表一条过不了约束：整份报错');
select is((select count(*)::int from public.events where id = 'e1000000-0000-4000-8000-000000000002'), 0, '一个事务：前一张表那条也没留下（重试不会重复）');
select ok(tests.svc($$select private.intake_insert('aaaaaaaa-0000-4000-8000-000000000001', '{"todos": [{"id": "e2000000-0000-4000-8000-000000000004", "title": "x", "user_id": "bbbbbbbb-0000-4000-8000-000000000002"}]}')$$) ->> 'error' like '22023 bad_intake_column%', '行里带 user_id 报错（不准替别人写）');
select ok(tests.svc($$select private.intake_insert('aaaaaaaa-0000-4000-8000-000000000001', '{"notes": []}')$$) ->> 'error' like '22023 bad_intake_table%', '只认三张表');

-- 安全审复查建议：列按表写死，系统列只准带新建时的固定值
select ok(tests.svc($$select private.intake_insert('aaaaaaaa-0000-4000-8000-000000000001', '{"events": [{"id": "e1000000-0000-4000-8000-000000000003", "title": "x", "date": "2026-10-29", "ai_status": "done", "created_at": 1761620000000, "updated_at": 1761620000000}]}')$$) ->> 'error' like '22023 bad_intake_column%', '写 ai_status（系统列，不在名单里）报错');
select ok(tests.svc($$select private.intake_insert('aaaaaaaa-0000-4000-8000-000000000001', '{"todos": [{"id": "e2000000-0000-4000-8000-000000000005", "title": "x", "deleted_at": 1761620000000, "created_at": 1761620000000, "updated_at": 1761620000000}]}')$$) ->> 'error' like '22023 bad_intake_column%', 'deleted_at 带非空值报错（只准 null）');
select is(tests.svc($$select count(*)::int as ok from (select private.intake_insert('aaaaaaaa-0000-4000-8000-000000000001', '{"todos": [{"id": "e2000000-0000-4000-8000-000000000006", "title": "整行", "done": false, "due": null, "important": false, "project": "", "note": "", "source": "chat", "raw_text": "整行", "batch_id": "e3000000-0000-4000-8000-000000000001", "from_note_id": null, "from_anniv_id": null, "short": null, "short_by": null, "done_at": 0, "remind_days": null, "remind_time": "09:00", "due_time": null, "remind_before_min": null, "push_show_title": null, "notified_for": null, "snooze_at": null, "created_at": 1761620000000, "updated_at": 1761620000000}]}')) x$$),
  '[{"ok": 1}]'::jsonb, 'capture-map 产出的整行待办（系统列都是固定值；11-09 起不带 deleted_at、undone）写得进');
select is((select jsonb_agg(jsonb_build_array(deleted_at, undone) order by id) from (select id, deleted_at, undone from public.events where id = 'e1000000-0000-4000-8000-000000000001'
           union all select id, deleted_at, undone from public.todos where id in ('e2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000006')) x),
  '[[null, false], [null, false], [null, false]]'::jsonb, '没带 deleted_at、undone 的行走库默认值：deleted_at 为 null、undone 为 false（不报错、不写成 null）');
select is((select count(*)::int from public.todos where id in ('e2000000-0000-4000-8000-000000000005')) + (select count(*)::int from public.events where id = 'e1000000-0000-4000-8000-000000000003'), 0, '被拒的两条什么都没写');

select * from finish();
rollback;
