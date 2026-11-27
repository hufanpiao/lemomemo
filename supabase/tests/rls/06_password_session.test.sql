-- 密码会话一律不认（架构 0.36 第 1 条 ②；B0 第三轮安全 N1 的纵深；B1 安全审查必改 1、2）：TC-B1-111 的数据库一半
-- amr 的元素两种写法都认：对象 {"method": "password"} 和裸字符串 "password"；判断在 private.not_password_session()，
--   is_active、files_authorize_impl、record_consent_impl、purge_deleted_impl 和 profiles 的两条策略都调它（0.38）；
--   没有 amr 放行，有 amr 但不是数组拒
-- JWT 的 amr 里有 {"method": "password"} 时：private.is_active() 为假（全部 RLS、Realtime 跟着拒），files_authorize 整批回 session_revoked；
-- otp、magiclink、recovery 和没有 amr 的照常。刷新出来的令牌沿用原会话的 amr（iat 变了也一样被拒）。
-- 真密码会话（临时关触发器、grant_type=password 登录）的端到端一半在 TC-B1-111 的线上 / 本地真库用例里，这里用 request.jwt.claims 模拟
begin;
select plan(73);
\ir _helpers.psql
select tests.seed();

-- 以 A 的身份、A 的会话（authenticated）执行，JWT 带给定的 amr（null = 不带）；p_extra 合进 claims（例如 iat）
create function tests.claims_amr(p_amr jsonb, p_extra jsonb default '{}'::jsonb) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', (jsonb_strip_nulls(jsonb_build_object(
    'sub', 'aaaaaaaa-0000-4000-8000-000000000001', 'role', 'authenticated',
    'session_id', 'aaaaaaaa-5555-4000-8000-000000000001', 'amr', p_amr)) || p_extra)::text, true);
end $$;
-- 查询：结果行的 jsonb 数组；出错返回 {"error": "<sqlstate> <信息>"}
create function tests.rows_amr(p_amr jsonb, p_sql text, p_extra jsonb default '{}'::jsonb) returns jsonb language plpgsql as $$
declare res jsonb;
begin
  begin
    perform tests.claims_amr(p_amr, p_extra);
    set local role authenticated;
    execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', p_sql) into res;
    reset role;
  exception when others then
    res := jsonb_build_object('error', sqlstate || ' ' || sqlerrm);
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return res;
end $$;
-- 写入：'ok' 或 '<sqlstate> <信息>'；成功的写入保留到事务结束
create function tests.try_amr(p_amr jsonb, p_sql text, p_extra jsonb default '{}'::jsonb) returns text language plpgsql as $$
declare r text := 'ok';
begin
  begin
    perform tests.claims_amr(p_amr, p_extra);
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
create function tests.active(p_amr jsonb, p_extra jsonb default '{}'::jsonb) returns boolean language sql as $$
  select (tests.rows_amr(p_amr, 'select private.is_active() as v', p_extra) -> 0 ->> 'v')::boolean
$$;
create function tests.fa_amr(p_amr jsonb) returns jsonb language sql as $$
  select tests.rows_amr(p_amr, $q$select public.files_authorize('get', '[{"bucket":"images","path":"x"}]'::jsonb) as r$q$) -> 0 -> 'r'
$$;

-- A 的一条设置（以 postgres 写，绕过 RLS）
insert into public.settings (id, user_id, key, value) values
  ('5e000000-0000-4000-8000-0000000000a6', 'aaaaaaaa-0000-4000-8000-000000000001', 'ui.theme', '"dark"');

-- ===== 函数属性和授权（0.38：只新增 not_password_session 给 authenticated 一句，3.3 C 同批加行；其余授权照旧） =====
select ok((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = 'private.is_active()'::regprocedure),
  'is_active 仍是 security definer、search_path 为空');
select ok((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = 'private.files_authorize_impl(text, jsonb)'::regprocedure),
  'files_authorize_impl 仍是 security definer、search_path 为空');
