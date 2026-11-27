-- 违规 M2（TC-B0-73 ①）：在 0001 以外整段 revoke
revoke execute on all functions in schema private from public;
-- 对照：新建一个函数不写 grant 不算错（0001 的全局默认权限让 PUBLIC 执行不了，TC-B0-73 ④ 由 D1 核对实际权限）
create function private.no_grant() returns int language sql as $$ select 1 $$;
