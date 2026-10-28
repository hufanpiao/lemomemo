-- 离线检查用的 Supabase 桩：只造迁移和 RLS 测试用得到的那几样（角色、auth、storage、cron、publication、默认权限）
-- 只在 PGlite 里跑，不是 Supabase 的真实定义；真库以 supabase db reset 为准（见 docs/03-评审/B0/后端-B0实测清单.md）

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
create role supabase_admin nologin;
create role supabase_auth_admin nologin noinherit;
grant anon, authenticated, service_role to authenticator;

create schema auth;
create schema storage;
create schema extensions;
create schema cron;
grant usage on schema auth, storage, extensions to anon, authenticated, service_role;

create table auth.users (id uuid primary key, email text, created_at timestamptz default now());
create table auth.sessions (id uuid primary key, user_id uuid references auth.users on delete cascade, created_at timestamptz default now());

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;
grant execute on function auth.jwt(), auth.uid(), auth.role() to anon, authenticated, service_role;

create table storage.buckets (id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets,
  name text, owner uuid, created_at timestamptz default now(), unique (bucket_id, name));
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;
create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare p text[];
begin
  p := string_to_array(name, '/');
  return p[1:array_length(p, 1) - 1];
end $$;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;

create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create table cron.job_run_details (runid bigserial primary key, jobid bigint, status text, end_time timestamptz);
create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (p_name, p_schedule, p_command)
    on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;

create publication supabase_realtime;

-- Supabase 给 public 设的默认权限（按 schema 直接授给三个 API 角色，不经 PUBLIC）
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