select ok(has_function_privilege('authenticated', 'private.is_active()', 'EXECUTE')
      and not has_function_privilege('anon', 'private.is_active()', 'EXECUTE')
      and not has_function_privilege('service_role', 'private.is_active()', 'EXECUTE'), 'is_active 的执行权照旧：只有 authenticated');
select ok(has_function_privilege('authenticated', 'private.files_authorize_impl(text, jsonb)', 'EXECUTE')
      and not has_function_privilege('anon', 'private.files_authorize_impl(text, jsonb)', 'EXECUTE')
      and not has_function_privilege('service_role', 'private.files_authorize_impl(text, jsonb)', 'EXECUTE'), 'files_authorize_impl 的执行权照旧：只有 authenticated');
select ok((select not p.prosecdef and p.provolatile = 's' and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = 'private.not_password_session()'::regprocedure),
  'not_password_session 是 security invoker、stable、search_path 为空');
select ok((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = 'private.record_consent_impl(text, boolean)'::regprocedure),
  'record_consent_impl 仍是 security definer、search_path 为空');
select ok((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = 'private.purge_deleted_impl(jsonb)'::regprocedure),
  'purge_deleted_impl 仍是 security definer、search_path 为空');
select ok(has_function_privilege('authenticated', 'private.record_consent_impl(text, boolean)', 'EXECUTE')
      and not has_function_privilege('anon', 'private.record_consent_impl(text, boolean)', 'EXECUTE')
      and not has_function_privilege('service_role', 'private.record_consent_impl(text, boolean)', 'EXECUTE')
      and has_function_privilege('authenticated', 'private.purge_deleted_impl(jsonb)', 'EXECUTE')
      and not has_function_privilege('anon', 'private.purge_deleted_impl(jsonb)', 'EXECUTE')
      and not has_function_privilege('service_role', 'private.purge_deleted_impl(jsonb)', 'EXECUTE'),
  'record_consent_impl、purge_deleted_impl 的执行权照旧：只有 authenticated');
select ok(has_function_privilege('authenticated', 'private.not_password_session()', 'EXECUTE')
      and not has_function_privilege('anon', 'private.not_password_session()', 'EXECUTE')
      and not has_function_privilege('service_role', 'private.not_password_session()', 'EXECUTE'),
  'not_password_session 只授 authenticated（profiles 的策略以调用者身份执行）');

-- ===== is_active() =====
select is(tests.active('[{"method": "otp", "timestamp": 1761700000}]'), true, '验证码会话：is_active 为真');
select is(tests.active('[{"method": "magiclink", "timestamp": 1761700000}]'), true, 'magiclink 会话：is_active 为真');
select is(tests.active('[{"method": "recovery", "timestamp": 1761700000}]'), true, 'recovery 会话：is_active 为真');
select is(tests.active(null), true, 'JWT 没有 amr：is_active 为真（只拒 password）');
select is(tests.active('[{"method": "password", "timestamp": 1761700000}]'), false, '密码会话：is_active 为假');
select is(tests.active('[{"method": "otp", "timestamp": 1761700000}, {"method": "password", "timestamp": 1761700001}]'), false,
  'amr 里 otp 和 password 都有：is_active 为假');
select is(tests.active('[{"method": "password", "timestamp": 1761700000}]', '{"iat": 1761703600}'), false,
  '刷新出来的令牌（iat 新、amr 沿用原会话）：照样为假');
-- 字符串写法（B0 第四轮 QA 真库实测记作 amr = ["password"]）、混合、JSON null、不是数组
select is(tests.active('["password"]'), false, 'amr 是字符串数组 ["password"]：is_active 为假');
select is(tests.active('["otp"]'), true, 'amr 是字符串数组 ["otp"]：is_active 为真');
select is(tests.active('["otp", {"method": "password", "timestamp": 1761700000}]'), false, '字符串 otp 和对象 password 混合：为假');
select is(tests.active('[{"method": "otp", "timestamp": 1761700000}, "password"]'), false, '对象 otp 和字符串 password 混合：为假');
-- 0.38：没有 amr 放行；有 amr 但不是数组（JSON null、标量、对象）一律拒（GoTrue 签的一定是数组）
select is(tests.active(null, '{"amr": null}'), false, 'amr 是 JSON null（有键、不是数组）：is_active 为假');
select is(tests.active('"otp"'), false, 'amr 是字符串标量：is_active 为假');
select is(tests.active('{"method": "otp"}'), false, 'amr 是对象（不是数组）：is_active 为假');

