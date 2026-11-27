-- 建 file_slot_open()，它的 grant 却被挪进了 0001（错误报在 0001 那一行）
create function private.file_slot_open(p uuid) returns boolean language sql as $$ select true $$;
-- 对照：grant 紧跟建函数、在同一文件
create function private.ok() returns int language sql as $$ select 1 $$;
grant execute on function private.ok() to authenticated;
-- 违规 M2（TC-B0-73 ①“紧跟”）：同一文件、在建函数之后，但中间隔了别的语句
create function private.later() returns int language sql as $$ select 1 $$;
create table private.between_ (id int);
grant execute on function private.later() to authenticated;
