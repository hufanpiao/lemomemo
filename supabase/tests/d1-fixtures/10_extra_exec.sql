-- expect: 不在白名单里
-- TC-B0-81 / 3.3 C：名单外的 private 函数授给 authenticated
create function private.qa_probe() returns int language sql as $$ select 1 $$;
grant execute on function private.qa_probe() to authenticated;