-- ===== RLS：读、写 =====
select is(jsonb_array_length(tests.rows_amr('[{"method": "otp", "timestamp": 1761700000}]', 'select id from public.settings')), 1,
  '验证码会话：读得到本人的设置');
select is(jsonb_array_length(tests.rows_amr('[{"method": "password", "timestamp": 1761700000}]', 'select id from public.settings')), 0,
  '密码会话：读 settings 0 行');
select ok(tests.try_amr('[{"method": "password", "timestamp": 1761700000}]',
  $$insert into public.events (id, title, date, created_at, updated_at) values ('e0000000-0000-4000-8000-0000000000a6', '密码会话写', '2026-11-01', 1, 1)$$)
  like '42501%', '密码会话：写 events 被 RLS 拒（42501）');
-- 注意：函数里的写入对同一条语句里的子查询不可见（语句快照），所以“调用”和“核对结果”分成两句
select is(tests.try_amr('[{"method": "password", "timestamp": 1761700000}]',
  $$update public.settings set value = '"light"' where id = '5e000000-0000-4000-8000-0000000000a6'$$), 'ok', '密码会话：改 settings 不报错');
select is((select value from public.settings where id = '5e000000-0000-4000-8000-0000000000a6'), '"dark"'::jsonb, '密码会话：settings 改不到（0 行）');
select is(tests.try_amr('[{"method": "otp", "timestamp": 1761700000}]',
  $$insert into public.events (id, title, date, created_at, updated_at) values ('e0000000-0000-4000-8000-0000000000a7', '验证码会话写', '2026-11-01', 1, 1)$$),
  'ok', '验证码会话：写 events 照常');
select is((select count(*)::int from public.events where id in ('e0000000-0000-4000-8000-0000000000a6', 'e0000000-0000-4000-8000-0000000000a7')), 1,
  '库里只有验证码会话写的那一条');
select is(jsonb_array_length(tests.rows_amr('[{"method": "password", "timestamp": 1761700000}]', 'select id from public.events')), 0,
  '密码会话：读 events 0 行（库里有本人一条）');

-- ===== files_authorize =====
select is(tests.fa_amr('[{"method": "password", "timestamp": 1761700000}]'),
  '{"uid":"aaaaaaaa-0000-4000-8000-000000000001","error":"session_revoked","items":[]}'::jsonb, '密码会话：files_authorize 整批回 session_revoked');
select is(tests.fa_amr('[{"method": "otp", "timestamp": 1761700000}, {"method": "password", "timestamp": 1761700001}]') ->> 'error', 'session_revoked',
  'amr 里 otp 和 password 都有：session_revoked');
select is(tests.fa_amr('["password"]') ->> 'error', 'session_revoked', 'amr 是字符串数组 ["password"]：session_revoked');
select is(tests.fa_amr('[{"method": "otp", "timestamp": 1761700000}]'),
  '{"uid":"aaaaaaaa-0000-4000-8000-000000000001","items":[{"i":0,"ok":false,"reason":"bad_path"}]}'::jsonb, '验证码会话：照常逐项判断（这一项 bad_path）');
select is(tests.fa_amr('[{"method": "magiclink", "timestamp": 1761700000}]') ->> 'error', null, 'magiclink 会话：没有整批错误');
select is(tests.fa_amr(null) ->> 'error', null, '没有 amr：没有整批错误');
-- 0.38 第 5、9 条：用密码会话直接调 private.files_authorize_impl，同样整批回 session_revoked
select is(tests.rows_amr('[{"method": "password", "timestamp": 1761700000}]',
  $q$select private.files_authorize_impl('get', '[{"bucket":"images","path":"x"}]'::jsonb) as r$q$) -> 0 -> 'r' ->> 'error', 'session_revoked',
  '密码会话直接调 files_authorize_impl：session_revoked');
