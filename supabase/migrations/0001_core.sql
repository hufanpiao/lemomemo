-- 0001_core.sql：公共函数和触发器、profiles、settings、devices、tombstones、api_tokens、applied_ops、logs、app_config、
--   private 的基础表、fn_vault / fn_ai 两个角色、backups 桶（架构 3.5 第 3 点、附录 A；数据字典 2.1）
-- 先后（0.29 续第 39 条）：全局默认权限 → table_meta、table_meta_of()、touch() → 各表；每张表的 table_meta 行紧跟建表语句
-- 授权（0.29 续第 32 条）：每个函数的 grant 紧跟建它的语句；行尾标文件的汇总见架构 3.3 C

-- ===== 1. 全局默认权限：收回 PUBLIC 对 postgres 以后新建函数的执行权（必须是第一句，不带 in schema） =====
alter default privileges for role postgres revoke execute on functions from public;   -- 0001
-- public 的表：以后新建的表不自动给客户端写权限（复审 L-b）；delete、truncate 一并收回（见回报“偏离”）
alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;

create schema if not exists private;
-- pg_cron、pg_net（不再需要 pg_trgm）；pg_net B0 不用，先启用给 storage-sweep 等后面的批次
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- 函数：0001 先全部收回一次，再逐个放行；之后的文件只 grant 自己建的函数，不再整段 revoke
revoke execute on all functions in schema private from public, anon, authenticated;   -- 0001
-- schema：只给 usage，否则 RLS 里调 private.is_active() 会报 permission denied
grant usage on schema private to authenticated;                                       -- 0001
grant usage on schema private to service_role;                                        -- 0001

-- ===== 2. 服务器函数的两个低权限角色（6.2，P-14；0.29 续第 37 条：不存在才建，已存在时不动 login 和密码） =====
-- 附录 A 写在 0001 末尾；这里提前到建函数之前，因为 purge_vault_impl 的 grant 要用到 fn_vault（见回报“偏离”）
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'fn_vault') then
    create role fn_vault nologin noinherit;   -- 密码不进迁移：负责人本人 alter role … login password …（6.2、8.4）
  end if;
  if not exists (select 1 from pg_roles where rolname = 'fn_ai') then
    create role fn_ai nologin noinherit;
  end if;
end $$;
grant usage on schema public, private to fn_vault, fn_ai;
grant usage on schema extensions to fn_ai;   -- halfvec 类型

-- ===== 3. table_meta、table_meta_of()、touch()（0.27 第 2 点；先于任何挂 touch() 的表） =====
create table private.table_meta (   -- 每张表的系统列和不报冲突的列；迁移手写 insert，D1 和清单比对；不授给任何客户端角色
  tbl text primary key, system_cols text[] not null, no_conflict text[] not null);

create function private.table_meta_of(p_tbl text) returns table (system_cols text[], no_conflict text[])
  language plpgsql stable security definer set search_path = '' as $$
begin
  return query select m.system_cols, m.no_conflict from private.table_meta m where m.tbl = p_tbl;
  if not found then raise exception 'table_meta_missing: %', p_tbl; end if;   -- 漏登记就报错，不悄悄多加 rev
end $$;
grant execute on function private.table_meta_of(text) to authenticated;        -- 0001  apply_patch 读；security definer，只读

-- 0.29 续第 31 条：security definer（service_role、fn_vault、fn_ai 写表时也要能读 table_meta）；只用 NEW、OLD、tg_table_name
create function private.touch() returns trigger language plpgsql security definer set search_path = '' as $$
declare k text; sys text[] := array['rev','fv','synced_at','updated_at']
    || (select m.system_cols from private.table_meta_of(tg_table_name) m);
  o jsonb; n jsonb; bump boolean := false;
begin
  if tg_op = 'INSERT' then new.rev := 1; new.fv := '{}'; new.synced_at := now(); return new; end if;
  new.id := old.id; new.user_id := old.user_id; new.rev := old.rev; new.fv := old.fv;
  if tg_table_name = 'todos' and to_jsonb(new)->>'due' is null then   -- 0.29 续第 136 条：截止日期清空时连带清截止时刻
    new := jsonb_populate_record(new, jsonb_build_object('due_time', null, 'remind_before_min', null));
  end if;
  o := to_jsonb(old); n := to_jsonb(new);
  for k in select jsonb_object_keys(n) loop
    if k = any(sys) then continue; end if;
    if n->k is distinct from o->k then
      bump := true; new.fv := jsonb_set(new.fv, array[k], to_jsonb(old.rev + 1));
    end if;
  end loop;
  if bump then new.rev := old.rev + 1; end if;
  -- 提醒相关字段（snooze_at、notified_for 以外）变了：清空推迟和推送去重（复审 L-c、安全审查低 8；0.29 补六列）
  if tg_table_name in ('events','todos','anniversaries')
     and exists (select 1 from jsonb_each(n) e where e.key in ('date','time','tz','due','due_time','remind_before_min',
                        'remind_min','remind_days','remind_time','remind_offsets','month','day',
                        'calendar','lunar_variant','is_leap','year','after_due','kind','done','deleted_at')
                 and e.value is distinct from o->e.key) then
    new := jsonb_populate_record(new, jsonb_build_object('defer_until', null, 'pushed_for', null));
  end if;
  new.synced_at := now(); return new;
