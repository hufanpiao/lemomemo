-- 4.0.0 客户端的契约子集：A 以 authenticated 身份按 4.0.0 的可写列建、改、删一条待办（兼容样例叠上去以后再跑这一段）
-- 返回 'ok' 或错误；run.mjs 和样例头上的 expect-old-client 比
select tests.try_as('authenticated', 'aaaaaaaa-0000-4000-8000-000000000001', $$
  insert into public.todos (id, title, due, important, created_at, updated_at) values ('70000000-0000-4000-8000-0000000000cc', '旧版写的', '2026-11-01', true, 1, 1);
  update public.todos set title = '旧版改的', important = false, updated_at = 2 where id = '70000000-0000-4000-8000-0000000000cc';
  update public.todos set deleted_at = 3 where id = '70000000-0000-4000-8000-0000000000cc';
$$) as old_client;
