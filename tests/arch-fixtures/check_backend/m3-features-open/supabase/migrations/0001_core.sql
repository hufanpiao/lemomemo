alter default privileges for role postgres revoke execute on functions from public;
-- 违规 M3（TC-B0-68）：改建表文件的列默认值来打开 note
create table public.app_config (
  id int primary key,
  features jsonb not null default '{"event":{"on":true},"todo":{"on":true},"note":{"on":true},"anniv":{"on":false}}');
