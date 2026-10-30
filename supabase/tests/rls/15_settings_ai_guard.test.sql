-- settings 里 ai.vault、ai.enabled 不准客户端软删 / 撤销；notice 初值（R-239、R-238）；record_consent 一行都没写时报错
-- （迁移 20261029210000_core_settings_ai_guard.sql；依赖 S1 批 20261029191000～20261029201000）
-- 10-29 补安全补审建议（接手清单 SEC-210000-sugg ①②③⑤⑥）：upsert 撞已有行写 deleted_at、definer 帮手测 guard 的 INSERT 分支、
--   抛错后向量和队列还在、相似 key 对照、一次性修正对脏行的效果；④ 在 16_consent_null_ver.test.sql
-- 10-30 R-271（SEC-210000-sugg ⑧，迁移 20261030120000_core_settings_quota_ai_keys.sql）：settings 满 2 万行时撤回、同意照样成功（四种撤回情况），
--   ai.foo、ui.theme、大小写不同的 AI.enabled 满额照样报 quota；plan 59 → 77；10-31 settings_key_fmt 加一条被拒 → 78
begin;
select plan(78);
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
-- SEC-210000-sugg ⑤：guard 和 consent.ts 都只认精确的 key。
--   10-31 起 settings_key_fmt（迁移 20261031110000，架构 0.47 第 20 条补）只收小写点分的键：大小写不同（AI.vault）、末尾带空格（'ai.vault '）直接被拒
select is(left(tests.a($$insert into public.settings (id, key, value) values ('5e000000-0000-4000-8000-0000000000e1', 'AI.vault', 'true')$$), 5)
       || '|' || left(tests.a($$insert into public.settings (id, key, value) values ('5e000000-0000-4000-8000-0000000000e2', 'ai.vault ', 'true')$$), 5)
       || '|' || left(tests.a($$insert into public.settings (id, key, value) values ('5e000000-0000-4000-8000-0000000000e3', 'AI.ENABLED', 'true')$$), 5),
  '23514|23514|23514', 'settings_key_fmt：key 写成 AI.vault、''ai.vault ''（末尾带空格）、AI.ENABLED 都被拒（23514）');
--   格式合规、但不是精确 ai.vault / ai.enabled 的键是别的键：guard 不挡（能写 true、能软删、能撤销），
--   consent.ts 按 .in('key', ['ai.enabled', 'ai.vault']) 精确匹配也读不到它们
select is(tests.a($$insert into public.settings (id, key, value) values
  ('5e000000-0000-4000-8000-000000000001', 'ai.vault_old', 'true'),
  ('5e000000-0000-4000-8000-000000000002', 'ai.vault-x', 'true'),
  ('5e000000-0000-4000-8000-000000000003', 'ai.enabled2', 'true')$$), 'ok',
  '对照：key 写成 ai.vault_old、ai.vault-x、ai.enabled2，值为 true 也能写入（不是 ai.vault，guard 和布尔约束都不管）');
select is(tests.a($$update public.settings set deleted_at = 1 where id in ('5e000000-0000-4000-8000-000000000001', '5e000000-0000-4000-8000-000000000003')$$)
       || '|' || tests.a($$update public.settings set undone = true where id = '5e000000-0000-4000-8000-000000000002'$$), 'ok|ok',
  '对照：这几行能软删、能撤销（guard 只认精确 key）');
select is((select string_agg(key || '=' || value::text || '|' || coalesce(deleted_at::text, 'null') || '|' || undone::text, ',' order by key)
             from public.settings where user_id = 'aaaaaaaa-0000-4000-8000-000000000001' and key in ('ai.enabled', 'ai.vault')),
  'ai.enabled=true|null|false,ai.vault=false|null|false',
  '按 consent.ts 的精确匹配读：只有真正的 ai.vault（false）、ai.enabled（true）两行，相似 key 的行不影响同意判断');

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
-- SEC-210000-sugg ①：upsert 撞上已有行、do update set deleted_at（上面两条是 undone）
select ok(tests.a($$insert into public.settings (id, key, value) values ('5f000000-0000-4000-8000-000000000008', 'ai.vault', 'false')
  on conflict (user_id, key) do update set deleted_at = 1$$) like 'P0001 vault_required%',
  'upsert 撞上已有的 ai.vault、do update set deleted_at = 1：vault_required');
select ok(tests.a($$insert into public.settings (id, key, value) values ('5f000000-0000-4000-8000-000000000009', 'ai.enabled', 'false')
  on conflict (user_id, key) do update set deleted_at = 1$$) like 'P0001 settings_key_immutable%',
  'upsert 撞上已有的 ai.enabled、do update set deleted_at = 1：settings_key_immutable');
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