end $$;
grant execute on function private.touch() to authenticated;                    -- 0001  触发器函数：security definer（0.29 续第 31 条）

-- ===== 4. profiles 和“账号能不能用” =====
create table public.profiles (
  user_id uuid primary key references auth.users on delete cascade,
  display_name text check (char_length(display_name) <= 40),
  ui_locale text not null default 'zh-CN' check (ui_locale in ('zh-CN','ko-KR')),
  tz_mode text not null default 'device' check (tz_mode in ('device','fixed')),
  current_tz text not null default 'Asia/Seoul',
  current_tz_device uuid, current_tz_at timestamptz,
  disabled_at timestamptz,
  disabled_reason text check (disabled_reason in ('admin','deletion')),   -- 0.29 续第 134 条：restore 只清 deletion
  check ((disabled_at is null) = (disabled_reason is null)),
  created_at timestamptz not null default now(),
  consent_ai_at timestamptz, consent_policy_ver text,   -- 同意记录（15.5）
  beta_features text[] not null default '{}');          -- 0.27：先给这几个人打开的功能；客户端只能读

-- 0.29 续第 142 条：客户端不能改停用两列（列级授权之外的第二道）；security invoker，看请求角色
create function private.guard_profile_disabled() returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('role', true), '') not in ('authenticated', 'anon') then return new; end if;   -- service_role、SQL 编辑器的 postgres 放行
  if tg_op = 'INSERT' and (new.disabled_at is not null or new.disabled_reason is not null) then raise exception 'disabled_readonly'; end if;
  if tg_op = 'UPDATE' and (new.disabled_at is distinct from old.disabled_at or new.disabled_reason is distinct from old.disabled_reason) then
    raise exception 'disabled_readonly'; end if;
  return new;
end $$;
revoke execute on function private.guard_profile_disabled() from public; -- 0001  触发器函数，仅触发器调用
create trigger profiles_guard_disabled before insert or update on public.profiles
  for each row execute function private.guard_profile_disabled();

-- 0.29 续第 138 条：唯一的判断（profile 存在且未停用）
create function private.account_usable(p_user uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.user_id = p_user and p.disabled_at is null)
$$;
grant execute on function private.account_usable(uuid) to service_role;  -- 0001  服务器函数和 cron 都用它

create function private.is_active() returns boolean language sql stable security definer set search_path = '' as $$
  select private.account_usable((select auth.uid()))
$$;
grant execute on function private.is_active() to authenticated;                 -- 0001  RLS 用

-- 0.29 续第 134 条：管理员停用、解除（只在 SQL 编辑器以 postgres 调，不授执行权）
create function private.admin_set_disabled(p_user uuid, p_on boolean) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if p_on then
    update public.profiles set disabled_at = coalesce(disabled_at, now()), disabled_reason = 'admin' where user_id = p_user;
  elsif exists (select 1 from private.pending_deletions d where d.user_id = p_user) then
    update public.profiles set disabled_reason = 'deletion' where user_id = p_user;   -- 仍在注销冷静期
  else
    update public.profiles set disabled_at = null, disabled_reason = null where user_id = p_user;
  end if;
end $$;
revoke execute on function private.admin_set_disabled(uuid, boolean) from public;   -- 0001

alter table public.profiles enable row level security;
create policy prof_sel on public.profiles for select to authenticated using (user_id = (select auth.uid()));
create policy prof_upd on public.profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- 没有 insert、delete 策略：profiles 由 invite-signup 用 service role 建，注销时随 auth.users 级联删除
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, ui_locale, tz_mode) on public.profiles to authenticated;   -- beta_features、disabled_* 不给

-- ===== 5. private 的基础表（core 清单） =====
create table private.admins (user_id uuid primary key references auth.users on delete cascade);   -- 0.29（P-17）
create table private.invites (
  code_hash text primary key, created_by uuid references auth.users on delete set null,   -- 0.29（P-17）
  max_uses int default 1, used_count int default 0,
  expires_at timestamptz,
  note text check (note is null or char_length(note) <= 40));   -- 只写编号或日期，不准写名字
create table private.pending_signups (email_hash text primary key, otp_hash text not null,
  tries int not null default 0, expires_at timestamptz not null);
create table private.webauthn_challenges (challenge text primary key,
  user_id uuid not null references auth.users on delete cascade,
  expires_at timestamptz not null);
