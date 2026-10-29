-- settings 里 ai.vault、ai.enabled 不准客户端软删 / 撤销；notice 初值（R-239、R-238）；record_consent 一行都没写时报错
-- （迁移 20261029210000_core_settings_ai_guard.sql；依赖 S1 批 20261029191000～20261029201000）
begin;
select plan(44);
\ir _helpers.psql
select tests.seed();   -- A、B 正常，C 停用
-- D：有账号、有会话，但没有 profile 行；E：有 profile，用来模拟“检查之后、update 之前 profile 被改掉”
insert into auth.users (id, email) values
  ('dddddddd-0000-4000-8000-000000000004', 'd@test.local'),
  ('eeeeeeee-0000-4000-8000-000000000005', 'e@test.local');
insert into public.profiles (user_id) values ('eeeeeeee-0000-4000-8000-000000000005');
insert into auth.sessions (id, user_id) values
  ('dddddddd-5555-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000004'),
  ('eeeeeeee-5555-4000-8000-000000000005', 'eeeeeeee-0000-4000-8000-000000000005');

-- A 的会话里执行
create function tests.a(p_sql text) returns text language sql as $$
  select tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', p_sql, null, 'aaaaaaaa-5555-4000-8000-000000000001')
$$;
-- A 调 apply_patch（base_rev 取这一行当前的 rev）：成功回结果 jsonb，失败回 {"error": "<sqlstate> <信息>"}
create function tests.ap(p_id uuid, p_patch jsonb, p_op uuid) returns jsonb language sql as $$
  with x as (select tests.rows_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
    format('select public.apply_patch(''settings'', %L::uuid, %L::jsonb, %s, %L::uuid) as r',
           p_id, p_patch, (select s.rev from public.settings s where s.id = p_id), p_op),
    null, 'aaaaaaaa-5555-4000-8000-000000000001') j)
  select coalesce(j -> 0 -> 'r', j) from x
$$;
create function tests.st(p_id uuid) returns text language sql as $$
  select coalesce(s.deleted_at::text, 'null') || '|' || s.undone::text || '|' || s.value::text from public.settings s where s.id = p_id
$$;
create function tests.ver() returns text language sql as $$ select notice ->> 'policy_ver' from public.app_config where id = 1 $$;

-- ===== ② notice 初值（R-239）、格式（R-238） =====
select is((select notice from public.app_config where id = 1), '{"policy_ver": "2026-10-29", "min_consent_ver": "2026-10-29"}'::jsonb,
  'R-239：notice 初值由迁移写入，两个键都是 2026-10-29');
select ok((select notice ->> 'policy_ver' ~ '^\d{4}-\d{2}-\d{2}(-[1-9]\d?)?$' and notice ->> 'min_consent_ver' ~ '^\d{4}-\d{2}-\d{2}(-[1-9]\d?)?$'
             and (notice ->> 'policy_ver')::date is not null and (notice ->> 'min_consent_ver')::date is not null
             and (select count(*) from jsonb_object_keys(notice)) = 2
          from public.app_config where id = 1),
  'R-238：两个值都合 YYYY-MM-DD(-N) 的格式且是真实日期，只有这两个键');
select ok((select notice ->> 'min_consent_ver' <= notice ->> 'policy_ver' from public.app_config where id = 1), 'R-238 不变式：min_consent_ver <= policy_ver');
select is(tests.rows_as('anon', null, $$select notice ->> 'policy_ver' as v from public.app_config$$), '[{"v": "2026-10-29"}]'::jsonb,
  'anon 也能读到 notice（告知页登录前就要用）');

-- ===== ① 一次性修正之后：库里没有软删 / 撤销的 ai.vault、ai.enabled =====
select is((select count(*)::int from public.settings where key in ('ai.vault', 'ai.enabled') and (deleted_at is not null or undone)), 0,
  '迁移后库里没有软删或撤销的 ai.vault、ai.enabled 行');