-- ===== SEC-210000-sugg ②：guard 的 INSERT 分支（迁移第 49、50 行的 tg_op = 'INSERT'） =====
-- 客户端没有 deleted_at、undone 的 insert 列授权（上面 42501 两条），走不到 guard；这里在测试事务里临时建一个
--   postgres 属主的 security definer 帮手（同 record_consent_impl 的处境：定义者有全部列权限、请求角色仍是 authenticated），
--   以 authenticated 身份调用它 insert 带 deleted_at 或 undone 的行，断言 guard 照样拦
create function tests.definer_ins(p_key text, p_del bigint, p_undone boolean) returns void
  language sql security definer set search_path = '' as $$
  insert into public.settings (id, user_id, key, value, deleted_at, undone)
  values (gen_random_uuid(), (select auth.uid()), p_key, 'false'::jsonb, p_del, p_undone)
$$;
alter function tests.definer_ins(text, bigint, boolean) owner to postgres;
grant usage on schema tests to authenticated;
grant execute on function tests.definer_ins(text, bigint, boolean) to authenticated;
create function tests.b(p_sql text) returns text language sql as $$
  select tests.try_as('authenticated', 'bbbbbbbb-0000-4000-8000-000000000002', p_sql, null, 'bbbbbbbb-5555-4000-8000-000000000002')
$$;
select ok(tests.b($$select tests.definer_ins('ai.vault', 1, false)$$) like 'P0001 vault_required%',
  'definer 帮手以 authenticated 请求 insert 带 deleted_at 的 ai.vault：vault_required（INSERT 分支）');
select ok(tests.b($$select tests.definer_ins('ai.vault', null, true)$$) like 'P0001 vault_required%',
  'definer 帮手 insert undone = true 的 ai.vault：vault_required');
select ok(tests.b($$select tests.definer_ins('ai.enabled', 1, false)$$) like 'P0001 settings_key_immutable%'
      and tests.b($$select tests.definer_ins('ai.enabled', null, true)$$) like 'P0001 settings_key_immutable%',
  'definer 帮手 insert 带 deleted_at 或 undone = true 的 ai.enabled：settings_key_immutable（guard 在唯一约束之前触发）');
select is((select count(*)::int from public.settings where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' and key in ('ai.vault', 'ai.enabled')
             and (deleted_at is not null or undone)), 0,
  '上面四次被拒都没留下软删或撤销的行');
-- 写入要在下一句才看得见（同一句里的子查询用的是语句开始时的快照），所以分两句
select is(tests.b($$select tests.definer_ins('ai.vault', null, false)$$), 'ok',
  '对照：同一个帮手 insert 不带 deleted_at、undone 的 ai.vault = false 能写成功（证明上面是 guard 拦的，不是帮手本身写不进）');
select is((select count(*)::int from public.settings where user_id = 'bbbbbbbb-0000-4000-8000-000000000002' and key = 'ai.vault' and deleted_at is null and not undone), 1,
  '对照：B 的 ai.vault = false 已写入、活着');

-- ===== ③ record_consent 一行都没写时报错 =====
select ok(tests.try_as('authenticated', 'dddddddd-0000-4000-8000-000000000004', format('select public.record_consent(%L, false)', tests.ver()), null, 'dddddddd-5555-4000-8000-000000000004')
            like 'P0001 account_disabled%',
  '没有 profile 行：record_consent 报 account_disabled（被开头的 account_usable 挡住，没走到 update profiles）');
select is((select count(*)::int from public.profiles where user_id = 'dddddddd-0000-4000-8000-000000000004')
        + (select count(*)::int from public.settings where user_id = 'dddddddd-0000-4000-8000-000000000004'), 0,
  '没有 profile 行：既没建 profile，也没写设置');
-- 模拟“开头检查通过、update 时 profile 已不能写”（检查和 update 之间被停用）：测试事务里临时挂一个跳过 E 那一行的触发器
-- ③：先给 E 种一条随手记的向量和重算队列，抛错后核对还在
insert into public.notes (id, user_id, body, created_at, updated_at) values
  ('40000000-0000-4000-8000-0000000000e5', 'eeeeeeee-0000-4000-8000-000000000005', 'n', 1, 1);
insert into private.note_vectors (user_id, kind, source_id, note_id, model, content_hash, embedding) values
  ('eeeeeeee-0000-4000-8000-000000000005', 'note', '40000000-0000-4000-8000-0000000000e5', '40000000-0000-4000-8000-0000000000e5', 'm', 'h',
   ('[' || array_to_string(array_fill(0, array[768]), ',') || ']')::extensions.halfvec);
insert into private.embed_queue (kind, source_id, user_id) values
  ('note', '40000000-0000-4000-8000-0000000000e5', 'eeeeeeee-0000-4000-8000-000000000005')
  on conflict do nothing;   -- 建随手记时 enqueue_embed 可能已经排进队列