create table private.deleted_accounts (user_id uuid primary key, deleted_at timestamptz default now());
create table private.pending_deletions (user_id uuid primary key references auth.users on delete cascade,   -- 0.29 续第 131 条（R-192）
  requested_at timestamptz not null default now(), purge_after timestamptz not null,
  notice_sent boolean not null default false,   -- 0.29 续第 137 条
  purge_started_at timestamptz);                -- 0.29 续第 138 条
create table private.revoked_sessions (   -- 0.29 续第 101 条（数据字典 5.1）：远程移除设备时吊销的会话
  session_id uuid primary key, user_id uuid not null references auth.users on delete cascade,
  revoked_at timestamptz not null default now());
create table private.counters (key text, window_start timestamptz, count int, primary key (key, window_start),
  -- 0.29 续第 34 条：键一律三段 <用途>:<user_id | global | ip | mail>:<窗口或哈希>；第三段不准有冒号
  check (key ~ '^[a-z][a-z0-9_-]*:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|global|ip|mail):[^:]+$'));
create table private.ai_state (provider text primary key, exhausted_until timestamptz);
create table private.remind_queue (table_name text, id uuid, primary key (table_name, id));
create table private.heartbeat (name text primary key, at timestamptz not null, detail jsonb);
create table private.user_limits (   -- R-114 D-2、D-9：null = 不设上限（P-30：归 core，放 0001）
  user_id uuid primary key references auth.users on delete cascade,
  media_mb int, media_daily int, search_daily int);

-- ===== 6. 公共触发器函数 =====
-- 0.29 续第 121 条：硬删同步表的行时留墓碑（只放 id）；账号已停用或 profile 不在时不写
create function private.write_tombstone() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not private.account_usable(old.user_id) then return null; end if;
  -- auth.users 删行级联下来时（profile 可能还没删），用户已不在，写了会撞外键
  if not exists (select 1 from auth.users u where u.id = old.user_id) then return null; end if;
  insert into public.tombstones (tbl, id, user_id) values (tg_table_name, old.id, old.user_id)
    on conflict (tbl, id) do update set user_id = excluded.user_id, deleted_at = now();
  return null;
end $$;
revoke execute on function private.write_tombstone() from public;        -- 0001  触发器函数，仅触发器调用（0.29 续第 138 条）

-- 行数上限（安全审查中 4；0.29 P-42、续第 38 条）
create function private.row_quota() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare n bigint; d date := (now() at time zone 'UTC')::date;
begin
  -- 迁移、SQL 编辑器（postgres / supabase_admin，role 为空或 none）豁免；B0 实测四种连接下的取值，取不准就整条去掉
  if session_user in ('postgres', 'supabase_admin') and coalesce(nullif(current_setting('role', true), ''), 'none') = 'none' then return new; end if;
  if tg_table_name = 'logs' then
    if current_setting('role', true) = 'service_role' then return new; end if;
    insert into private.counters as c (key, window_start, count)
      values ('logs:' || new.user_id::text || ':' || d::text, d::timestamp at time zone 'UTC', 1)
      on conflict (key, window_start) do update set count = c.count + 1
      returning c.count into n;
    if n > 2000 then raise exception 'quota'; end if;   -- 抛错时计数一起回滚
    return new;
  end if;
  execute format('select count(*) from public.%I where user_id = $1', tg_table_name) into n using new.user_id;
  if n >= 20000 then raise exception 'quota'; end if;
  return new;
end $$;
grant execute on function private.row_quota() to authenticated;                -- 0001  触发器函数：security definer

create function private.enqueue_remind() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  insert into private.remind_queue(table_name, id) values (tg_table_name, new.id)
    on conflict do nothing;
  return new;
end $$;
grant execute on function private.enqueue_remind() to authenticated;           -- 0001  触发器函数：security definer，写 remind_queue

-- ===== 7. tombstones（0.29 续第 121 条，R-180）：只放 id，开 RLS，客户端只读 =====
create table public.tombstones (
  tbl text not null check (tbl in ('settings','devices','events','todos','categories','notes','note_images','note_files','anniversaries')),
  id uuid not null,
  user_id uuid not null references auth.users on delete cascade,
  deleted_at timestamptz not null default now(),
  primary key (tbl, id));
create index on public.tombstones (user_id, deleted_at);
alter table public.tombstones enable row level security;
create policy tomb_sel on public.tombstones for select to authenticated
  using (user_id = (select auth.uid()) and private.is_active());
revoke all on public.tombstones from anon, authenticated;
grant select on public.tombstones to authenticated;

-- ===== 8. settings =====
create table public.settings (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  rev int not null default 1, fv jsonb not null default '{}', deleted_at bigint,
  undone boolean not null default false, synced_at timestamptz not null default now(), legacy_id text,
  key text not null, value jsonb not null, unique (user_id, key),
  check (pg_column_size(value) <= 4096),                                     -- 安全审查中 4
  check (key <> 'ai.vault' or value in ('true'::jsonb, 'false'::jsonb)));   -- 0.29 续第 140 条：ai.vault 只能是布尔
