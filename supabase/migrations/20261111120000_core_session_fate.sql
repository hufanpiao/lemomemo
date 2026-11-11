-- 20261111120000_core_session_fate.sql：R-382 登录过期和被移除分开处理的后端部分（架构 4.1a 第 4 点，0.60 定稿；安全审 M1～M5、复审 N1、N2）
-- ① private.revoked_sessions 改结构：主键换成 pair_hash = sha256(session_id ':' user_id) 的 64 位小写十六进制；session_id、user_id 可空；
--    user_id 外键 on delete cascade → set null（注销不再级联删吊销记录，只清明文、留哈希）；session_id 部分索引（session_alive 等仍按它查）。
--    行触发器 revoked_sessions_row：insert 时没给 pair_hash 就按两个 id 算（给了就核对一致）；外键把 user_id 置空时同一步把 session_id 也置空。
-- ② private.revoke_session(p_session, p_user)：所有写吊销记录的地方统一走它（一处算哈希，重复吊销刷新 revoked_at）。
--    远程移除、rebind、180 天清理、申请注销改走它；改密码（auth.users 触发器）、revoke_my_sessions 新加。
--    管理员停用不吊销（架构 0.62，负责人定“只退出、不清本机”）：admin_set_disabled 保持 0001 原版，只靠 account_disabled 挡。
--    以后任何删 auth.sessions 的函数，同一函数里必须调它（D1 第 6 节核对，build/d1/session-revoke.ts）。
-- ③ public.session_fate(p_pair text)：不登录可调（anon、authenticated），只按 pair_hash 查，回 revoked / unknown 两个词；不查 auth.users、
--    不回答账号存不存在（原来的 gone 去掉，M1）。impl 是 volatile（要写 counters，M2）；库内全局总闸每分钟 600 次（键 sfate:global:<UTC 分钟>，
--    架构 0.61 定，不放宽 counters 的 check 约束），超了回 unknown，只在越线的那一次记一条 sfate-capped:global:<分钟>；越线之后先读计数、直接回 unknown，不再写 counters（安全审建议 1）。按 IP 限流在 Cloudflare 控制台（负责人加），不在库里。
-- ④ public.revoke_my_sessions(p_include_current boolean)：authenticated，只动 auth.uid() 本人的会话；false / null 吊掉除当前 JWT session_id 以外的全部，
--    true 连当前的一起；只写吊销记录、不删 auth.sessions（客户端成功后再调 GoTrue 的 signOut，由 GoTrue 删）。回吊掉的个数。
-- ⑤ 改密码触发器 auth.users after update of encrypted_password … when (coalesce(old, '') is distinct from coalesce(new, ''))：
--    把这个人当时的会话逐个 revoke_session；整段 begin … exception when others，出错只记 pwrevoke-fail:global:<分钟>，照常 return new。
--    when 里用 coalesce：GoTrue 整行回写时 null ↔ '' 不算改密码，不能因此把人踢下线。
--    注意：0001 的 users_guard_no_password（before 触发器）会把任何非空密码改回 ''，所以 4.0.0 里经 Admin API 改密码最后落库仍是 ''，
--    这个触发器不会跑（旧值本来就是 ''）——架构 0.61 接受这一点，等以后去掉 guard、开放密码时才真正起作用；
--    pgTAP 用临时表挂同一函数、同一 when 验“改密码判 removed”，并用 pg_get_triggerdef 钉住 auth.users 上的触发器定义。
-- ⑥ 每日清理 B1 c 改口径：revoked_at 超过 30 天、并且会话已不在 auth.sessions 才删（3.5 第 5 点、15.7 第 7 项；安全审 M1：会话还在的吊销记录不删，
--    否则 session_alive 会把一个被吊销、却还没删掉的会话重新当成活的）。
-- ⑦ private.security_events()：最近 15 分钟 sfate-capped、pwrevoke-fail 两个计数，给 usage-report heartbeat → lemo-ops 告警（6.1，复审建议 3）。
-- create or replace 的几个函数逐字照原版，只改写吊销记录那几句（account_request_deletion 补回 lock_timeout = 5s，见 20261031130000）。

-- ===== ① revoked_sessions 改结构 =====
create function private.session_pair_hash(p_session uuid, p_user uuid) returns text
  language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_session::text || ':' || p_user::text, 'UTF8')), 'hex')
$$;
revoke execute on function private.session_pair_hash(uuid, uuid) from public;   -- R-382  只给本迁移里的函数和触发器用（属主 postgres 调）

