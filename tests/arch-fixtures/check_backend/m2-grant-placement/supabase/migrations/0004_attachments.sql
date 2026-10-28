-- 建 file_slot_open()，它的 grant 却被挪进了 0001（错误报在 0001 那一行）
create function private.file_slot_open(p uuid) returns boolean language sql as $$ select true $$;
-- 对照：grant 紧跟建函数、在同一文件
create function private.ok() returns int language sql as $$ select 1 $$;
grant execute on function private.ok() to authenticated;