insert into private.table_meta (tbl, system_cols, no_conflict) values ('settings', '{}', '{value}');
create index on public.settings (user_id, synced_at);
create trigger settings_touch before insert or update on public.settings for each row execute function private.touch();
create trigger settings_quota before insert on public.settings for each row execute function private.row_quota();
create trigger settings_tombstone after delete on public.settings for each row execute function private.write_tombstone();

-- 0.29 续第 138、140 条：ai.vault 只能经服务器打开；关掉不拦。security invoker，看请求角色（不看 current_user）
create function private.settings_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('role', true), '') not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'UPDATE' and new.key is distinct from old.key then raise exception 'settings_key_immutable'; end if;
  if new.key = 'ai.vault' and new.value is distinct from 'false'::jsonb
     and (tg_op = 'INSERT' or old.value is distinct from new.value) then
    raise exception 'vault_required';
  end if;
  return new;
end $$;
revoke execute on function private.settings_guard() from public;         -- 0001  触发器函数，仅触发器调用
create trigger settings_guard before insert or update on public.settings for each row execute function private.settings_guard();   -- 不限列

alter table public.settings enable row level security;
create policy sel on public.settings for select to authenticated using (user_id = (select auth.uid()) and private.is_active());
create policy ins on public.settings for insert to authenticated with check (user_id = (select auth.uid()) and private.is_active());
create policy upd on public.settings for update to authenticated
  using (user_id = (select auth.uid()) and private.is_active()) with check (user_id = (select auth.uid()));
revoke all on public.settings from anon, authenticated;
grant select on public.settings to authenticated;
grant insert (id, key, value) on public.settings to authenticated;
grant update (value, deleted_at, undone) on public.settings to authenticated;

-- ===== 9. devices（0.29 续第 98、99、104、109、112 条） =====
create table public.devices (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  rev int not null default 1, fv jsonb not null default '{}', deleted_at bigint,
  undone boolean not null default false, synced_at timestamptz not null default now(), legacy_id text,
  label text, platform text not null check (platform in ('ios','windows','web','tauri')),
  push_endpoint text unique, p256dh text, auth text, app_version text,
  last_seen_at timestamptz, last_push_ok_at timestamptz, push_fail_count int not null default 0,
  session_id uuid,      -- 触发器在这台设备自己写时填成 JWT 的 session_id；客户端传的不信
  install_id uuid);     -- 0.29 续第 109 条：这一份安装的随机 id，insert 时写、之后不改
insert into private.table_meta (tbl, system_cols, no_conflict) values ('devices', '{last_push_ok_at,push_fail_count}', '{last_seen_at,app_version}');
alter table public.devices add constraint devices_id_user_key unique (id, user_id);   -- 0.29 续第 81 条（P-06）
create index on public.devices (user_id, synced_at);