-- 终审建议 6：先拒密码会话、后查 account_usable（和 requireActiveUser、各 *_impl 同一顺序）：停用的 C 用密码会话来，回 session_revoked 而不是 account_disabled
select is(tests.rows_amr('[{"method": "password", "timestamp": 1761700000}]',
  $q$select public.files_authorize('get', '[{"bucket":"images","path":"x"}]'::jsonb) as r$q$,
  '{"sub": "cccccccc-0000-4000-8000-000000000003", "session_id": "cccccccc-5555-4000-8000-000000000003"}') -> 0 -> 'r' ->> 'error', 'session_revoked',
  '停用账号用密码会话调 files_authorize：session_revoked（先拒密码会话）');
-- 密码会话被拒在限流计数之前：只有上面三次放行的调用计了数
select is((select sum(count)::int from private.counters where key like 'files_get:aaaaaaaa-0000-4000-8000-000000000001:%'), 3,
  '密码会话的调用不计入限流');


-- ===== record_consent、purge_deleted（security definer，不经 RLS） =====
-- A 在“最近删除”里有一条日程（以 postgres 写）
insert into public.events (id, user_id, title, date, created_at, updated_at, deleted_at) values
  ('e0000000-0000-4000-8000-0000000000a8', 'aaaaaaaa-0000-4000-8000-000000000001', '已删', '2026-11-01', 1, 1, 1);
select ok(tests.rows_amr('[{"method": "password", "timestamp": 1761700000}]', 'select public.purge_deleted() as n') ->> 'error' like '%session_revoked%',
  '密码会话：purge_deleted 报 session_revoked');
select ok(tests.rows_amr('["password"]', 'select public.purge_deleted() as n') ->> 'error' like '%session_revoked%',
  '字符串写法的密码会话：purge_deleted 同样被拒');
-- 0.38 第 5、9 条：用密码会话直接调 private.purge_deleted_impl（不经 public 包装），同样 session_revoked
select ok(tests.try_amr('[{"method": "password", "timestamp": 1761700000}]', 'select private.purge_deleted_impl(null)') like '%session_revoked%',
  '密码会话直接调 purge_deleted_impl：session_revoked');
select is((select count(*)::int from public.events where id = 'e0000000-0000-4000-8000-0000000000a8'), 1, '密码会话没清掉“最近删除”');
select is((tests.rows_amr('[{"method": "otp", "timestamp": 1761700000}]', 'select public.purge_deleted() as n') -> 0 ->> 'n')::int, 1,
  '验证码会话：purge_deleted 照常清掉 1 条');
-- 带 p_items 的一路（逐条清）
insert into public.events (id, user_id, title, date, created_at, updated_at, deleted_at) values
  ('e0000000-0000-4000-8000-0000000000a9', 'aaaaaaaa-0000-4000-8000-000000000001', '已删 2', '2026-11-01', 1, 1, 1);
select ok(tests.rows_amr('[{"method": "password", "timestamp": 1761700000}]',
  $q$select public.purge_deleted('[{"tbl": "events", "id": "e0000000-0000-4000-8000-0000000000a9"}]'::jsonb) as n$q$) ->> 'error' like '%session_revoked%',
  '密码会话：带 p_items 的 purge_deleted 同样报 session_revoked');
select is((select count(*)::int from public.events where id = 'e0000000-0000-4000-8000-0000000000a9'), 1, '密码会话没清掉指定的那一条');
select is((tests.rows_amr('[{"method": "otp", "timestamp": 1761700000}]',
  $q$select public.purge_deleted('[{"tbl": "events", "id": "e0000000-0000-4000-8000-0000000000a9"}]'::jsonb) as n$q$) -> 0 ->> 'n')::int, 1,
  '验证码会话：带 p_items 照常清掉指定的 1 条');
select ok(tests.rows_amr('[{"method": "password", "timestamp": 1761700000}]',
  format('select public.record_consent(%L, false) as r', (select notice->>'policy_ver' from public.app_config where id = 1))) ->> 'error' like '%session_revoked%',
  '密码会话：record_consent 报 session_revoked');
