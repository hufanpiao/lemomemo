alter default privileges for role postgres revoke execute on functions from public;   -- 0001
create table private.table_meta (tbl text primary key, system_cols text[], no_conflict text[]);
-- 违规 M5（TC-B0-73 ③）：profiles 建在 touch() 之前
create table public.profiles (user_id uuid primary key);
-- 违规 M5：touch() 写在 table_meta_of() 前面
create function private.touch() returns trigger language plpgsql as $$ begin return new; end $$;
create function private.table_meta_of(p text) returns text language sql as $$ select p $$;
-- 违规 M5：settings 建表后下一句不是它的 table_meta 行（中间隔了索引）
create table public.settings (id uuid primary key, user_id uuid, synced_at timestamptz);
create index on public.settings (user_id, synced_at);
insert into private.table_meta (tbl, system_cols, no_conflict) values ('settings', '{}', '{value}');
-- 对照：devices 建表后紧跟 table_meta 行，索引在同一个文件
create table public.devices (id uuid primary key, user_id uuid, synced_at timestamptz);
insert into private.table_meta (tbl, system_cols, no_conflict) values ('devices', '{}', '{}');
create index on public.devices (user_id, synced_at);
