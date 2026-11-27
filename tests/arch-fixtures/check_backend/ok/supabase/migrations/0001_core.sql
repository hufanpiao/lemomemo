-- 对照组：全部写法都合规
alter default privileges for role postgres revoke execute on functions from public;   -- 0001
create table public.app_config (
  id int primary key,
  features jsonb not null default '{"event":{"on":true},"todo":{"on":true},"note":{"on":false},"anniv":{"on":false}}');
create function private.f() returns int language sql stable security definer set search_path = '' as $$ select 1 $$;
grant execute on function private.f() to service_role;