alter table private.revoked_sessions add column pair_hash text;
update private.revoked_sessions set pair_hash = private.session_pair_hash(session_id, user_id);   -- 旧行补算
alter table private.revoked_sessions alter column pair_hash set not null;
alter table private.revoked_sessions drop constraint revoked_sessions_pkey;
alter table private.revoked_sessions add constraint revoked_sessions_pkey primary key (pair_hash);
alter table private.revoked_sessions add constraint revoked_sessions_pair_hash_check check (pair_hash ~ '^[0-9a-f]{64}$');
alter table private.revoked_sessions alter column session_id drop not null, alter column user_id drop not null;
alter table private.revoked_sessions drop constraint revoked_sessions_user_id_fkey;
alter table private.revoked_sessions add constraint revoked_sessions_user_id_fkey foreign key (user_id) references auth.users on delete set null;
create index revoked_sessions_session_id_idx on private.revoked_sessions (session_id) where session_id is not null;   -- 复审 N2

create function private.revoked_sessions_row() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.session_id is null or new.user_id is null then
      if new.pair_hash is null then raise exception 'bad_revoke' using errcode = '22023'; end if;
    elsif new.pair_hash is null then
      new.pair_hash := private.session_pair_hash(new.session_id, new.user_id);
    elsif new.pair_hash <> private.session_pair_hash(new.session_id, new.user_id) then
      raise exception 'pair_hash_mismatch' using errcode = '22023';
    end if;
  elsif new.user_id is null and old.user_id is not null then
    new.session_id := null;   -- 注销真删：外键 set null 置空 user_id 时，明文 session_id 一起清掉，只留 pair_hash、revoked_at（M5）
  elsif new.session_id is not null and new.user_id is not null
        and (new.session_id is distinct from old.session_id or new.user_id is distinct from old.user_id) then
    new.pair_hash := private.session_pair_hash(new.session_id, new.user_id);
  end if;
  return new;
end $$;
revoke execute on function private.revoked_sessions_row() from public;   -- R-382  触发器函数，仅触发器调用
create trigger revoked_sessions_row before insert or update on private.revoked_sessions
  for each row execute function private.revoked_sessions_row();

-- ===== ② 统一的吊销入口 =====
create function private.revoke_session(p_session uuid, p_user uuid) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if p_session is null or p_user is null then raise exception 'bad_revoke' using errcode = '22023'; end if;
  insert into private.revoked_sessions as r (pair_hash, session_id, user_id, revoked_at)
    values (private.session_pair_hash(p_session, p_user), p_session, p_user, now())
    on conflict (pair_hash) do update set revoked_at = now();
end $$;
revoke execute on function private.revoke_session(uuid, uuid) from public;   -- R-382  不授执行权：只经下面这些 security definer 函数（属主 postgres）调

-- 远程移除（20261029192000 版）
create or replace function private.remove_device_impl(p_device uuid) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
  dev record;
begin
  if not private.not_password_session() then raise exception 'session_revoked'; end if;   -- 0.36（依赖 S1 迁移）
  if uid is null or not private.account_usable(uid) then raise exception 'account_disabled'; end if;
  begin
    sid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then sid := null;
  end;
  if not private.session_alive(sid) then raise exception 'session_revoked'; end if;
  if p_device is null then raise exception 'device_not_found'; end if;

  select d.id, d.session_id, d.install_id into dev from public.devices d
   where d.id = p_device and d.user_id = uid for update;
  if not found then raise exception 'device_not_found'; end if;   -- 别人的设备和不存在的一样回
  if dev.session_id is not null and dev.session_id = sid then raise exception 'is_current_device'; end if;

  if dev.session_id is not null
     and exists (select 1 from auth.sessions s where s.id = dev.session_id and s.user_id = uid) then
    perform private.revoke_session(dev.session_id, uid);   -- R-382：统一走 revoke_session
    delete from auth.sessions s where s.id = dev.session_id and s.user_id = uid;
  end if;
  -- 第 109 条：布局按安装存（layout.<页>@inst:<install_id>）；同一个 install_id 还有别的行（这台重新登录过）就留着
  if dev.install_id is not null and not exists (
       select 1 from public.devices o where o.user_id = uid and o.install_id = dev.install_id and o.id <> dev.id) then
    delete from public.settings s
     where s.user_id = uid and s.key like 'layout.%' and right(s.key, 42) = '@inst:' || dev.install_id::text;
  end if;
  delete from public.devices d where d.id = dev.id and d.user_id = uid;