-- 0.29 续第 101 条：会话在 auth.sessions 里、且没被吊销
create function private.session_alive(p_session uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_session is not null
     and exists (select 1 from auth.sessions s where s.id = p_session)
     and not exists (select 1 from private.revoked_sessions r where r.session_id = p_session)
$$;
grant execute on function private.session_alive(uuid) to service_role;   -- 0001  requireActiveUser 查会话

-- 0.29 续第 99、104、112 条：客户端写时 session_id 一律取 JWT；update 时保持原值，
--   只有 rebind_device_impl 设了 lemo.rebind 且请求角色是 service_role 才能改；会话不在就报 session_revoked（出错不捕获）
create function private.devices_session_guard() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare r text := coalesce(current_setting('role', true), '');
begin
  if r in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.session_id := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
    else
      new.session_id := old.session_id;
      if tg_op = 'UPDATE' and new.install_id is distinct from old.install_id then raise exception 'install_id_immutable'; end if;
    end if;
    if not private.session_alive(new.session_id) then raise exception 'session_revoked'; end if;
  elsif tg_op = 'UPDATE' and new.session_id is distinct from old.session_id
        and not (current_setting('lemo.rebind', true) = old.id::text and r = 'service_role') then
    new.session_id := old.session_id;   -- service role 写其他列时不动这一列
  end if;
  return new;
end $$;
grant execute on function private.devices_session_guard() to authenticated;   -- 0001  触发器函数：security definer
create trigger devices_session_guard before insert or update on public.devices for each row execute function private.devices_session_guard();
create trigger devices_touch before insert or update on public.devices for each row execute function private.touch();
create trigger devices_quota before insert on public.devices for each row execute function private.row_quota();
create trigger devices_tombstone after delete on public.devices for each row execute function private.write_tombstone();

alter table public.devices enable row level security;
create policy sel on public.devices for select to authenticated using (user_id = (select auth.uid()) and private.is_active());
create policy ins on public.devices for insert to authenticated with check (user_id = (select auth.uid()) and private.is_active());
-- 0.29 续第 99 条：update、delete 只能动本机那一行（session_id 等于 JWT 的会话；为空的行也不能认领）
create policy upd on public.devices for update to authenticated
  using (user_id = (select auth.uid()) and private.is_active()
         and session_id = nullif((select auth.jwt()) ->> 'session_id', '')::uuid)
  with check (user_id = (select auth.uid()) and session_id = nullif((select auth.jwt()) ->> 'session_id', '')::uuid);
create policy del on public.devices for delete to authenticated
  using (user_id = (select auth.uid()) and private.is_active()
         and session_id = nullif((select auth.jwt()) ->> 'session_id', '')::uuid);
revoke all on public.devices from anon, authenticated;
grant select, delete on public.devices to authenticated;   -- delete 只有 devices 有（0.29 续第 121 条）
grant insert (id, label, platform, app_version, last_seen_at, install_id) on public.devices to authenticated;
grant update (label, app_version, last_seen_at, deleted_at, undone) on public.devices to authenticated;
--   push_endpoint、p256dh、auth 经 claim_endpoint 写；last_push_ok_at、push_fail_count 是系统列

-- ===== 10. api_tokens =====
create table public.api_tokens (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users on delete cascade,
  label text, token_hash text not null unique, scopes text[] not null default '{create}',
  created_at timestamptz not null default now(), last_used_at timestamptz, revoked_at timestamptz);
-- 第七轮：revoked_at 只能从空改成 now()
create function private.guard_token_revoke() returns trigger language plpgsql set search_path = '' as $$
begin
  if current_setting('role', true) = 'service_role' then return new; end if;   -- 0.29 续第 142 条：统一看请求角色
  if old.revoked_at is not null then raise exception 'token_already_revoked'; end if;
  if new.revoked_at is null then return new; end if;     -- 没改这一列
  new.revoked_at := now();                               -- 不信客户端传来的时间
  return new;
end $$;
grant execute on function private.guard_token_revoke() to authenticated;       -- 0001  触发器函数
create trigger api_tokens_guard before update on public.api_tokens for each row execute function private.guard_token_revoke();
alter table public.api_tokens enable row level security;
create policy tok_sel on public.api_tokens for select to authenticated
  using (user_id = (select auth.uid()) and private.is_active());
create policy tok_upd on public.api_tokens for update to authenticated
  using (user_id = (select auth.uid()) and private.is_active()) with check (user_id = (select auth.uid()));
-- 没有 insert、delete 策略：由 token-admin 用 service role 建
revoke all on public.api_tokens from anon, authenticated;
grant select on public.api_tokens to authenticated;
grant update (revoked_at) on public.api_tokens to authenticated;

-- ===== 11. applied_ops =====
create table public.applied_ops (
  op_id uuid not null, user_id uuid not null default auth.uid() references auth.users on delete cascade,   -- 0.29（P-17）
  at timestamptz not null default now(),
  result jsonb, primary key (user_id, op_id));   -- 防止用别人的 op_id 撞库（安全审查低 8）
alter table public.applied_ops enable row level security;
create policy sel on public.applied_ops for select to authenticated using (user_id = (select auth.uid()) and private.is_active());
create policy ins on public.applied_ops for insert to authenticated with check (user_id = (select auth.uid()) and private.is_active());
revoke all on public.applied_ops from anon, authenticated;
grant select on public.applied_ops to authenticated;
grant insert (op_id, result) on public.applied_ops to authenticated;   -- apply_patch 是 security invoker（复审 L-e）

-- ===== 12. logs =====
create table public.logs (
  id bigserial primary key, user_id uuid not null default auth.uid() references auth.users on delete cascade,
  t bigint not null, device text, kind text, act text, src text, coll text, item_id uuid,
  fields text[], code text,
  check (char_length(device) <= 64 and char_length(kind) <= 16 and char_length(act) <= 32
     and char_length(src) <= 16 and char_length(coll) <= 32 and char_length(code) <= 64
     and cardinality(fields) <= 20
     and char_length(array_to_string(fields, ',')) <= 640));
create trigger logs_quota before insert on public.logs for each row execute function private.row_quota();
alter table public.logs enable row level security;
create policy sel on public.logs for select to authenticated using (user_id = (select auth.uid()) and private.is_active());
create policy ins on public.logs for insert to authenticated with check (user_id = (select auth.uid()) and private.is_active());
revoke all on public.logs from anon, authenticated;
grant select on public.logs to authenticated;
grant insert (t, device, kind, act, src, coll, item_id, fields, code) on public.logs to authenticated;

-- ===== 13. app_config =====
create table public.app_config (
  id int primary key default 1 check (id = 1),
  min_client_version text check (min_client_version ~ '^\d+\.\d+\.\d+$'),   -- 0.27 第 1 点
  latest_version text,
  -- 0.27 第 4 点：以键为名，每项 {on, min_client?}；0.29（P-02）：默认值写全四个键
  -- P-05（B0 实测定）：每项必须是对象、有布尔 on；用 strict（lax 会把数组展开，数组值能混过去，离线实测见回报）
  features jsonb not null default '{"event":{"on":true},"todo":{"on":true},"note":{"on":false},"anniv":{"on":false}}'
    check (jsonb_typeof(features) = 'object'
       and not jsonb_path_exists(features, 'strict $.* ? (@.type() != "object" || !(exists(@.on)) || @.on.type() != "boolean")')),
  ai jsonb not null, notice jsonb,
  limits jsonb not null default '{"media_mb_default": 50, "file_mb_max": 10}');

-- 0.27：两个时间由触发器写；不授给客户端角色
create function private.stamp_embed_model() returns trigger
  language plpgsql set search_path = '' as $$
begin
  if new.ai->'embed_model_next' is distinct from old.ai->'embed_model_next' then
    new.ai := jsonb_set(new.ai, '{embed_model_next_set_at}', to_jsonb(now())); end if;
  if new.ai->'embed_model' is distinct from old.ai->'embed_model' then
    new.ai := jsonb_set(new.ai, '{embed_model_switched_at}', to_jsonb(now())); end if;
  return new;
end $$;
create trigger app_config_stamp before update on public.app_config
  for each row execute function private.stamp_embed_model();

alter table public.app_config enable row level security;
create policy cfg_sel on public.app_config for select to anon, authenticated using (true);
-- 没有任何写策略；表级也不授 insert、update。0.27：anon 只给四列
revoke all on public.app_config from anon, authenticated;
grant select on public.app_config to authenticated;
grant select (id, min_client_version, latest_version, notice) on public.app_config to anon;

-- 唯一一行（P-38 未定的数字留空，见回报）：features 用列默认值
insert into public.app_config (id, min_client_version, latest_version, ai, notice) values
  (1, '4.0.0', '4.0.0',
   '{"provider": null, "model": null, "per_user_daily": 50, "global_daily": null,
     "media_daily_default": 40, "search_daily_default": 200, "embed_daily_global": null,
     "embed_model": "gemini-embedding-2", "embed_model_next": null}', null)
on conflict (id) do nothing;

-- ===== 14. 同意记录（第二轮安全 N1）和永久删除（0.29 续第 121、138 条） =====
create function private.record_consent_impl(p_ver text, p_revoke boolean default false) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if p_ver is distinct from (select c.notice->>'policy_ver' from public.app_config c where c.id = 1) then
    raise exception 'policy_ver_mismatch'; end if;
  if p_revoke then   -- 0.27：和换模型补算互斥，同一把锁
    perform pg_advisory_xact_lock(hashtext('embed:' || (select auth.uid())::text)); end if;
  update public.profiles
     set consent_ai_at = case when p_revoke then null else now() end,
         consent_policy_ver = p_ver   -- 拒绝时也记版本
   where user_id = (select auth.uid()) and disabled_at is null;
  if p_revoke then
    insert into public.settings (id, user_id, key, value) values (gen_random_uuid(), (select auth.uid()), 'ai.enabled', 'false')
      on conflict (user_id, key) do update set value = 'false';
    -- 0.29（P-13）：删这个人全部的向量（所有模型）和队列；两张表在 0007，plpgsql 运行时才解析
    delete from private.note_vectors where user_id = (select auth.uid());
    delete from private.embed_queue  where user_id = (select auth.uid());
  end if;
  -- 同意分支的“恢复 skip 的图片和附件”（R-179，0.29 续第 120 条）属于 B4b-2，那时 create or replace
end $$;
grant execute on function private.record_consent_impl(text, boolean) to authenticated;   -- 0001

create function public.record_consent(policy_ver text, revoke boolean default false) returns void
  language sql security invoker set search_path = '' as $$ select private.record_consent_impl(policy_ver, revoke) $$;
revoke execute on function public.record_consent(text, boolean) from public, anon, service_role;
grant execute on function public.record_consent(text, boolean) to authenticated;

-- 只删本人已进“最近删除”的行；四张表各写固定 SQL、不拼表名；超过 500 项整批拒绝
create function private.purge_deleted_impl(p_items jsonb default null) returns int
  language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); n int := 0; k int;
  ev uuid[]; td uuid[]; an uuid[]; nt uuid[];
