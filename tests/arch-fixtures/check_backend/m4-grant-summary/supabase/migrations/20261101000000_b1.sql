-- 对照：标 B1 新迁移的写进带时间戳的新迁移
create function private.report_tz_impl(a text, b uuid, c text) returns void language sql security definer set search_path = '' as $$ select $$;
grant execute on function private.report_tz_impl(text, uuid, text) to authenticated;
-- 违规 M4：3.3 C 标在 0001 的一句写进了新迁移
grant usage on schema private to authenticated;