create function tests.skip_e() returns trigger language plpgsql as $$ begin return null; end $$;
create trigger tests_skip_e before update on public.profiles for each row
  when (old.user_id = 'eeeeeeee-0000-4000-8000-000000000005') execute function tests.skip_e();
select ok(tests.try_as('authenticated', 'eeeeeeee-0000-4000-8000-000000000005', format('select public.record_consent(%L, true)', tests.ver()), null, 'eeeeeeee-5555-4000-8000-000000000005')
            like 'P0001 account_disabled%',
  'update profiles 一行都没更新：record_consent 报 account_disabled');
select is((select count(*)::int from public.settings where user_id = 'eeeeeeee-0000-4000-8000-000000000005'), 0,
  '一行都没更新时抛错发生在写设置、删向量之前：撤回分支没写 ai.enabled');
select is((select count(*)::int from private.note_vectors where user_id = 'eeeeeeee-0000-4000-8000-000000000005')
       || '|' || (select count(*)::int from private.embed_queue where user_id = 'eeeeeeee-0000-4000-8000-000000000005'
                    and source_id = '40000000-0000-4000-8000-0000000000e5'),
  '1|1', 'SEC-210000-sugg ③：抛错之后 E 事先种下的向量和重算队列都还在（撤回分支的删除没执行）');

-- ===== SEC-210000-sugg ⑥：一次性修正（迁移第 58–61 行）对脏行的效果 =====
-- 迁移跑的时候库里没有脏行，修正语句等于没被测过。这里以测试的超级用户先造脏行（模拟服务器写过的软删 / 撤销），
--   再逐字执行迁移第 58–61 行（改迁移这两句时同步改这里）：
--   D：ai.vault = false 已软删、ai.enabled = true 只撤销（迁移注释里的例外：修正后变成 false）、ui.font 已软删（对照，不碰）；
--   E：ai.vault = true 已撤销又软删（值不变，只救回）
insert into public.settings (id, user_id, key, value, deleted_at, undone) values
  ('5d000000-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000004', 'ai.vault', 'false', 5, false),
  ('5d000000-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000004', 'ai.enabled', 'true', null, true),
  ('5d000000-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000004', 'ui.font', '{"v": 1, "id": "system"}', 5, true),
  ('5d000000-0000-4000-8000-000000000004', 'eeeeeeee-0000-4000-8000-000000000005', 'ai.vault', 'true', 6, true);
update public.settings set deleted_at = null, undone = false
 where key = 'ai.vault' and (deleted_at is not null or undone);
update public.settings set value = 'false'::jsonb, deleted_at = null, undone = false
 where key = 'ai.enabled' and (deleted_at is not null or undone);
select is(tests.st('5d000000-0000-4000-8000-000000000001') || ',' || tests.st('5d000000-0000-4000-8000-000000000004'), 'null|false|false,null|false|true',
  '一次性修正：软删、撤销的 ai.vault 救回成活着的行，值不变（false 仍是 false、true 仍是 true）');
select is(tests.st('5d000000-0000-4000-8000-000000000002'), 'null|false|false',
  '一次性修正：只撤销的 ai.enabled = true 救回时改成 false（方向是“关”）');
select is(tests.st('5d000000-0000-4000-8000-000000000003'), '5|true|{"v": 1, "id": "system"}',
  '一次性修正只动这两个键：软删、撤销的 ui.font 原样不动');

-- ===== R-271（SEC-210000-sugg ⑧）：settings 满额时撤回 / 同意照样成功；只放行 ai.enabled、ai.vault 两个精确的键 =====
-- 改之前：settings_quota 是 before insert 触发器，insert … on conflict 也先触发它，满 2 万行时撤回回 quota、整个调用回滚（同意却能成功）。
-- F：新账号，以测试的超级用户铺 19999 行普通键（迁移角色不计配额），之后也以超级用户调状态；F 自己的写入都走 authenticated
insert into auth.users (id, email) values ('f1f1f1f1-0000-4000-8000-000000000006', 'f@test.local');
insert into public.profiles (user_id) values ('f1f1f1f1-0000-4000-8000-000000000006');
insert into auth.sessions (id, user_id) values ('f1f1f1f1-5555-4000-8000-000000000006', 'f1f1f1f1-0000-4000-8000-000000000006');
create function tests.f(p_sql text) returns text language sql as $$
  select tests.try_as('authenticated', 'f1f1f1f1-0000-4000-8000-000000000006', p_sql, null, 'f1f1f1f1-5555-4000-8000-000000000006')
