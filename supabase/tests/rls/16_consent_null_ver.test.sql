-- record_consent 拒绝 policy_ver 为 null（迁移 20261029220000_core_consent_null_ver.sql；接手清单 SEC-210000-sugg ④）
-- notice 被清空或缺 policy_ver 键时，右边是 null；旧写法 `p_ver is distinct from (...)` 对 null 传 null 放行，新写法一律拒
-- 10-29 按接手清单 SEC-220000-sugg ①②：缺 policy_ver 键那段被拒后补 tests.prof() 核对；删掉原第 1 条用 pg_get_functiondef like 比源码文字的断言
--   （换个等价写法就误报；判断是否生效由下面按行为的断言保证），plan 仍是 8
-- 10-29 复审建议：补“缺 policy_ver 键 + 传 null 撤回”和 notice 为 {"policy_ver": null}（JSON null）两段，plan 8 → 11
begin;
select plan(11);
\ir _helpers.psql
select tests.seed();   -- A、B 正常，C 停用

create function tests.a(p_sql text) returns text language sql as $$
  select tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', p_sql, null, 'aaaaaaaa-5555-4000-8000-000000000001')
$$;
create function tests.prof() returns text language sql as $$
  select (consent_ai_at is not null)::text || '|' || coalesce(consent_policy_ver, 'null')
    from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'
$$;

-- ===== notice 被清空（以测试的超级用户改，模拟线上误操作） =====
update public.app_config set notice = null where id = 1;
select ok(tests.a($$select public.record_consent(null, false)$$) like 'P0001 policy_ver_mismatch%',
  'notice 为 null 时传 null 同意：policy_ver_mismatch（旧写法 null 对 null 会放行）');
select ok(tests.a($$select public.record_consent(null, true)$$) like 'P0001 policy_ver_mismatch%',
  'notice 为 null 时传 null 撤回：同样 policy_ver_mismatch');
select is(tests.prof() || '|' || (select count(*)::int from public.settings where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'false|null|0', '被拒以后 profile 没记同意、没记版本，撤回分支也没写 ai.enabled');

-- ===== notice 有、但缺 policy_ver 键 =====
update public.app_config set notice = '{"min_consent_ver": "2026-10-29"}' where id = 1;
select ok(tests.a($$select public.record_consent(null, false)$$) like 'P0001 policy_ver_mismatch%',
  'notice 缺 policy_ver 键时传 null：policy_ver_mismatch');
select ok(tests.a($$select public.record_consent('2026-10-29', false)$$) like 'P0001 policy_ver_mismatch%',
  'notice 缺 policy_ver 键时传任何非空版本：照旧 policy_ver_mismatch');
select ok(tests.a($$select public.record_consent(null, true)$$) like 'P0001 policy_ver_mismatch%',
  'notice 缺 policy_ver 键时传 null 撤回：同样 policy_ver_mismatch');
select is(tests.prof(), 'false|null', 'notice 缺 policy_ver 键时三次都被拒：profile 仍没记同意、没记版本');

-- ===== notice 的 policy_ver 是 JSON null（->> 取出来同样是 SQL null） =====
update public.app_config set notice = '{"policy_ver": null, "min_consent_ver": "2026-10-29"}' where id = 1;
select ok(tests.a($$select public.record_consent(null, false)$$) like 'P0001 policy_ver_mismatch%',
  'notice 的 policy_ver 为 JSON null 时传 null 同意：policy_ver_mismatch');
select is(tests.prof() || '|' || (select count(*)::int from public.settings where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'false|null|0', 'policy_ver 为 JSON null 时被拒：profile 没记同意、没记版本，也没写 ai.enabled');

-- ===== 对照：notice 正常时 =====
update public.app_config set notice = jsonb_build_object('policy_ver', '2026-10-29', 'min_consent_ver', '2026-10-29') where id = 1;
select ok(tests.a($$select public.record_consent(null, false)$$) like 'P0001 policy_ver_mismatch%',
  'notice 正常时传 null：policy_ver_mismatch');
select is(tests.a($$select public.record_consent('2026-10-29', false)$$) || '|' || tests.prof(), 'ok|true|2026-10-29',
  '对照：notice 正常、传当前版本同意照常 ok，并记下同意时间和版本');

select * from finish();
rollback;
