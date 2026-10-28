alter default privileges for role postgres revoke execute on functions from public;   -- 0001
revoke execute on all functions in schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
create function private.is_active() returns boolean language sql stable security definer set search_path = '' as $$ select true $$;
grant execute on function private.is_active() to authenticated;
-- 违规 M4：3.3 C 标的是 0004，实际写在 0001
grant select on private.admins to service_role;
-- 违规 M4：3.3 C 里没有这一句（多给了 authenticated 一张 private 表）
grant select on private.counters to authenticated;
-- 对照：给 fn_vault、fn_ai 的、对具体 private 表的 revoke 不归 3.3 C 的汇总管
grant usage on schema public, private to fn_vault, fn_ai;
grant select on private.counters to fn_ai;
revoke all on private.counters from public, anon, authenticated;