$$;
-- 是否已同意 | ai.enabled 的值（没有这一行写 none）| F 的 settings 行数
create function tests.fst() returns text language sql as $$
  select (select (consent_ai_at is not null)::text from public.profiles where user_id = 'f1f1f1f1-0000-4000-8000-000000000006')
    || '|' || coalesce((select value::text from public.settings where user_id = 'f1f1f1f1-0000-4000-8000-000000000006' and key = 'ai.enabled'), 'none')
    || '|' || (select count(*) from public.settings where user_id = 'f1f1f1f1-0000-4000-8000-000000000006')::text
$$;
insert into public.settings (id, user_id, key, value)
  select gen_random_uuid(), 'f1f1f1f1-0000-4000-8000-000000000006', 'qa.k' || g, 'true'::jsonb from generate_series(1, 19999) g;

-- 情况一：19999 行，撤回写进第 2 万行
select is(tests.f(format('select public.record_consent(%L, true)', tests.ver())), 'ok', 'R-271 ①：19999 行时撤回：ok');
select is(tests.fst(), 'false|false|20000', 'R-271 ①：撤回写了 ai.enabled = false，正好占掉第 2 万行');
-- 情况四：已满 2 万行、ai.enabled 行已在（on conflict 那条路）：再同意、再撤回
select is(tests.f(format('select public.record_consent(%L, false)', tests.ver())), 'ok', 'R-271 ④：满额时同意：ok（同意分支不写 settings）');
select is(tests.f(format('select public.record_consent(%L, true)', tests.ver())), 'ok',
  'R-271 ④：满额、ai.enabled 行已在时再撤回：ok（insert … on conflict 先触发 before insert，改之前这里回 quota）');
select is(tests.fst(), 'false|false|20000', 'R-271 ④：撤回生效（同意已清、ai.enabled = false），行数不变');
-- 情况三：满 2 万行，其中 ai.enabled = true（客户端打开过 AI）
update public.settings set value = 'true'::jsonb where user_id = 'f1f1f1f1-0000-4000-8000-000000000006' and key = 'ai.enabled';
select is(tests.f(format('select public.record_consent(%L, false)', tests.ver())), 'ok', 'R-271 ③：满额、ai.enabled = true 时同意：ok');
select is(tests.f(format('select public.record_consent(%L, true)', tests.ver())), 'ok', 'R-271 ③：满额、ai.enabled = true 时撤回：ok');
select is(tests.fst(), 'false|false|20000', 'R-271 ③：撤回把 ai.enabled 改成 false、清掉同意');
-- 情况二：满 2 万行，没有 ai.enabled 行（撤回要新插一行，成为第 20001 行）
delete from public.settings where user_id = 'f1f1f1f1-0000-4000-8000-000000000006' and key = 'ai.enabled';
insert into public.settings (id, user_id, key, value) values (gen_random_uuid(), 'f1f1f1f1-0000-4000-8000-000000000006', 'qa.k20000', 'true');
select is(tests.fst(), 'false|none|20000', 'R-271 ②：铺好：2 万行普通键，没有 ai.enabled');
select is(tests.f(format('select public.record_consent(%L, false)', tests.ver())), 'ok', 'R-271 ②：满额时同意：ok');
select is(tests.fst(), 'true|none|20000', 'R-271 ②：同意记下了');
select is(tests.f(format('select public.record_consent(%L, true)', tests.ver())), 'ok', 'R-271 ②：满额、没有 ai.enabled 行时撤回：ok');
select is(tests.fst(), 'false|false|20001', 'R-271 ②：撤回新插了 ai.enabled = false（第 20001 行），同意已清');
-- 只放行两个精确的键：别的 ai.* 键、普通键、大小写不同的写法满额照样报 quota；ai.vault = false 放行
select ok(tests.f($$insert into public.settings (id, key, value) values (gen_random_uuid(), 'ai.foo', 'true')$$) like 'P0001 quota%',
  'R-271：满额时插 ai.foo：quota（不按 ai.* 前缀放宽）');
select ok(tests.f($$insert into public.settings (id, key, value) values (gen_random_uuid(), 'ui.theme', '"dark"')$$) like 'P0001 quota%',
  'R-271：满额时插 ui.theme：quota');
select ok(tests.f($$insert into public.settings (id, key, value) values (gen_random_uuid(), 'AI.enabled', 'false')$$) like 'P0001 quota%',
  'R-271：满额时插 AI.enabled（大小写不同，是别的键）：quota');
select is(tests.f($$insert into public.settings (id, key, value) values (gen_random_uuid(), 'ai.vault', 'false')$$), 'ok',
  'R-271：满额时关隐私记 AI（插 ai.vault = false）：ok');
select is((select count(*)::int from public.settings where user_id = 'f1f1f1f1-0000-4000-8000-000000000006'), 20002,
  'R-271：三次被拒都没写进去，只多了 ai.vault 一行（每人最多比上限多 2 行）');

select * from finish();
rollback;