end $$;

-- rebind 换掉旧会话（20261029192000 版）
create or replace function private.rebind_device_impl(p_user uuid, p_device uuid, p_old_session uuid, p_new_session uuid) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  dev record;
  got uuid;
begin
  if not private.not_password_session() then raise exception 'session_revoked'; end if;   -- 0.36（依赖 S1 迁移；service role 的令牌没有 amr，照常通过）
  if p_user is null or not private.account_usable(p_user) then raise exception 'account_disabled'; end if;
  if p_device is null or p_old_session is null or p_new_session is null or p_old_session = p_new_session then
    raise exception 'bad_rebind' using errcode = '22023'; end if;
  if not exists (select 1 from auth.sessions s where s.id = p_old_session and s.user_id = p_user)
     or not exists (select 1 from auth.sessions s where s.id = p_new_session and s.user_id = p_user) then
    raise exception 'session_mismatch'; end if;
  if not private.session_alive(p_old_session) or not private.session_alive(p_new_session) then
    raise exception 'session_revoked'; end if;

  -- 先锁住这个人的全部设备行（for update），两次交接同时拿同一个新会话时第二次排队、看得到第一次的结果，session_in_use 不会漏
  perform 1 from public.devices d where d.user_id = p_user order by d.id for update;   -- 按 id 顺序加锁，和别的多行加锁不互相等死
  select d.id, d.user_id, d.session_id into dev from public.devices d where d.id = p_device for update;
  if not found or dev.user_id <> p_user or dev.session_id is distinct from p_old_session then
    raise exception 'device_mismatch'; end if;
  if exists (select 1 from public.devices d where d.session_id = p_new_session and d.id <> p_device) then
    raise exception 'session_in_use'; end if;

  perform set_config('lemo.rebind', p_device::text, true);
  update public.devices d set session_id = p_new_session where d.id = p_device returning d.session_id into got;
  perform set_config('lemo.rebind', '', true);
  if got is distinct from p_new_session then raise exception 'rebind_denied'; end if;   -- 不是经 PostgREST 以 service_role 调的

  perform private.revoke_session(p_old_session, p_user);   -- R-382：统一走 revoke_session
  delete from auth.sessions s where s.id = p_old_session and s.user_id = p_user;
end $$;

-- 申请注销（20261029150000 版；20261031130000 的 lock_timeout 写回定义里）
create or replace function private.account_request_deletion(p_user uuid) returns timestamptz
  language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
  st text;
  pa timestamptz := now() + interval '7 days';
begin
  if p_user is null then raise exception 'bad_user' using errcode = '22023'; end if;
  if exists (select 1 from private.admins a where a.user_id = p_user) then raise exception 'admin_cannot_delete'; end if;
  -- 锁 profile 这一行：和 admin_set_disabled、并发的第二次申请互斥
  select case when p.disabled_at is null then 'ok' when p.disabled_reason = 'deletion' then 'deletion' else 'admin' end
    into st from public.profiles p where p.user_id = p_user for update;
  if st is null or st = 'admin' then raise exception 'account_disabled'; end if;
  if st = 'deletion' then raise exception 'account_pending_deletion'; end if;
  -- profile 能用却留着 pending_deletions 行（正常不会出现）：按这次申请重写，冷静期重新计
  insert into private.pending_deletions as d (user_id, requested_at, purge_after) values (p_user, now(), pa)
    on conflict (user_id) do update set requested_at = excluded.requested_at, purge_after = excluded.purge_after,
      notice_sent = false, purge_started_at = null;
  update public.profiles set disabled_at = now(), disabled_reason = 'deletion' where user_id = p_user;
  perform private.revoke_session(s.id, p_user) from auth.sessions s where s.user_id = p_user;   -- R-382：统一走 revoke_session
  delete from auth.sessions s where s.user_id = p_user;
  return pa;
end $$;

-- ===== ③ session_fate =====
create function private.session_fate_impl(p_pair text) returns text
  language plpgsql volatile security definer set search_path = '' set lock_timeout = '5s' as $$
declare
  m text := to_char(now() at time zone 'UTC', 'YYYYMMDD"T"HH24MI');
