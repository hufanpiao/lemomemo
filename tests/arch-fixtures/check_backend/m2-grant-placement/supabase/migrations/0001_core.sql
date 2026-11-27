-- 违规 M2（TC-B0-73 ②）：0001 的第一句不是全局默认权限
create schema if not exists private;
alter default privileges for role postgres revoke execute on functions from public;
-- 违规 M2（TC-B0-73 ①）：0004 里建的 file_slot_open() 的 grant 挪进了 0001
grant execute on function private.file_slot_open(uuid) to authenticated;
