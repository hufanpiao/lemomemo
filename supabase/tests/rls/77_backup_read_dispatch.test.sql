-- B7a 评审返工（迁移 20261126130000，负责人 11-26 定）：备份专用读取口 private.backup_read、发请求的 private.backup_dispatch、
-- 当天没备份的人数 private.backup_missing，以及调 backup_dispatch 的两条定时任务（原 75_backup_daily_cron.test.sql 并进来，B7a 复审“重复和简化”）。
-- backup_dispatch 真的发请求要 pg_net（离线 PGlite 没有），这里只看定义和授权；真调用在本机 lemo-e2e 的备份链路里验。
-- 真库上可能已有别的数据：backup_missing 一律和开头的基数比差值；日期用 2999-01-01（种的账号都早于它，又不会有真备份）。
begin;
select plan(29);
\ir _helpers.psql
select tests.seed();

-- 种数据：A 两条通行密钥、三条记忆；B 一条通行密钥、一条记忆；两人都设了隐私记 PIN
insert into private.vault (user_id, pin_hash) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'hash-a'), ('bbbbbbbb-0000-4000-8000-000000000002', 'hash-b');
insert into private.vault_credentials (credential_id, user_id, public_key) values
  ('cred-a-2', 'aaaaaaaa-0000-4000-8000-000000000001', '\x0102'),
  ('cred-a-1', 'aaaaaaaa-0000-4000-8000-000000000001', '\x0304'),
  ('cred-b-1', 'bbbbbbbb-0000-4000-8000-000000000002', '\x0506');