begin
  if uid is null or not private.account_usable(uid) then raise exception 'account_disabled'; end if;
  if p_items is null then   -- 全部清空（含撤销留下的 undone 行；不含隐私记）
    delete from public.events        where user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
    delete from public.todos         where user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
    delete from public.anniversaries where user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
    delete from public.notes         where user_id = uid and deleted_at is not null and not is_private; get diagnostics k = row_count; n := n + k;
    return n;
  end if;
  if jsonb_typeof(p_items) <> 'array' then raise exception 'bad_items'; end if;
  if jsonb_array_length(p_items) > 500 then raise exception 'too_many_items'; end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
              where coalesce(e->>'tbl', '') not in ('events','todos','anniversaries','notes')) then
    raise exception 'bad_table'; end if;
  select array_agg((e->>'id')::uuid) filter (where e->>'tbl' = 'events'),
         array_agg((e->>'id')::uuid) filter (where e->>'tbl' = 'todos'),
         array_agg((e->>'id')::uuid) filter (where e->>'tbl' = 'anniversaries'),
         array_agg((e->>'id')::uuid) filter (where e->>'tbl' = 'notes')
    into ev, td, an, nt from jsonb_array_elements(p_items) e;
  delete from public.events        where id = any(ev) and user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
  delete from public.todos         where id = any(td) and user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
  delete from public.anniversaries where id = any(an) and user_id = uid and deleted_at is not null; get diagnostics k = row_count; n := n + k;
  delete from public.notes         where id = any(nt) and user_id = uid and deleted_at is not null and not is_private; get diagnostics k = row_count; n := n + k;
  return n;
