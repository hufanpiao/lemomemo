-- B1 迁移 20261031160000_ops_orphan_auth_users.sql：没有 profile 的 auth 用户数 private.orphan_auth_users()（接手清单 ORPHAN-alert；
-- 架构 0.38 第 29 条、3.3 C）。usage-report 那一半（index.ts 接 orphanUsers、降级）在 tests/functions/usage-report-orphan.test.ts，
-- lemo-ops 那一半在 tests/functions/lemo-ops-orphan.test.ts。
-- 真库上可能已有别的用户：计数一律和开头的基数比差值；最近时刻只验“不早于这次插的最新孤儿”（库里可能有更新的真孤儿）。
begin;
select plan(12);
\ir _helpers.psql
select tests.seed();

-- ① 只给 service_role：anon、authenticated 调不了；PUBLIC 也没有执行权（0001 的默认权限收回，迁移里只 grant service_role）
select ok(tests.try_as('anon', null, $$select * from private.orphan_auth_users()$$) like '42501%',
  'orphan_auth_users：anon 没有执行权');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001',
  $$select * from private.orphan_auth_users()$$, null, 'aaaaaaaa-5555-4000-8000-000000000001') like '42501%',
  'orphan_auth_users：authenticated 没有执行权');
select ok(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
   where p.oid = 'private.orphan_auth_users()'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'orphan_auth_users：PUBLIC 没有执行权');

-- ② 定义者、search_path 为空、lock_timeout 5s、属主 postgres、stable
select is((select p.prosecdef and p.provolatile = 's' and pg_get_userbyid(p.proowner) = 'postgres'
          and p.proconfig @> array['search_path=""', 'lock_timeout=5s'] and cardinality(p.proconfig) = 2
   from pg_proc p where p.oid = 'private.orphan_auth_users()'::regprocedure), true,
  'orphan_auth_users：security definer、stable、search_path 置空、lock_timeout=5s、属主 postgres');

-- ③ 函数签名：不带参数、返回 table(orphans int, latest_at timestamptz)（usage-report index.ts 按这个读）
select is(pg_get_function_result('private.orphan_auth_users()'::regprocedure), 'TABLE(orphans integer, latest_at timestamp with time zone)',
  '返回 table(orphans integer, latest_at timestamp with time zone)');

-- 基数：库里原有的孤儿数（seed 的三个用户刚建、都有 profile，不算）
create temp table base as select orphans from private.orphan_auth_users();
create function pg_temp.delta() returns int language sql as $$
  select (select orphans from private.orphan_auth_users()) - (select orphans from base)
$$;

-- ④ 口径：建号超过 10 分钟、没有 profile 才算
insert into auth.users (id, email, created_at) values
  ('dddddddd-0000-4000-8000-000000000001', 'o1@test.local', now() - interval '10 minutes 1 second'),   -- 算：超过 10 分钟、没有 profile
  ('dddddddd-0000-4000-8000-000000000002', 'o2@test.local', now() - interval '11 minutes'),            -- 不算：有 profile
  ('dddddddd-0000-4000-8000-000000000003', 'o3@test.local', now() - interval '5 minutes'),             -- 不算：刚建（可能正在注册）
  ('dddddddd-0000-4000-8000-000000000004', 'o4@test.local', now() - interval '10 minutes');            -- 不算：正好 10 分钟
insert into public.profiles (user_id) values ('dddddddd-0000-4000-8000-000000000002');
select is(pg_temp.delta(), 1, '只有建号超过 10 分钟且没有 profile 的那一个算进去（有 profile、10 分钟内、正好 10 分钟的不算）');
select ok((select latest_at from private.orphan_auth_users()) >= now() - interval '10 minutes 1 second',
  'latest_at 不早于这次插的最新孤儿的建号时刻（是最近一个孤儿的时刻）');

-- ⑤ 经 service_role 调：只回 orphans、latest_at 两个键，不回 id、邮箱
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(tests.rows_as('service_role', null, $$select * from private.orphan_auth_users()$$) -> 0) k),
  'latest_at,orphans',
  'service_role 能调；只回 orphans、latest_at，不回 id、邮箱');

-- ⑥ 再来一个更早的孤儿：个数 +1，最近时刻不变
insert into auth.users (id, email, created_at) values ('dddddddd-0000-4000-8000-000000000005', 'o5@test.local', now() - interval '2 hours');
select is(pg_temp.delta(), 2, '更早的孤儿也算：个数 2');

-- ⑦ 负责人补上 profile（或删掉用户）以后不再算
insert into public.profiles (user_id) values ('dddddddd-0000-4000-8000-000000000001');
delete from auth.users where id = 'dddddddd-0000-4000-8000-000000000005';
select is(pg_temp.delta(), 0, '补上 profile、删掉用户以后不再算');

-- ⑧ 注销删除：deleteUser 级联删 profiles，auth 用户和 profile 一起没，不会留下孤儿
delete from auth.users where id = 'dddddddd-0000-4000-8000-000000000002';
select is(pg_temp.delta(), 0, '删 auth 用户连带删 profile：不算孤儿');

-- ⑨ 没有任何孤儿时回一行（个数 0），不是空结果
select is((select count(*)::int from private.orphan_auth_users() where orphans is not null), 1, '总是回一行，个数不是 null');

select * from finish();
rollback;