begin
  -- 先过总闸再看参数：格式不对的调用同样算次数。
  -- 已经超额的先读计数、直接回 unknown，不再写 counters（安全审建议 1：被刷的时候每次只读一行，不是每次写两行）
  if coalesce((select c.count from private.counters c
                where c.key = 'sfate:global:' || m and c.window_start = to_timestamp(floor(extract(epoch from now()) / 60) * 60)), 0) > 600 then   -- 已经越过线（601 起）
    return 'unknown';
  end if;
  if not private.take_rate('sfate:global:' || m, 600, 60) then
    -- 只有越线的那一次（第 601 次）走到这里：记一条 sfate-capped；并发同时越线的也只留一条
    insert into private.counters (key, window_start, count) values ('sfate-capped:global:' || m, date_trunc('minute', now()), 1)
      on conflict (key, window_start) do nothing;
    return 'unknown';
  end if;
  if p_pair is null or p_pair !~ '^[0-9a-f]{64}$' then return 'unknown'; end if;
  return case when exists (select 1 from private.revoked_sessions r where r.pair_hash = p_pair) then 'revoked' else 'unknown' end;
end $$;
grant execute on function private.session_fate_impl(text) to anon, authenticated;   -- R-382  session_fate 转调（会话已经没了，anon 也要能调）

create function public.session_fate(p_pair text) returns text
  language sql volatile security invoker set search_path = '' as $$ select private.session_fate_impl(p_pair) $$;
revoke execute on function public.session_fate(text) from public, service_role;
grant execute on function public.session_fate(text) to anon, authenticated;
grant usage on schema private to anon;   -- R-382：anon 只为执行 session_fate_impl；private 的表、视图对 anon 一律没有授权（03_roles_grants、D1 第 5 节）

-- ===== ④ revoke_my_sessions =====
create function private.revoke_my_sessions_impl(p_include_current boolean) returns int
  language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
  n int := 0;
  r record;
begin
  if not private.not_password_session() then raise exception 'session_revoked'; end if;
  if uid is null or not private.account_usable(uid) then raise exception 'account_disabled'; end if;
  begin
    sid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then sid := null;
  end;
  if not private.session_alive(sid) then raise exception 'session_revoked'; end if;
  for r in select s.id from auth.sessions s
            where s.user_id = uid and (coalesce(p_include_current, false) or s.id <> sid) loop
    perform private.revoke_session(r.id, uid);
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function private.revoke_my_sessions_impl(boolean) to authenticated;   -- R-382  设置 › 设备“退出其他所有设备”、global signOut 前先调

create function public.revoke_my_sessions(p_include_current boolean) returns int
  language sql security invoker set search_path = '' as $$ select private.revoke_my_sessions_impl(p_include_current) $$;
revoke execute on function public.revoke_my_sessions(boolean) from public, anon, service_role;
grant execute on function public.revoke_my_sessions(boolean) to authenticated;

-- ===== ⑤ 改密码触发器（复审 N1） =====
create function private.on_password_change() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform private.revoke_session(s.id, new.id) from auth.sessions s where s.user_id = new.id;
  exception when others then
    begin
      insert into private.counters as c (key, window_start, count)
        values ('pwrevoke-fail:global:' || to_char(now() at time zone 'UTC', 'YYYYMMDD"T"HH24MI'), date_trunc('minute', now()), 1)
        on conflict (key, window_start) do update set count = c.count + 1;
    exception when others then null;   -- 连记都记不进也不往外抛：不能卡住 GoTrue 改密码
    end;
  end;
  return new;
end $$;
revoke execute on function private.on_password_change() from public;   -- R-382  触发器函数，仅触发器调用
create trigger users_password_change_revoke after update of encrypted_password on auth.users
  for each row when (coalesce(old.encrypted_password, '') is distinct from coalesce(new.encrypted_password, ''))
  execute function private.on_password_change();

-- ===== ⑥ 每日清理（20261029210000 版；B1 b 改走 revoke_session，B1 c 改成按 30 天） =====
create or replace function private.cleanup_batch(p_limit int default 1000) returns int language plpgsql set search_path = '' as $$
declare left_ int := p_limit; k int; t0 timestamptz := clock_timestamp();
  cut30 bigint := ((extract(epoch from now()) - 30 * 86400) * 1000)::bigint;
  cut90 bigint := ((extract(epoch from now()) - 90 * 86400) * 1000)::bigint;
  r record;