insert into private.ai_memories (id, user_id, text, norm, created_at, updated_at) values
  ('aaaaaaaa-7777-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', '记忆三', '记忆三', 3, 3),
  ('aaaaaaaa-7777-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '记忆一', '记忆一', 1, 1),
  ('aaaaaaaa-7777-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', '记忆二', '记忆二', 2, 2),
  ('bbbbbbbb-7777-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', '别人的', '别人的', 1, 1);

-- ① 授权：读取口和当天没备份的人数只给 service_role；发请求的函数谁都不给；service_role 对隐私记四张表仍没有表级权限
select ok(has_function_privilege('service_role', 'private.backup_read(text, uuid, uuid, int)', 'EXECUTE')
          and not has_function_privilege('anon', 'private.backup_read(text, uuid, uuid, int)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.backup_read(text, uuid, uuid, int)', 'EXECUTE')
          and not has_function_privilege('fn_vault', 'private.backup_read(text, uuid, uuid, int)', 'EXECUTE'), 'backup_read 只给 service_role');
select ok(has_function_privilege('service_role', 'private.backup_missing(text)', 'EXECUTE')
          and not has_function_privilege('anon', 'private.backup_missing(text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.backup_missing(text)', 'EXECUTE'), 'backup_missing 只给 service_role');
select ok(not has_function_privilege('service_role', 'private.backup_dispatch(text)', 'EXECUTE')
          and not has_function_privilege('anon', 'private.backup_dispatch(text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.backup_dispatch(text)', 'EXECUTE'), 'backup_dispatch 不授给任何角色（只有 postgres：cron 和发布脚本）');
select ok(not has_table_privilege('service_role', 'private.vault', 'SELECT')
          and not has_table_privilege('service_role', 'private.vault_credentials', 'SELECT')
          and not has_table_privilege('service_role', 'private.device_secrets', 'SELECT')
          and not has_table_privilege('service_role', 'private.vault_ai', 'SELECT'), 'service_role 对隐私记四张表仍没有 select（负责人 11-26：不放宽表级权限）');
select is((select bool_and(p.prosecdef and p.provolatile = 's' and pg_get_userbyid(p.proowner) = 'postgres' and p.proconfig = array['search_path=""'])
   from pg_proc p where p.oid in ('private.backup_read(text, uuid, uuid, int)'::regprocedure, 'private.backup_missing(text)'::regprocedure)), true,
  'backup_read、backup_missing：security definer、stable、search_path 置空、属主 postgres');
select is((select not p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p where p.oid = 'private.backup_dispatch(text)'::regprocedure), true,
  'backup_dispatch 不是 definer（只有 postgres 能调，用不着），search_path 置空');

-- ② 读取口：以 service_role 身份读，只回本人的行，按主键排序、分页
set local role service_role;
select is(jsonb_array_length(private.backup_read('vault', 'aaaaaaaa-0000-4000-8000-000000000001', null, 1000)), 1, 'vault：A 只有自己那一行');
select is((select jsonb_agg(x->>'credential_id') from jsonb_array_elements(private.backup_read('vault_credentials', 'aaaaaaaa-0000-4000-8000-000000000001', null, 1000)) x),
  '["cred-a-1", "cred-a-2"]'::jsonb, 'vault_credentials：只有 A 的两条，按 credential_id 排；public_key 一起带出');
select is((select jsonb_agg(x->>'id') from jsonb_array_elements(private.backup_read('ai_memories', 'aaaaaaaa-0000-4000-8000-000000000001', null, 2)) x),
  '["aaaaaaaa-7777-4000-8000-000000000001", "aaaaaaaa-7777-4000-8000-000000000002"]'::jsonb, 'ai_memories：每页 2 条，按 id 排，没有 B 的');
select is((select jsonb_agg(x->>'id') from jsonb_array_elements(private.backup_read('ai_memories', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-7777-4000-8000-000000000002', 2)) x),
  '["aaaaaaaa-7777-4000-8000-000000000003"]'::jsonb, 'ai_memories：从上一页最后一个 id 往后翻');
select is(private.backup_read('device_secrets', 'aaaaaaaa-0000-4000-8000-000000000001', null, 10) || private.backup_read('vault_ai', 'aaaaaaaa-0000-4000-8000-000000000001', null, 10),
  '[]'::jsonb, 'device_secrets、vault_ai 没有行时回空数组');
reset role;
-- 离线 PGlite 的 pgTAP 没有 throws_ok，照 26、47 的写法用 tests.try_as 回 sqlstate（仍以 service_role 身份调）
select is(tests.try_as('service_role', null, $$select private.backup_read('notes', 'aaaaaaaa-0000-4000-8000-000000000001', null, 10)$$),
  '22023 backup_read: table not allowed', '不在五张表里的表名直接报错（不拼 SQL）');
select is(tests.try_as('service_role', null, $$select private.backup_read('ai_memories', 'aaaaaaaa-0000-4000-8000-000000000001', null, 1002)$$),
  '22023 backup_read: bad arguments', '每页超过 1001 行报错');
select is(tests.try_as('service_role', null, $$select private.backup_read('vault', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-7777-4000-8000-000000000001', 10)$$),
  '22023 backup_read: no paging', 'vault 不分页，带 p_after 报错');

-- ③ 当天没备份的人数：有当天 _manifest 的不算；停用的 C 本来就不算
create temp table miss_base as select private.backup_missing('2999-01-01') as n;
insert into storage.objects (bucket_id, name) values
  ('backups', '2999-01-01/aaaaaaaa-0000-4000-8000-000000000001/_manifest.json.gz'),
  ('backups', '2999-01-01/cccccccc-0000-4000-8000-000000000003/_manifest.json.gz'),
  ('backups', '2999-01-01/bbbbbbbb-0000-4000-8000-000000000002/a_notes.json.gz');
select is(private.backup_missing('2999-01-01') - (select n from miss_base), -1,
  'A 有了当天的 _manifest 少算一个；C 停用本来不算；B 只有数据文件没有 _manifest 仍算没做完');
select is(tests.try_as('service_role', null, $$select private.backup_missing('2999-1-1')$$), '22023 backup_missing: bad date', '日期不是 YYYY-MM-DD 报错');
-- 真库 auth.users.created_at 没有默认值：没写建号时刻的账号也算该有备份（本机 lemo-e2e 实测漏算过）
insert into auth.users (id, email, created_at) values ('dddddddd-0000-4000-8000-000000000004', 'd@test.local', null);
insert into public.profiles (user_id) values ('dddddddd-0000-4000-8000-000000000004');
select is(private.backup_missing('2999-01-01') - (select n from miss_base), 0,
  '建号时刻为空的 D 也算一个没做完（和 A 少算的那个相抵）');

-- ④ 两个定时任务（架构第 10 节、第 6 节 backup-daily 行、0.38 第 46 条；TC-B7a-23；原 75_backup_daily_cron.test.sql 并进来）：
-- 照 50_anniv_roll_cron.test.sql 只看 cron.job 里登记的两条，加上 backup_dispatch 函数体里发请求的写法
-- （调哪个函数、带哪些请求头、值从哪里读、按 account_usable 挑人、不写死值）。真的调用要在本机 supabase start 后做（离线 PGlite 没有 pg_net）。
select is((select count(*)::int from cron.job where jobname = 'backup-daily'), 1, 'cron.job 里有且只有一条 backup-daily');
select is((select schedule from cron.job where jobname = 'backup-daily'), '30 15 * * *', '每天 15:30 UTC = 首尔 00:30');
select is((select count(*)::int from cron.job where jobname = 'backup-daily-retry'), 1, 'cron.job 里有且只有一条 backup-daily-retry');
select is((select schedule from cron.job where jobname = 'backup-daily-retry'), '30 17 * * *', '补跑每天 17:30 UTC = 首尔 02:30');
select is((select command from cron.job where jobname = 'backup-daily'), $$select private.backup_dispatch('start')$$, '00:30 那条调 backup_dispatch(''start'')');
select is((select command from cron.job where jobname = 'backup-daily-retry'), $$select private.backup_dispatch('retry')$$, '02:30 那条调 backup_dispatch(''retry'')（已做完的跳过）');
create temp table disp as select prosrc as src from pg_proc where oid = 'private.backup_dispatch(text)'::regprocedure;
select ok((select src like '%net.http_post(%' and src like '%|| ''/backup-daily''%' from disp), '经 net.http_post 调 <functions_url>/backup-daily');
select ok((select src like '%''x-cron-secret'', (select decrypted_secret from vault.decrypted_secrets where name = ''cron_secret'')%'
            and src like '%(select decrypted_secret from vault.decrypted_secrets where name = ''functions_url'')%' from disp),
  'x-cron-secret 和函数地址运行时从 vault.decrypted_secrets 读');
select ok((select src like '%''x-region'', ''ap-northeast-2''%' from disp), '带 x-region: ap-northeast-2（14.2 第 5 点）');
select ok((select src like '%from public.profiles p where private.account_usable(p.user_id)%'
            and src like '%jsonb_build_object(''user_id'', u.user_id, ''mode'', p_mode)%' from disp),
  '一人一个请求，只发给 private.account_usable 为真的账号（0.29 续第 138 条④），请求体带 user_id 和 mode');
-- 离线 PGlite 的 pgTAP 没有 throws_ok，照 26、47 的写法用 tests.try_as 回 sqlstate（postgres 身份：只有它能调）
select is(tests.try_as('postgres', null, $$select private.backup_dispatch('bogus')$$), '22023 backup_dispatch: bad mode', 'mode 只收 start、retry、publish');
select ok(not exists (
    select 1 from (select command as t from cron.job where jobname in ('backup-daily', 'backup-daily-retry') union all select src from disp) s,
           regexp_matches(s.t, '[A-Za-z0-9+/=_-]{32,}', 'g') as m(t)
     where m.t[1] ~ '[0-9]' and m.t[1] ~ '[A-Za-z]'),
  '命令和函数体里没有写死的长串（迁移不写值）');

select * from finish();
rollback;