end $$;
grant execute on function private.purge_deleted_impl(jsonb) to authenticated;   -- 0001

create function public.purge_deleted(p_items jsonb default null) returns int
  language sql security invoker set search_path = '' as $$ select private.purge_deleted_impl(p_items) $$;
revoke execute on function public.purge_deleted(jsonb) from public, anon, service_role;
grant execute on function public.purge_deleted(jsonb) to authenticated;

-- 隐私记的永久删除：vault 函数验过 vault_token 后经 fn_vault 调；p_user 必须等于本事务的 app.uid（第二道）
create function private.purge_vault_impl(p_user uuid, p_items jsonb default null) returns int
  language plpgsql security definer set search_path = '' as $$
declare n int; ids uuid[];
begin
  if p_user is null or p_user is distinct from nullif(current_setting('app.uid', true), '')::uuid then
    raise exception 'uid_mismatch'; end if;
  if p_items is null then
    delete from public.notes where user_id = p_user and is_private and deleted_at is not null;
    get diagnostics n = row_count; return n;
  end if;
  if jsonb_typeof(p_items) <> 'array' then raise exception 'bad_items'; end if;
  if jsonb_array_length(p_items) > 500 then raise exception 'too_many_items'; end if;
  select array_agg((e->>'id')::uuid) into ids from jsonb_array_elements(p_items) e;
  delete from public.notes where id = any(ids) and user_id = p_user and is_private and deleted_at is not null;
  get diagnostics n = row_count; return n;
end $$;
grant execute on function private.purge_vault_impl(uuid, jsonb) to fn_vault;   -- 0001  隐私记的永久删除（0.29 续第 121 条）

-- ===== 15. 超时和长事务（0.29 续第 141、146 条） =====
alter role service_role set statement_timeout = '4min';   -- PostgREST 切角色时套用
create function private.long_transactions() returns table (pid int, role name, xact_start timestamptz, app text)
  language sql stable security definer set search_path = '' as $$
  select a.pid, a.usename, a.xact_start, a.application_name from pg_catalog.pg_stat_activity a
   where a.state <> 'idle' and a.xact_start < now() - interval '4 minutes'   -- 不回 SQL 原文
$$;
grant execute on function private.long_transactions() to service_role;   -- 0001  usage-report 查超过 4 分钟的事务

-- ===== 16. 每日清理（3.4；0.29 续第 135、141 条：每次只做一批 ≤ 1000 行、一个事务，命令带超时） =====
-- 以 postgres 执行（pg_cron），不授给任何角色；故意不用 account_usable（冷静期里照常清理）
-- 删桶里的对象归 storage-sweep（02:30，B4 起）；B1 以后的项（devices 会话、换模型收尾、孤儿向量）随批次加
create function private.cleanup_batch(p_limit int default 1000) returns int language plpgsql set search_path = '' as $$
declare left_ int := p_limit; k int; t0 timestamptz := clock_timestamp();
  cut30 bigint := ((extract(epoch from now()) - 30 * 86400) * 1000)::bigint;
  cut90 bigint := ((extract(epoch from now()) - 90 * 86400) * 1000)::bigint;
