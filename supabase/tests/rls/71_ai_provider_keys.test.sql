-- 迁移 20261123090000_ai_provider_keys.sql：自行更换 AI 服务商（R-494）
-- 覆盖：
--   ① 两个存取密钥的函数：anon、authenticated 调了 42501；service_role 能调；名字、密钥格式不对 22023（在碰 Vault 之前就拦下，离线库没有 vault 也能测）；
--   ② private.ai_user_keys：anon、authenticated 读写都 42501；service_role 能读写；check 约束拦不合法的服务商、模型名、后四位；
--   ③ 账号删了（auth.users）这张表的行级联删；
--   ④ notice 升到 2026-11-23（所有人重新同意）；
--   ⑤ 只有 Vault 里有、表里没有那一行（孤儿密钥）时，account-purge 注销那一步（ai_secret_set(名字, null)）能删干净；
--   ⑥ fell_back_why 只认 auth、quota。
-- Vault 真存取只在 supabase test db（真 Docker 库）里有 vault 扩展；离线库 PGlite 没有，⑤ 在这个事务里建一张假的 vault.secrets（最后回滚）。
-- 用户：A、B（tests.seed）
begin;
select plan(23);
\ir _helpers.psql
select tests.seed();

-- ===== ① 函数授权 =====
select ok(tests.try_as('anon', null, $$select private.ai_secret_get('ai_key_openai')$$) like '42501%', 'anon 调 ai_secret_get：42501');
select ok(tests.try_as('anon', null, $$select private.ai_secret_set('ai_key_openai', 'sk-test-00000000')$$) like '42501%', 'anon 调 ai_secret_set：42501');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select private.ai_secret_get('ai_key_openai')$$) like '42501%', 'authenticated 调 ai_secret_get：42501');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select private.ai_secret_set('ai_key_openai', 'sk-test-00000000')$$) like '42501%', 'authenticated 调 ai_secret_set：42501');
select ok(has_function_privilege('service_role', 'private.ai_secret_set(text, text)', 'EXECUTE') and has_function_privilege('service_role', 'private.ai_secret_get(text)', 'EXECUTE'),
  'service_role 能执行两个函数');
select ok(tests.try_as('service_role', null, $$select private.ai_secret_set('functions_url', 'sk-test-00000000')$$) like '22023%', '名字不是 ai_key_<服务商> / ai_ukey_<uuid>：22023（cron 的 functions_url 动不了）');
select ok(tests.try_as('service_role', null, $$select private.ai_secret_get('ai_key_mistral')$$) like '22023%', '不认的服务商：22023');
select ok(tests.try_as('service_role', null, $$select private.ai_secret_set('ai_key_openai', 'short')$$) like '22023%'
      and tests.try_as('service_role', null, $$select private.ai_secret_set('ai_key_openai', 'sk-test 0000000')$$) like '22023%'
      and tests.try_as('service_role', null, format($$select private.ai_secret_set('ai_key_openai', %L)$$, repeat('k', 301))) like '22023%',
  '密钥太短、带空格、超过 300 字：22023');
-- 迁移 20261123110000（联网换 Brave、Tavily）：名字也认这两家，别的搜索服务商照旧不认
select ok(private.ai_key_name_ok('ai_key_brave') and private.ai_key_name_ok('ai_key_tavily'), '20261123110000：ai_key_brave、ai_key_tavily 认');
select ok(not private.ai_key_name_ok('ai_key_bing') and not private.ai_key_name_ok('ai_key_brave2') and not private.ai_key_name_ok('ai_ukey_brave'),
  '20261123110000：别的搜索服务商、拼错的不认');
-- 迁移 20261124130000（联网加 Naver）：ai_key_naver 也认，拼错的照旧不认；DeepSeek 搜索用的 ai_key_deepseek 本来就认
select ok(private.ai_key_name_ok('ai_key_naver') and private.ai_key_name_ok('ai_key_deepseek') and not private.ai_key_name_ok('ai_key_naver2')
      and private.ai_key_name_ok('ai_key_brave') and private.ai_key_name_ok('ai_key_tavily'),
  '20261124130000：ai_key_naver 认、Brave / Tavily 照旧认，拼错的不认');

-- ===== ② 表授权和约束 =====
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select * from private.ai_user_keys$$) like '42501%', 'authenticated 读 ai_user_keys：42501');
select ok(tests.try_as('anon', null, $$insert into private.ai_user_keys (user_id, provider, model, key_last4) values ('aaaaaaaa-0000-4000-8000-000000000001', 'openai', 'gpt-x', '1234')$$) like '42501%',
  'anon 写 ai_user_keys：42501');