-- A 的三行：ai.vault = false（客户端可以关）、ai.enabled = true、ui.font（对照）
select is(tests.a($$insert into public.settings (id, key, value) values
  ('5f000000-0000-4000-8000-000000000001', 'ai.vault', 'false'),
  ('5f000000-0000-4000-8000-000000000002', 'ai.enabled', 'true'),
  ('5f000000-0000-4000-8000-000000000003', 'ui.font', '{"v": 1, "id": "system"}')$$), 'ok', 'A 写入 ai.vault = false、ai.enabled = true、ui.font');

-- ===== ① a. 直接 PATCH（PostgREST 的 update）被拒 =====
select ok(tests.a($$update public.settings set deleted_at = 1 where id = '5f000000-0000-4000-8000-000000000001'$$) like 'P0001 vault_required%',
  '直接软删 ai.vault = false 的行：vault_required（否则等于不用 vault_token 打开隐私记 AI）');
select ok(tests.a($$update public.settings set undone = true where id = '5f000000-0000-4000-8000-000000000001'$$) like 'P0001 vault_required%',
  '直接把 ai.vault 的 undone 写成 true：vault_required');
select ok(tests.a($$update public.settings set deleted_at = 1, value = 'false' where id = '5f000000-0000-4000-8000-000000000001'$$) like 'P0001 vault_required%',
  '值不变、顺带写 deleted_at：照样 vault_required');
select ok(tests.a($$update public.settings set deleted_at = 1 where id = '5f000000-0000-4000-8000-000000000002'$$) like 'P0001 settings_key_immutable%',
  '直接软删 ai.enabled：settings_key_immutable');
select ok(tests.a($$update public.settings set undone = true where id = '5f000000-0000-4000-8000-000000000002'$$) like 'P0001 settings_key_immutable%',
  '直接把 ai.enabled 的 undone 写成 true：settings_key_immutable');
select is(tests.st('5f000000-0000-4000-8000-000000000001') || ',' || tests.st('5f000000-0000-4000-8000-000000000002'), 'null|false|false,null|false|true',
  '被拒以后两行原样未动');
select is(tests.a($$update public.settings set deleted_at = 1 where id = '5f000000-0000-4000-8000-000000000003'$$), 'ok',
  '对照：别的键（ui.font）照常能软删，guard 没有挡多');
select is(tests.a($$update public.settings set undone = true where id = '5f000000-0000-4000-8000-000000000003'$$), 'ok',
  '对照：别的键照常能写 undone');

-- ===== ① a. 其他绕法：删行、insert 带列、upsert、改 key =====
select ok(tests.a($$delete from public.settings where id = '5f000000-0000-4000-8000-000000000001'$$) like '42501%',
  'A 删 ai.vault 行：没有表级 DELETE（42501）');
select ok(not has_table_privilege('authenticated', 'public.settings', 'DELETE'), 'authenticated 对 settings 没有 DELETE 权限');
select ok(tests.a($$insert into public.settings (id, key, value, deleted_at) values ('5f000000-0000-4000-8000-000000000004', 'ai.vault', 'false', 1)$$) like '42501%',
  'insert 带 deleted_at 列：没有列授权（42501）');
select ok(tests.a($$insert into public.settings (id, key, value, undone) values ('5f000000-0000-4000-8000-000000000005', 'ai.enabled', 'false', true)$$) like '42501%',
  'insert 带 undone 列：没有列授权（42501）');
select ok(tests.a($$insert into public.settings (id, key, value) values ('5f000000-0000-4000-8000-000000000006', 'ai.vault', 'false')
  on conflict (user_id, key) do update set undone = true$$) like 'P0001 vault_required%',
  'upsert 撞上已有的 ai.vault、do update set undone = true：vault_required');
select ok(tests.a($$insert into public.settings (id, key, value) values ('5f000000-0000-4000-8000-000000000007', 'ai.enabled', 'false')
  on conflict (user_id, key) do update set undone = true$$) like 'P0001 settings_key_immutable%',
  'upsert 撞上已有的 ai.enabled、do update set undone = true：settings_key_immutable');
select ok(tests.a($$update public.settings set key = 'ai.vault' where id = '5f000000-0000-4000-8000-000000000003'$$) like '42501%',
  '把别的键（ui.font）的 key 改成 ai.vault：没有 key 列的更新授权（42501）');