begin
  -- 30 天前软删除的行（向量、vault_ai 靠外键级联；墓碑由触发器写）
  delete from public.events        where ctid in (select ctid from public.events        where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.todos         where ctid in (select ctid from public.todos         where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.anniversaries where ctid in (select ctid from public.anniversaries where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.note_images   where ctid in (select ctid from public.note_images   where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.note_files    where ctid in (select ctid from public.note_files    where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.notes         where ctid in (select ctid from public.notes         where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.categories    where ctid in (select ctid from public.categories    where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.settings      where ctid in (select ctid from public.settings      where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  -- 不同步的表
  delete from public.logs          where ctid in (select ctid from public.logs where t < cut90 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.applied_ops   where ctid in (select ctid from public.applied_ops where at < now() - interval '7 days' limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.tombstones    where ctid in (select ctid from public.tombstones where deleted_at < now() - interval '30 days' limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from private.pending_signups     where ctid in (select ctid from private.pending_signups where expires_at < now() limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from private.webauthn_challenges where ctid in (select ctid from private.webauthn_challenges where expires_at < now() limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from private.counters            where ctid in (select ctid from private.counters where window_start < now() - interval '30 days' limit left_); get diagnostics k = row_count; left_ := left_ - k;
  insert into private.heartbeat (name, at, detail)
    values ('cleanup', now(), jsonb_build_object('rows', p_limit - left_, 'ms', (extract(epoch from clock_timestamp() - t0) * 1000)::int))
    on conflict (name) do update set at = excluded.at, detail = excluded.detail;
  return p_limit - left_;
end $$;
-- 03:00～03:59（首尔）= UTC 18 点，每分钟一批；超时回滚、下一分钟重试
select cron.schedule('cleanup-batch', '* 18 * * *', $$set statement_timeout = '4min'; select private.cleanup_batch();$$);
-- 第七轮：pg_cron 的运行记录每天清 7 天前的（3.4）
select cron.schedule('purge-cron-history', '15 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);

-- ===== 17. backups 桶（0.29 续第 33 条：insert … on conflict，写在建这个桶的功能文件里） =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('backups', 'backups', false, 52428800, array['application/gzip'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
-- backups 桶不建任何策略，只能经服务器函数访问（3.3 G）

-- ===== 18. service_role 对 private 的逐表最小授权（0.29 续第 52 条，做法 A；3.3 C） =====
grant select on private.admins to service_role;                                       -- 0001  account 拒绝注销管理员、token-admin
grant select, insert, update on private.invites to service_role;                      -- 0001  invite-signup
grant select, insert, update, delete on private.pending_signups to service_role;      -- 0001  invite-signup（注册成功即删）、account
grant select, insert on private.deleted_accounts to service_role;                    -- 0001  account
grant select, insert, update, delete on private.pending_deletions to service_role;  -- 0001  account、account-purge
grant select, insert, update, delete on private.counters to service_role;             -- 0001  限流、AI 记账、注销删本人的键
grant select, insert, update on private.ai_state to service_role;                     -- 0001  ai-parse、ai-voice、ai-classify、claude-intake
grant select, insert, update on private.heartbeat to service_role;                    -- 0001  各 cron 函数
grant select, insert, delete on private.remind_queue to service_role;                 -- 0001  push-dispatch
grant select on private.user_limits to service_role;                                  -- 0001  ai-parse 等读每人上限

-- ===== 19. fn_vault、fn_ai 的白名单（0001 的表；会话变量版 RLS，6.2） =====
alter table private.counters enable row level security;
create policy fn_own on private.counters for all to fn_vault, fn_ai
  using (split_part(key, ':', 2) = nullif(current_setting('app.uid', true), ''))
  with check (split_part(key, ':', 2) = nullif(current_setting('app.uid', true), ''));
create policy fn_global on private.counters for all to fn_ai   -- 0.29 续第 34 条：全项目计数（fn_vault 不给）
  using (split_part(key, ':', 2) = 'global') with check (split_part(key, ':', 2) = 'global');
grant select, insert, update on private.counters to fn_vault, fn_ai;

alter table private.webauthn_challenges enable row level security;
create policy fn_own on private.webauthn_challenges for all to fn_vault
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.uid', true), '')::uuid);
grant select, insert, delete on private.webauthn_challenges to fn_vault;

alter table private.heartbeat enable row level security;
create policy fn_all on private.heartbeat for all to fn_ai using (true) with check (true);   -- noUserData
grant insert, update on private.heartbeat to fn_ai;

alter table private.user_limits enable row level security;
create policy fn_own on private.user_limits for select to fn_ai
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid);
grant select on private.user_limits to fn_ai;

create policy fn_own on public.devices for select to fn_vault
  using (user_id = nullif(current_setting('app.uid', true), '')::uuid);
grant select (id, user_id, deleted_at, session_id) on public.devices to fn_vault;   -- 核对草稿密钥的 device_id 和会话

-- ===== 20. 收尾：private 的表一律不给客户端角色（之后新建的表没有任何默认授权） =====
revoke all on all tables in schema private from public, anon, authenticated;         -- 0001

-- Realtime：同步的 9 张表各在自己的文件里进 publication（0.29 第 29 条，P-22）；tombstones 不进，增量同步按 deleted_at 拉
alter publication supabase_realtime add table public.settings, public.devices;
