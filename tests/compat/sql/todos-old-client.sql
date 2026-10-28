-- 契约用例 todos.old-client-write（SQL 型，登记在 tests/compat/subset.json）：
-- 4.0.0 客户端的写法：A 以 authenticated 身份按 4.0.0 的可写列建、改、删一条待办
-- 跑法：tests/compat/sql-case.ts 的 runSqlCase —— 事务里先建 supabase/tests/rls/_helpers.psql 的辅助、tests.seed()，
--       （验证机制时再叠一个 supabase/tests/compat/sample_*.sql），再跑本文件，最后回滚
-- 约定：只返回一行一列 result，'ok' 或 '<sqlstate> <错误信息>'
-- 原 supabase/tests/compat/_old_client.sql（后端），B0 集成时挪到这里，和前端的契约用例同一份子集名单
select tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.todos (id, title, due, important, created_at, updated_at) values ('70000000-0000-4000-8000-0000000000cc', '旧版写的', '2026-11-01', true, 1, 1);
  update public.todos set title = '旧版改的', important = false, updated_at = 2 where id = '70000000-0000-4000-8000-0000000000cc';
  update public.todos set deleted_at = 3 where id = '70000000-0000-4000-8000-0000000000cc';
$$) as result;
