-- B4 迁移 20261110121000_notes_ai_classify_pending.sql：ai-classify 按人取待分类的随手记（代码审查 11-10 必改 1“公平取数”）。
-- 函数一侧的对拍在 tests/edge/ai-classify.test.ts（内存替身照这里的 SQL 写）。
-- 用户：seed 的 A、B、C。created_at 用小数字：A 有 30 条（1～30），C 有 1 条（50），B 有 1 条（100）。
begin;
select plan(11);
\ir _helpers.psql
select tests.seed();

-- ① 执行权：只给 service_role；定义者、search_path 置空、lock_timeout 5s
select ok(tests.try_as('anon', null, $$select * from private.ai_classify_pending(20, 10)$$) like '42501%', 'anon 没有执行权');
select ok(tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$select * from private.ai_classify_pending(20, 10)$$, null,
  'aaaaaaaa-5555-4000-8000-000000000001') like '42501%', 'authenticated 没有执行权');
select ok(has_function_privilege('service_role', 'private.ai_classify_pending(int, int)', 'EXECUTE'), 'service_role 能执行');
select ok(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
   where p.oid = 'private.ai_classify_pending(int, int)'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'), 'PUBLIC 没有执行权');
select is((select p.prosecdef and p.proconfig @> array['search_path=""', 'lock_timeout=5s'] and cardinality(p.proconfig) = 2
   from pg_proc p where p.oid = 'private.ai_classify_pending(int, int)'::regprocedure), true, 'security definer、search_path 置空、lock_timeout=5s');

-- 造数据
insert into public.notes (id, user_id, title, created_at, updated_at)
  select ('a3000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'aaaaaaaa-0000-4000-8000-000000000001', 'a' || i, i, i
    from generate_series(1, 30) i;
insert into public.notes (id, user_id, title, created_at, updated_at) values
  ('c3000000-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003', 'c', 50, 50),
  ('b3000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', 'b', 100, 100);
-- 不该出的：B 已分好的、B 删掉的、B 的隐私记（都比 B 那条早）
insert into public.notes (id, user_id, title, created_at, updated_at, ai_status) values
  ('b3000000-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002', 'done', 0, 0, 'done');
insert into public.notes (id, user_id, title, created_at, updated_at, deleted_at) values
  ('b3000000-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000002', 'del', 0, 0, 1);
insert into public.notes (id, user_id, title, body, body_enc, created_at, updated_at, is_private) values
  ('b3000000-0000-4000-8000-000000000004', 'bbbbbbbb-0000-4000-8000-000000000002', null, null, '\x00'::bytea, 0, 0, true);

-- ② 公平：A 堆了 30 条也只占一个位置，每人最多 20 条；人按最早一条排（A 1、C 50、B 100）
select is((select count(*)::int from private.ai_classify_pending(20, 10) where user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 20, 'A 最多 20 条');
select is((select array_agg(distinct user_id::text order by user_id::text) from private.ai_classify_pending(20, 10)),
  array['aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000003'], 'A 再多，B、C 照样取到');
select is((select array_agg(title) from (select title from private.ai_classify_pending(2, 10)) t),
  array['a1', 'a2', 'c', 'b'], '同一个人的挨在一起，人按最早一条先后，每人按 created_at 先后');
select is((select array_agg(distinct user_id::text order by user_id::text) from private.ai_classify_pending(20, 2)),
  array['aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003'], '最多 p_users 个人（按最早一条先后）');

-- ③ 不出：已分好的、删掉的、隐私记；入参截断、负数当 0
select is((select count(*)::int from private.ai_classify_pending(50, 100) where user_id = 'bbbbbbbb-0000-4000-8000-000000000002'), 1, 'B 只出没删、没分、不是隐私记的那 1 条');
select is((select count(*)::int from private.ai_classify_pending(-1, 10)) + (select count(*)::int from private.ai_classify_pending(20, -1))
  + (select count(*)::int from private.ai_classify_pending(null, null)), 0, '负数、null 当 0，什么都不出');

select * from finish();
rollback;