-- ===== ① a. 经 apply_patch 同样被拒 =====
select ok(tests.ap('5f000000-0000-4000-8000-000000000001', '{"deleted_at": 1}', 'a0f00000-0000-4000-8000-000000000001') ->> 'error' like 'P0001 vault_required%',
  'apply_patch 软删 ai.vault：vault_required');
select ok(tests.ap('5f000000-0000-4000-8000-000000000001', '{"undone": true}', 'a0f00000-0000-4000-8000-000000000002') ->> 'error' like 'P0001 vault_required%',
  'apply_patch 撤销 ai.vault：vault_required');
select ok(tests.ap('5f000000-0000-4000-8000-000000000002', '{"deleted_at": 1}', 'a0f00000-0000-4000-8000-000000000003') ->> 'error' like 'P0001 settings_key_immutable%',
  'apply_patch 软删 ai.enabled：settings_key_immutable');
select ok(tests.ap('5f000000-0000-4000-8000-000000000002', '{"undone": true, "value": false}', 'a0f00000-0000-4000-8000-000000000004') ->> 'error' like 'P0001 settings_key_immutable%',
  'apply_patch 撤销 ai.enabled（顺带改值）：settings_key_immutable，整项回滚');
select is(tests.st('5f000000-0000-4000-8000-000000000001') || ',' || tests.st('5f000000-0000-4000-8000-000000000002')
       || ',' || (select count(*)::int from public.applied_ops where op_id::text like 'a0f00000-%'),
  'null|false|false,null|false|true,0', 'apply_patch 被拒：两行原样、applied_ops 不记（客户端按丢弃码丢掉这一项、整表重拉）');
select is(tests.ap('5f000000-0000-4000-8000-000000000002', '{"value": false}', 'a0f00000-0000-4000-8000-000000000005') ->> 'status', 'ok',
  'apply_patch 只改 ai.enabled 的值：照常 ok');
select is(tests.ap('5f000000-0000-4000-8000-000000000001', '{"value": true}', 'a0f00000-0000-4000-8000-000000000006') ->> 'error', 'P0001 vault_required',
  'apply_patch 把 ai.vault 改成 true：仍是 vault_required（0001 原有的一条照旧）');

-- ===== 恢复（deleted_at 改回 null）不拦；服务器路径不受影响 =====
update public.settings set deleted_at = 1, undone = true where id = '5f000000-0000-4000-8000-000000000002';   -- 以测试的超级用户造一行（模拟服务器写的）
select is(tests.a($$update public.settings set deleted_at = null, undone = false where id = '5f000000-0000-4000-8000-000000000002'$$), 'ok',
  '客户端把 ai.enabled 从“最近删除”恢复、undone 改回 false：可以');
-- set_ai_vault（vault 函数验过 vault_token 后以 service_role 写）：打开、再关
select is(tests.try_as('service_role', null, $$update public.settings set value = 'true' where id = '5f000000-0000-4000-8000-000000000001'$$), 'ok',
  'set_ai_vault 的写法（service_role 把 ai.vault 改成 true）不受影响');
select is(tests.a($$update public.settings set value = 'false' where id = '5f000000-0000-4000-8000-000000000001'$$), 'ok',
  '客户端照常能把 ai.vault 关掉');
select is(tests.try_as('service_role', null, $$update public.settings set deleted_at = 1 where id = '5f000000-0000-4000-8000-000000000001'$$), 'ok',
  'service_role 的写入不过这条 guard（服务器路径不误挡）');
select ok(tests.a($$update public.settings set deleted_at = 2 where id = '5f000000-0000-4000-8000-000000000001'$$) like 'P0001 vault_required%',
  '客户端把 ai.vault 的 deleted_at 从一个非空值改成另一个非空值：vault_required');
select is(tests.a($$update public.settings set deleted_at = null where id = '5f000000-0000-4000-8000-000000000001'$$) || '|' || tests.st('5f000000-0000-4000-8000-000000000001'),
  'ok|null|false|false', '客户端把 ai.vault 从“最近删除”恢复（deleted_at 改回 null）：可以');

