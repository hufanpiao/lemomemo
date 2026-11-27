-- B1 迁移 20261029230000_ops_auth_mail_counts.sql：验证码发信量 private.auth_mail_counts()（架构 0.38 第 12 条、15.6 第 4d 条 ①、3.3 C；
-- B1 接手清单 OPS-mail-src；TC-B1-120 的数据库一半）。usage-report 那一半（index.ts 接 authMail、降级）在 tests/functions/usage-report.test.ts
begin;
select plan(10);
\ir _helpers.psql
select tests.seed();

-- ① 只给 service_role：anon、authenticated 调不了；PUBLIC 也没有执行权
select ok(tests.try_as('anon', null, $$select * from private.auth_mail_counts()$$) like '42501%',
  'auth_mail_counts：anon 没有执行权');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select * from private.auth_mail_counts()$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') like '42501%',
  'auth_mail_counts：authenticated 没有执行权');
select ok(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
   where p.oid = 'private.auth_mail_counts()'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'auth_mail_counts：PUBLIC 没有执行权（revoke from public）');

-- ② 定义者、search_path 为空、属主 postgres（service_role 对 auth.audit_log_entries 没有授权，靠定义者读）
select is((select p.prosecdef and p.proconfig = array['search_path=""'] and pg_get_userbyid(p.proowner) = 'postgres'
   from pg_proc p where p.oid = 'private.auth_mail_counts()'::regprocedure), true,
  'auth_mail_counts：security definer、set search_path = ''''、属主 postgres');
select ok(not has_table_privilege('service_role', 'auth.audit_log_entries', 'SELECT'),
  'service_role 本身读不了 auth.audit_log_entries（只能经这个函数拿计数）');

-- ③ 计数：只数 user_recovery_requested（本机实测验证码邮件记的 action），过去 1 小时 / 24 小时
-- 先清掉库里已有的审计行（测试事务结束时回滚），再按 GoTrue 写的形状插入
delete from auth.audit_log_entries;
insert into auth.audit_log_entries (instance_id, id, payload, created_at, ip_address)
select '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
       json_build_object('action', a, 'actor_id', 'aaaaaaaa-0000-4000-8000-000000000001', 'actor_username', 'a@test.local',
                         'actor_via_sso', false, 'log_type', 'user'),
       now() - t, ''
  from (values ('user_recovery_requested', interval '1 minute'),     -- 1 小时内
               ('user_recovery_requested', interval '59 minutes'),   -- 1 小时内
               ('user_recovery_requested', interval '1 hour'),       -- 正好 1 小时前：不算进 1 小时，算进 24 小时
               ('user_recovery_requested', interval '61 minutes'),   -- 只算进 24 小时
               ('user_recovery_requested', interval '23 hours'),     -- 只算进 24 小时
               ('user_recovery_requested', interval '25 hours'),     -- 都不算
               ('user_signedup', interval '1 minute'),               -- 别的 action 不算（admin 建用户，不发信）
               ('login', interval '1 minute'),
               ('token_refreshed', interval '1 minute')) v(a, t);
insert into auth.audit_log_entries (instance_id, id, payload, created_at, ip_address)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), null, now(), '');   -- payload 为空的行不算、不报错

select is(tests.rows_as('service_role', null, $$select * from private.auth_mail_counts()$$),
  '[{"auth_1h": 2, "auth_24h": 5}]'::jsonb,
  'service_role 能调；auth_1h = 1 小时内的 2 行，auth_24h = 24 小时内的 5 行；别的 action、25 小时前、payload 为空的都不算');
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(tests.rows_as('service_role', null, $$select * from private.auth_mail_counts()$$) -> 0) k),
  'auth_1h,auth_24h',
  '只回 auth_1h、auth_24h 两个数，不回邮箱、IP、user_id');

-- ④ 没有任何发信：两个数都是 0（不是空结果、不是 null）
delete from auth.audit_log_entries;
select is(tests.rows_as('service_role', null, $$select * from private.auth_mail_counts()$$),
  '[{"auth_1h": 0, "auth_24h": 0}]'::jsonb, '没有发信记录：回一行 0、0');

-- ⑤ 新插一行“刚刚”的验证码记录，两个数各加 1（读的是实时数据，不缓存）
insert into auth.audit_log_entries (instance_id, id, payload, created_at, ip_address)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
          '{"action":"user_recovery_requested","actor_username":"b@test.local","log_type":"user"}', now(), '');
select is(tests.rows_as('service_role', null, $$select * from private.auth_mail_counts()$$),
  '[{"auth_1h": 1, "auth_24h": 1}]'::jsonb, '刚发的一封立刻算进去');

-- ⑥ 函数签名：不带参数、返回 table(auth_1h int, auth_24h int)（usage-report index.ts 按这个读）
select is(pg_get_function_result('private.auth_mail_counts()'::regprocedure), 'TABLE(auth_1h integer, auth_24h integer)',
  '返回 table(auth_1h integer, auth_24h integer)');

select * from finish();
rollback;