select is(tests.try_as('service_role', null, $$insert into private.ai_user_keys (user_id, provider, model, key_last4, active) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'openai', 'gpt-4.1-mini', '1234', true),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'claude', 'claude-x', '9999', false)$$), 'ok', 'service_role 能写');
select ok(tests.try_as('service_role', null, $$insert into private.ai_user_keys (user_id, provider, model, key_last4) values ('bbbbbbbb-0000-4000-8000-000000000002', 'mistral', 'm', '1')$$) like '23514%',
  '不认的服务商被 check 拦下');
select ok(tests.try_as('service_role', null, $$update private.ai_user_keys set model = 'bad model', key_last4 = '12345' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) like '23514%',
  '模型名带空格、后四位超过 4 个字被 check 拦下');
select ok(tests.try_as('service_role', null, $$update private.ai_user_keys set fell_back_at = now(), fell_back_why = 'timeout' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) like '23514%'
      and tests.try_as('service_role', null, $$update private.ai_user_keys set fell_back_at = now(), fell_back_why = 'quota' where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'$$) = 'ok',
  'fell_back_why 只认 auth、quota');

-- ===== ③ 账号删了级联删 =====
delete from auth.users where id = 'bbbbbbbb-0000-4000-8000-000000000002';
select is((select array_agg(user_id::text) from private.ai_user_keys), array['aaaaaaaa-0000-4000-8000-000000000001'], 'B 的账号删了，B 那行跟着删，A 的还在');

-- ===== Vault 往返（只在有 vault 扩展的真库里真跑；离线库 PGlite 没有，这条按通过记） =====
create function tests.ai_vault_roundtrip() returns boolean language plpgsql as $$
declare ok1 boolean; ok2 boolean; ok3 boolean;
begin
  perform private.ai_secret_set('ai_ukey_aaaaaaaa-0000-4000-8000-000000000001', 'sk-test-11111111');
  ok1 := private.ai_secret_get('ai_ukey_aaaaaaaa-0000-4000-8000-000000000001') = 'sk-test-11111111';
  perform private.ai_secret_set('ai_ukey_aaaaaaaa-0000-4000-8000-000000000001', 'sk-test-22222222');
  ok2 := private.ai_secret_get('ai_ukey_aaaaaaaa-0000-4000-8000-000000000001') = 'sk-test-22222222';
  delete from private.ai_user_keys where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';   -- 触发器连 Vault 那条一起删
  ok3 := private.ai_secret_get('ai_ukey_aaaaaaaa-0000-4000-8000-000000000001') is null;
  return ok1 and ok2 and ok3;
end $$;
select ok(case when to_regclass('vault.secrets') is null then true else tests.ai_vault_roundtrip() end,
  '有 Vault 时：存、改、取对得上；删记录后 Vault 那条也没了');

-- ===== ④ 重新同意 =====
select is((select notice from public.app_config where id = 1), '{"policy_ver": "2026-11-25", "min_consent_ver": "2026-11-25"}'::jsonb, 'notice 先升到 2026-11-23（R-494），再由 20261124140000 升到 2026-11-25（联网加 Naver）');

-- ===== ⑤ 孤儿密钥：只有 Vault 里有、表里没有那一行 =====
-- 离线库没有 vault：建一张同名的假表（只要 name 列，ai_secret_set 删除那一支只用到它），事务结束回滚
do $$
begin
  if to_regclass('vault.secrets') is null then
    create schema vault;
    create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
  end if;
end $$;
create function tests.ai_orphan_put(p_name text) returns void language plpgsql as $$
begin
  -- 按名字认真 Vault 的 create_secret：它是 4 个参数（第 4 个 key_id 有默认值），按 (text, text, text) 查 to_regprocedure 查不到，
  -- 会落到下面直接写 vault.secrets，真库上 postgres 没有加密触发器 _crypto_aead_det_noncegen 的执行权（42501，ci #509 后本机实测）
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'vault' and p.proname = 'create_secret') then
    execute 'select vault.create_secret($1, $2, $3)' using 'sk-test-33333333', p_name, 'test';
  else
    insert into vault.secrets (name, secret) values (p_name, 'sk-test-33333333');
  end if;
end $$;
select tests.ai_orphan_put('ai_ukey_bbbbbbbb-0000-4000-8000-000000000002');
select ok((select count(*) from vault.secrets where name = 'ai_ukey_bbbbbbbb-0000-4000-8000-000000000002') = 1
      and not exists (select 1 from private.ai_user_keys where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'),
  '前提：B 的密钥只在 Vault 里，表里没有那一行（B 的账号上面已删，触发器碰不到它）');
select is(tests.try_as('service_role', null, $$select private.ai_secret_set('ai_ukey_bbbbbbbb-0000-4000-8000-000000000002', null)$$), 'ok',
  'account-purge 注销那一步：service_role 调 ai_secret_set(名字, null)');
select is((select count(*)::int from vault.secrets where name = 'ai_ukey_bbbbbbbb-0000-4000-8000-000000000002'), 0, '孤儿密钥删干净了');

select * from finish();
rollback;