select ok(tests.rows_amr('[{"method": "password", "timestamp": 1761700000}]',
  format('select public.record_consent(%L, true) as r', (select notice->>'policy_ver' from public.app_config where id = 1))) ->> 'error' like '%session_revoked%',
  '密码会话：撤销同意同样被拒');
select is((select consent_ai_at from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), null, '密码会话没替 A 同意 AI');
select is(tests.rows_amr('[{"method": "otp", "timestamp": 1761700000}]',
  format('select public.record_consent(%L, false) as r', (select notice->>'policy_ver' from public.app_config where id = 1))), '[{"r": null}]'::jsonb,
  '验证码会话：record_consent 不报错');
select ok((select consent_ai_at is not null from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  '验证码会话：record_consent 照常记下同意');
-- 0.38：record_consent_impl 补了 account_usable（停用的 C 报 account_disabled）
select ok(tests.rows_as('authenticated', 'cccccccc-0000-4000-8000-000000000003',
  format('select public.record_consent(%L, false) as r', (select notice->>'policy_ver' from public.app_config where id = 1))) ->> 'error' like '%account_disabled%',
  '停用账号：record_consent 报 account_disabled');

-- ===== profiles（不经 is_active，策略直接调 not_password_session） =====
select is(jsonb_array_length(tests.rows_amr('[{"method": "password", "timestamp": 1761700000}]', 'select user_id from public.profiles')), 0,
  '密码会话：读 profiles 0 行');
select is(jsonb_array_length(tests.rows_amr('["password"]', 'select user_id from public.profiles')), 0, '字符串写法的密码会话：读 profiles 0 行');
select is(jsonb_array_length(tests.rows_amr('[{"method": "otp", "timestamp": 1761700000}]', 'select user_id from public.profiles')), 1,
  '验证码会话：读得到自己的 profile');
select is(tests.try_amr('[{"method": "password", "timestamp": 1761700000}]',
  $$update public.profiles set display_name = '密码改的' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$), 'ok', '密码会话：改 profiles 不报错');
select is((select display_name from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), null, '密码会话：profiles 改不到（0 行）');
select is(tests.try_amr('[{"method": "otp", "timestamp": 1761700000}]',
  $$update public.profiles set display_name = '验证码改的' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$), 'ok', '验证码会话：改 profiles 不报错');
select is((select display_name from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), '验证码改的', '验证码会话：改 profiles 照常');
select is(jsonb_array_length(tests.rows_amr('["otp", {"method": "password", "timestamp": 1761700000}]', 'select user_id from public.profiles')), 0,
  '混合写法（字符串 otp + 对象 password）：读 profiles 0 行');
select is(jsonb_array_length(tests.rows_amr('"otp"', 'select user_id from public.profiles')), 0, 'amr 是非数组标量：读 profiles 0 行');
select is(jsonb_array_length(tests.rows_amr(null, 'select user_id from public.profiles', '{"amr": null}')), 0, 'amr 是 JSON null：读 profiles 0 行');
select is(jsonb_array_length(tests.rows_amr(null, 'select user_id from public.profiles')), 1, '没有 amr：读得到自己的 profile');
-- 停用账号（不是密码会话）照样读得到自己的停用状态：profiles 不经 is_active
select is(jsonb_array_length(tests.rows_as('authenticated', 'cccccccc-0000-4000-8000-000000000003', 'select disabled_at from public.profiles')), 1,
  '停用的 C（没有 amr）仍读得到自己的停用状态');

-- ===== purge_deleted：会话已吊销（远程移除设备后旧令牌还没过期，K1 审查）被拒、什么都没删 =====
-- A 的第二个会话 S2：auth.sessions 里还在，但已写进 revoked_sessions；A 在“最近删除”里有一条日程、一条待办
insert into auth.sessions (id, user_id) values ('aaaaaaaa-5555-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001');
insert into private.revoked_sessions (session_id, user_id) values ('aaaaaaaa-5555-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001');
insert into public.events (id, user_id, title, date, created_at, updated_at, deleted_at) values
  ('e0000000-0000-4000-8000-0000000000aa', 'aaaaaaaa-0000-4000-8000-000000000001', '已删 3', '2026-11-01', 1, 1, 1);
insert into public.todos (id, user_id, title, deleted_at, created_at, updated_at) values
  ('70000000-0000-4000-8000-0000000000aa', 'aaaaaaaa-0000-4000-8000-000000000001', '已删待办', 1, 1, 1);
select ok(tests.rows_amr('[{"method": "otp", "timestamp": 1761700000}]', 'select public.purge_deleted() as n',
  '{"session_id": "aaaaaaaa-5555-4000-8000-0000000000a2"}') ->> 'error' like '%session_revoked%',
  '会话已吊销：purge_deleted（全部清空）报 session_revoked');
select ok(tests.rows_amr('[{"method": "otp", "timestamp": 1761700000}]',
  $q$select public.purge_deleted('[{"tbl": "events", "id": "e0000000-0000-4000-8000-0000000000aa"}]'::jsonb) as n$q$,
  '{"session_id": "aaaaaaaa-5555-4000-8000-0000000000a2"}') ->> 'error' like '%session_revoked%',
  '会话已吊销：带 p_items 的 purge_deleted 同样报 session_revoked');
select ok(tests.rows_amr('[{"method": "otp", "timestamp": 1761700000}]', 'select public.purge_deleted() as n',
  '{"session_id": "aaaaaaaa-5555-4000-8000-0000000000ff"}') ->> 'error' like '%session_revoked%',
  '会话不在 auth.sessions 里（已退出）：purge_deleted 报 session_revoked');
select is((select count(*)::int from public.events where id = 'e0000000-0000-4000-8000-0000000000aa')
        + (select count(*)::int from public.todos where id = '70000000-0000-4000-8000-0000000000aa'), 2,
  '会话已吊销：“最近删除”里的日程和待办都还在');

-- ===== 停用账号（不是密码会话）撤销同意：报 account_disabled，不写 settings、不删向量和队列 =====
-- 07 已核对“报 account_disabled、一条设置都没写”，这里补“向量和重算队列没被删”（record_consent_impl 以 20261029192000 为准）
insert into public.notes (id, user_id, body, created_at, updated_at) values
  ('40000000-0000-4000-8000-0000000000c6', 'cccccccc-0000-4000-8000-000000000003', 'n', 1, 1);
insert into private.note_vectors (user_id, kind, source_id, note_id, model, content_hash, embedding) values
  ('cccccccc-0000-4000-8000-000000000003', 'note', '40000000-0000-4000-8000-0000000000c6', '40000000-0000-4000-8000-0000000000c6', 'm', 'h',
   ('[' || array_to_string(array_fill(0, array[768]), ',') || ']')::extensions.halfvec);
insert into private.embed_queue (kind, source_id, user_id) values
  ('note', '40000000-0000-4000-8000-0000000000c6', 'cccccccc-0000-4000-8000-000000000003')
  on conflict do nothing;   -- 建随手记时 enqueue_embed 可能已经排进队列
select ok(tests.rows_as('authenticated', 'cccccccc-0000-4000-8000-000000000003',
  format('select public.record_consent(%L, true) as r', (select notice->>'policy_ver' from public.app_config where id = 1)), null,
  'cccccccc-5555-4000-8000-000000000003') ->> 'error' like '%account_disabled%',
  '停用账号（没有 amr）撤销同意：报 account_disabled');
select is((select count(*)::int from public.settings where user_id = 'cccccccc-0000-4000-8000-000000000003'), 0, '停用账号撤销同意：没写 settings');
select is((select (select count(*) from private.note_vectors where user_id = 'cccccccc-0000-4000-8000-000000000003')::int
           + (select count(*) from private.embed_queue where user_id = 'cccccccc-0000-4000-8000-000000000003')::int), 2,
  '停用账号撤销同意：向量和重算队列都没删');

select * from finish();
rollback;