-- ===== ① c. 每日清理不硬删 ai.vault、ai.enabled =====
update public.settings set deleted_at = ((extract(epoch from now()) - 31 * 86400) * 1000)::bigint, undone = false
 where id in ('5f000000-0000-4000-8000-000000000001', '5f000000-0000-4000-8000-000000000002', '5f000000-0000-4000-8000-000000000003');
do $$ begin while private.cleanup_batch() > 0 loop end loop; end $$;
select is((select string_agg(key, ',' order by key) from public.settings where id::text like '5f000000-%'), 'ai.enabled,ai.vault',
  '每日清理：31 天前软删的 ui.font 硬删，ai.vault、ai.enabled 留着（删了就回到默认值）');
update public.settings set deleted_at = null where id in ('5f000000-0000-4000-8000-000000000001', '5f000000-0000-4000-8000-000000000002');

-- ===== record_consent 正常路径（定义者函数，在 authenticated 请求里同样过 settings_guard） =====
select is(tests.a(format('select public.record_consent(%L, false)', tests.ver())), 'ok', 'A 用 notice 初值的版本同意：ok');
select is((select (consent_ai_at is not null)::text || '|' || consent_policy_ver from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'true|2026-10-29', '同意后 consent_ai_at、consent_policy_ver 写上');
-- 以测试的超级用户把 ai.enabled 造成“打开、但已软删并撤销”（模拟服务器写的）
update public.settings set value = 'true', deleted_at = 1, undone = true where id = '5f000000-0000-4000-8000-000000000002';
select is(tests.a(format('select public.record_consent(%L, true)', tests.ver())), 'ok',
  'A 撤回：ok（已有 ai.enabled 行，走 on conflict 改值并清 deleted_at、undone，属于恢复，guard 不挡）');
select is(tests.st('5f000000-0000-4000-8000-000000000002') || '|' || (select (consent_ai_at is null)::text from public.profiles where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'null|false|false|true', '撤回把软删、撤销的 ai.enabled 救回成活着的 false，consent_ai_at 清空');
select is(tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', format('select public.record_consent(%L, true)', tests.ver()), null, 'bbbbbbbb-5555-4000-8000-000000000002'),
  'ok', 'B（没有 ai.enabled 行）撤回：insert 新行，guard 不挡');

-- ===== ③ record_consent 一行都没写时报错 =====
select ok(tests.try_as('authenticated', 'dddddddd-0000-4000-8000-000000000004', format('select public.record_consent(%L, false)', tests.ver()), null, 'dddddddd-5555-4000-8000-000000000004')
            like 'P0001 account_disabled%',
  '没有 profile 行：record_consent 报 account_disabled（被开头的 account_usable 挡住，没走到 update profiles）');
select is((select count(*)::int from public.profiles where user_id = 'dddddddd-0000-4000-8000-000000000004')
        + (select count(*)::int from public.settings where user_id = 'dddddddd-0000-4000-8000-000000000004'), 0,
  '没有 profile 行：既没建 profile，也没写设置');
-- 模拟“开头检查通过、update 时 profile 已不能写”（检查和 update 之间被停用）：测试事务里临时挂一个跳过 E 那一行的触发器
create function tests.skip_e() returns trigger language plpgsql as $$ begin return null; end $$;
create trigger tests_skip_e before update on public.profiles for each row
  when (old.user_id = 'eeeeeeee-0000-4000-8000-000000000005') execute function tests.skip_e();
select ok(tests.try_as('authenticated', 'eeeeeeee-0000-4000-8000-000000000005', format('select public.record_consent(%L, true)', tests.ver()), null, 'eeeeeeee-5555-4000-8000-000000000005')
            like 'P0001 account_disabled%',
  'update profiles 一行都没更新：record_consent 报 account_disabled');
select is((select count(*)::int from public.settings where user_id = 'eeeeeeee-0000-4000-8000-000000000005'), 0,
  '一行都没更新时抛错发生在写设置、删向量之前：撤回分支没写 ai.enabled');

select * from finish();
rollback;