begin
  -- 30 天前软删除的行（向量、vault_ai 靠外键级联；墓碑由触发器写）
  delete from public.events        where ctid in (select ctid from public.events        where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.todos         where ctid in (select ctid from public.todos         where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.anniversaries where ctid in (select ctid from public.anniversaries where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.note_images   where ctid in (select ctid from public.note_images   where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.note_files    where ctid in (select ctid from public.note_files    where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.notes         where ctid in (select ctid from public.notes         where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.categories    where ctid in (select ctid from public.categories    where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  -- 20261029210000：ai.vault、ai.enabled 不硬删（删了就回到默认值，ai.vault 的默认是打开）
  delete from public.settings      where ctid in (select ctid from public.settings      where deleted_at < cut30 and key not in ('ai.vault', 'ai.enabled') limit left_); get diagnostics k = row_count; left_ := left_ - k;
  -- 不同步的表
  delete from public.logs          where ctid in (select ctid from public.logs where t < cut90 limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.applied_ops   where ctid in (select ctid from public.applied_ops where at < now() - interval '7 days' limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from public.tombstones    where ctid in (select ctid from public.tombstones where deleted_at < now() - interval '30 days' limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from private.pending_signups     where ctid in (select ctid from private.pending_signups where expires_at < now() limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from private.webauthn_challenges where ctid in (select ctid from private.webauthn_challenges where expires_at < now() limit left_); get diagnostics k = row_count; left_ := left_ - k;
  delete from private.counters            where ctid in (select ctid from private.counters where window_start < now() - interval '30 days' limit left_); get diagnostics k = row_count; left_ := left_ - k;
  -- B1 a：会话已不在的设备行（第 98 条；session_id 为空的不碰）
  delete from public.devices d where d.ctid in (select x.ctid from public.devices x
     where x.session_id is not null and not exists (select 1 from auth.sessions s where s.id = x.session_id) limit left_);
  get diagnostics k = row_count; left_ := left_ - k;
  -- B1 b：180 天没用的设备行，先吊销会话再删（第 108 条）
  for r in select x.id, x.user_id, x.session_id from public.devices x
            where greatest(
                    case when x.last_seen_at <= now() + interval '1 day' then x.last_seen_at end,
                    x.created_at,
                    (select max(coalesce(s.refreshed_at at time zone 'UTC', s.updated_at)) from auth.sessions s
                      where x.session_id is not null and s.id = x.session_id and s.user_id = x.user_id)
                  ) < now() - interval '180 days'
            limit left_ loop
    if r.session_id is not null and exists (select 1 from auth.sessions s where s.id = r.session_id and s.user_id = r.user_id) then
      perform private.revoke_session(r.session_id, r.user_id);   -- R-382：统一走 revoke_session
      delete from auth.sessions s where s.id = r.session_id and s.user_id = r.user_id;
    end if;
    delete from public.devices d where d.id = r.id;
    left_ := left_ - 1;
  end loop;
  -- B1 c（R-382 改口径）：吊销记录按 revoked_at 留 30 天，到期并且会话已不在 auth.sessions 才删（不管明文清没清）；
  --   离线 30 天以内的丢失设备一联网还能经 session_fate 查出 revoked。
  --   安全审 M1：会话还在的不删——session_alive 只看这张表，删了它，一个被吊销却还没从 auth.sessions 删掉的会话就又活了
  delete from private.revoked_sessions rs where rs.ctid in (select y.ctid from private.revoked_sessions y
     where y.revoked_at < now() - interval '30 days'
       and (y.session_id is null or not exists (select 1 from auth.sessions s where s.id = y.session_id))
     limit left_);
  get diagnostics k = row_count; left_ := left_ - k;
  insert into private.heartbeat (name, at, detail)
    values ('cleanup', now(), jsonb_build_object('rows', p_limit - left_, 'ms', (extract(epoch from clock_timestamp() - t0) * 1000)::int))
    on conflict (name) do update set at = excluded.at, detail = excluded.detail;
  return p_limit - left_;
end $$;

-- ===== ⑦ 监控读数 =====
create function private.security_events() returns table (sfate_capped int, pw_revoke_failed int)
  language sql stable security definer set search_path = '' as $$
  select coalesce(sum(c.count) filter (where c.key like 'sfate-capped:global:%'), 0)::int,
         coalesce(sum(c.count) filter (where c.key like 'pwrevoke-fail:global:%'), 0)::int
    from private.counters c
   where c.window_start >= now() - interval '15 minutes'
     and (c.key like 'sfate-capped:global:%' or c.key like 'pwrevoke-fail:global:%')
$$;
grant execute on function private.security_events() to service_role;   -- R-382  usage-report heartbeat 读，lemo-ops 大于 0 告警（6.1，复审建议 3）
