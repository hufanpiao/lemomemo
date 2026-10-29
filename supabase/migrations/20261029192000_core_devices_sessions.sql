-- 20261029192000_core_devices_sessions.sql：B1 的设备、会话、时区上报、同意记录（架构 0.31 第 23 条：0001 里没有的 *_impl 在 B1 新建带时间戳的迁移，
--   文件名带 core；0001～0007 和 20261029191000 已过审，不改）
-- 依据：架构 3.3 D（public RPC）、3.3 C（授权白名单，下面每一句 grant 都和 3.3 C 标“B1 新迁移”的行一字不差）、4.6（时区）、
--   0.29 续第 98～118 条（移除设备、会话绑定、交接设备行、没有设备行的会话、每日清理）、0.29 续第 121 条（墓碑）
-- 依赖 S1 迁移 20261029191000_auth_password_session.sql 的 private.not_password_session()（本文件不定义它，只调用）
-- 3.3 通用规则（0.38 第 2 条）：新写的 security definer *_impl 开头一律同时查 account_usable 和 not_password_session()
--
-- 本文件：
--   ① private.report_tz_impl / public.report_tz             时区上报（4.6：手机优先、10 分钟防抖、fixed 不收）
--      private.enqueue_floating(uuid)                         浮动提醒入 remind_queue（report_tz 和下面的触发器共用，不授权）
--      private.tz_fixed_reset() + profiles_tz_fixed_reset     tz_mode 切到 fixed 时改回 Asia/Seoul（4.6、0.38 第 18 条）
--   ② private.remove_device_impl / public.remove_device     远程移除一台设备（第 98、99、101、103、109 条）
--   ③ private.rebind_device_impl                            重新验证邮箱后把设备行交接给新会话（第 104、112、119 条），只给 service_role
--   ④ private.my_sessions_impl / public.my_sessions         本人没有设备行的会话个数（第 111、118 条）
--   ⑤ private.record_consent_impl                           create or replace：B1 起 record_consent_impl 只在本文件定义（S1 迁移不再改它）
--   ⓪ devices.created_at                                    加列（0.38 第 8 条），table_meta 的 system_cols 同步
--   ⑥ private.cleanup_batch                                 create or replace：每日清理加设备和会话三项（第 98、101、108 条）
-- 墓碑拉取（第 121 条⑤）不用新对象：tombstones 表、tomb_sel 策略、(user_id, deleted_at) 索引、Realtime 都在 0001；
--   这里移除设备、清理设备行、删布局行都走硬删，write_tombstone() 照常留墓碑，客户端按 deleted_at > 游标 − 10 分钟拉

-- ===== ⓪ devices.created_at（0.38 第 8 条；0.29 续第 108 条“coalesce(last_seen_at, created_at) 超过 180 天”） =====
-- 系统列：客户端不授 insert / update（列级授权照 0001 不变），服务器的默认值写；已有的行由 add column 的默认值统一回填成 now()
--   （now() 在本事务里是同一个时刻；这些行是 B1 上线前的，最早也要 180 天后才会被清理）
alter table public.devices add column created_at timestamptz not null default now();
update private.table_meta set system_cols = '{last_push_ok_at,push_fail_count,created_at}' where tbl = 'devices';

-- ===== ① 时区上报（4.6；数据字典 profiles.current_tz*） =====
-- 防抖、“手机优先”和采纳次数的状态记在 private.counters（不新建表；三个键都过 counters 的三段键约束，附录 A 键表待架构师补）：
--   tzrep:<user_id>:<device_id>@<时区>   window_start = 这台设备第一次报这个新时区的时刻（时区名直接放在键里，按字符串比，不用哈希）
--   tzphone:<user_id>:last                window_start = 这个人的手机最近一次上报的时刻
--   tzacc:<user_id>:<UTC yyyymmddThh>      这一小时采纳了几次（每人每小时最多 6 次，超了回 rate_limited，等下一小时）
-- 30 天后随每日清理删掉（只用得到 10 分钟、1 小时和 24 小时）
-- 返回：accepted（采纳）、pending（等第二次）、unchanged（和现有值相同）、fixed（tz_mode = fixed 不收）、
--   phone_priority（电脑让手机）、rate_limited（这一小时采纳次数用完）
--   rate_limited 是 B1 新增的返回值：这次没采纳、pending 那一笔留着，客户端（K8）按“这次没采纳、稍后再报”处理（下一小时再报就采纳），
--   不当错误、不提示用户（已记入 B1 接手清单 K8-tz-rl）
-- 删“这台设备的 pending 键”用前缀范围：c.key collate "C" >= 'tzrep:<uid>:<device>@' and < 'tzrep:<uid>:<device>A'
--   （按字节比，'A' 紧挨在 '@' 后面，范围恰好是这个前缀，不依赖时区名里会出现哪些字符），再加 c.key like 'tzrep:%' 对上下面的部分索引。
--   explain（离线 PGlite，counters 一万行、enable_seqscan 开和关都一样）：原来的 left(key, n) = 前缀 是 Seq Scan；
--   不写 collate 的范围条件只在库默认排序规则是 C 时走得了主键（离线库是 C，真库不一定，非 C 排序规则下范围还可能不对）；
--   写了 collate "C" 又走不了主键（主键按列的默认排序规则建）。所以加 counters_tzrep_c，explain 为
--   Index Scan using counters_tzrep_c（Index Cond 里是这两个范围条件）。部分索引只收 tzrep 键，别的限流键写入不多一份索引
create index counters_tzrep_c on private.counters (key collate "C") where key like 'tzrep:%';
-- 浮动时刻（全天日程、待办、纪念日）里提醒还没到的记录入 remind_queue，交给下一分钟的 push-dispatch 按新时区重算（4.6“更新以后”）。
--   已完成的待办、已删除的、提醒已过的不入；主键去重，重复调用不重复入队。
--   security invoker、不授任何执行权（0001 的全局默认权限已收回 PUBLIC），只由属主是 postgres 的 security definer 函数调用：
--   report_tz_impl 和触发器函数 tz_fixed_reset()。所以 3.3 C 不加行
create function private.enqueue_floating(p_user uuid) returns void
  language plpgsql set search_path = '' as $$
declare now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  insert into private.remind_queue (table_name, id)
    select 'events', e.id from public.events e
     where e.user_id = p_user and e.deleted_at is null and e.time is null and e.remind_at > now_ms
  on conflict do nothing;
  insert into private.remind_queue (table_name, id)
    select 'todos', t.id from public.todos t
     where t.user_id = p_user and t.deleted_at is null and not t.done and t.remind_at > now_ms
  on conflict do nothing;
  insert into private.remind_queue (table_name, id)
    select 'anniversaries', a.id from public.anniversaries a
     where a.user_id = p_user and a.deleted_at is null and a.remind_at > now_ms
  on conflict do nothing;
end $$;

-- 顺序：身份（密码会话、账号、会话还在）→ 平台参数 → 本会话的设备行 → fixed / unchanged（不扫时区表）→ 时区名合法 → 手机优先 → 防抖
create function private.report_tz_impl(p_tz text, p_device uuid, p_platform text) returns text
  language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
  dev record;
  prof record;
  is_phone boolean;
  k_pre text; k_end text; k_rep text; k_phone text; k_acc text;
  pend_at timestamptz;
  n int;
begin
  if not private.not_password_session() then raise exception 'session_revoked'; end if;   -- 0.36（依赖 S1 迁移）
  if uid is null or not private.account_usable(uid) then raise exception 'account_disabled'; end if;
  begin
    sid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then sid := null;
  end;
  if not private.session_alive(sid) then raise exception 'session_revoked'; end if;   -- 被移除 / 被退出的那台在 10 分钟残留窗口里也不行
  if p_platform is null or p_platform not in ('ios', 'windows', 'web', 'tauri') then
    raise exception 'bad_platform' using errcode = '22023'; end if;
  if p_tz is null or char_length(p_tz) > 64 or p_tz like '%:%' then raise exception 'bad_tz' using errcode = '22023'; end if;
  -- 只认本人、本会话的那一行（第 99 条：设备行绑在会话上）；平台以行里登记的为准，和参数不一致就拒
  select d.id, d.platform into dev from public.devices d
   where d.id = p_device and d.user_id = uid and d.session_id = sid;
  if not found then raise exception 'device_mismatch'; end if;
  if dev.platform <> p_platform then raise exception 'platform_mismatch' using errcode = '22023'; end if;
  is_phone := dev.platform = 'ios';

  select p.tz_mode, p.current_tz into prof from public.profiles p where p.user_id = uid for update;
  k_pre := 'tzrep:' || uid::text || ':' || p_device::text || '@';
  k_end := 'tzrep:' || uid::text || ':' || p_device::text || 'A';   -- 前缀范围的上界（见本节开头）
  k_rep := k_pre || p_tz;
  k_phone := 'tzphone:' || uid::text || ':last';

  if is_phone then   -- 手机每次上报都记一笔（不论采不采纳），电脑据此让路
    delete from private.counters c where c.key = k_phone;
    insert into private.counters (key, window_start, count) values (k_phone, now(), 1);
  end if;

  if prof.tz_mode = 'fixed' then
    delete from private.counters c where c.key like 'tzrep:%' and c.key collate "C" >= k_pre and c.key collate "C" < k_end;
    return 'fixed';
  end if;
  if p_tz = prof.current_tz then
    delete from private.counters c where c.key like 'tzrep:%' and c.key collate "C" >= k_pre and c.key collate "C" < k_end;   -- 报回原值：之前那次“新时区”作废
    return 'unchanged';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_tz) then
    raise exception 'bad_tz' using errcode = '22023'; end if;
  if not is_phone and exists (select 1 from private.counters c where c.key = k_phone and c.window_start > now() - interval '24 hours') then
    delete from private.counters c where c.key like 'tzrep:%' and c.key collate "C" >= k_pre and c.key collate "C" < k_end;
    return 'phone_priority';
  end if;

  select c.window_start into pend_at from private.counters c where c.key = k_rep;
  if found and pend_at > now() - interval '10 minutes' then
    -- 同一台设备 10 分钟内第二次报同一个新时区：采纳（先过每人每小时的次数上限；超了留着这一笔，下一小时再报就采纳）
    k_acc := 'tzacc:' || uid::text || ':' || to_char(date_trunc('hour', now(), 'UTC') at time zone 'UTC', 'YYYYMMDD"T"HH24');
    insert into private.counters as c (key, window_start, count) values (k_acc, date_trunc('hour', now(), 'UTC'), 1)   -- 按 UTC 整点截断，不随会话时区
      on conflict (key, window_start) do update set count = c.count + 1
      returning c.count into n;
    if n > 6 then return 'rate_limited'; end if;
    delete from private.counters c where c.key like 'tzrep:%' and c.key collate "C" >= k_pre and c.key collate "C" < k_end;
    update public.profiles set current_tz = p_tz, current_tz_device = p_device, current_tz_at = now() where user_id = uid;
    perform private.enqueue_floating(uid);   -- 浮动提醒按新时区重算（主键去重，重复采纳不重复入队）
    return 'accepted';
  end if;
  -- 第一次报（或换了别的新时区、或上一次已超过 10 分钟）：这台设备只留这一笔
  delete from private.counters c where c.key like 'tzrep:%' and c.key collate "C" >= k_pre and c.key collate "C" < k_end;
  insert into private.counters (key, window_start, count) values (k_rep, now(), 1);
  return 'pending';
end $$;
grant execute on function private.report_tz_impl(text, uuid, text) to authenticated;   -- B1 新迁移（0.31 第 23 条）

create function public.report_tz(tz text, device_id uuid, platform text) returns text
  language sql security invoker set search_path = '' as $$ select private.report_tz_impl(tz, device_id, platform) $$;
revoke execute on function public.report_tz(text, uuid, text) from public, anon, service_role;
grant execute on function public.report_tz(text, uuid, text) to authenticated;

-- tz_mode 切到 fixed（4.6“current_tz 固定为 Asia/Seoul”；0.38 第 18 条，K-tz-fixed）：
--   current_tz 改回 Asia/Seoul、current_tz_device 置空、current_tz_at = now()；时区真的变了才把浮动提醒入队。
--   切回 device 不动 current_tz（等下一次 report_tz 采纳）。账号停用（account_usable 为假）时照样改回首尔，但不入队。客户端经列级授权只改 tz_mode 就会触发；改 NEW 的列不受列级授权限制。
--   security definer：客户端（authenticated）改 profiles 时要写 private.remind_queue；只用 NEW、OLD，不接受别的输入。
--   不授执行权（触发时不查 EXECUTE；0001 的全局默认权限已收回 PUBLIC），所以 3.3 C 不加行
create function private.tz_fixed_reset() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.tz_mode = 'fixed' and old.tz_mode is distinct from 'fixed' then
    -- 停用账号不入队（推送本来也不发）；current_tz 照样改回首尔
    if old.current_tz is distinct from 'Asia/Seoul' and private.account_usable(new.user_id) then
      perform private.enqueue_floating(new.user_id);
    end if;
    new.current_tz := 'Asia/Seoul';
    new.current_tz_device := null;
    new.current_tz_at := now();
  end if;
  return new;
end $$;
create trigger profiles_tz_fixed_reset before update of tz_mode on public.profiles
  for each row when (new.tz_mode is distinct from old.tz_mode) execute function private.tz_fixed_reset();

-- ===== ② 远程移除一台设备（0.29 续第 98、99、101、103、109 条） =====
-- 只认本人的设备；不许移除本机（这一行的 session_id 等于当前会话，回 is_current_device）；调用者自己的会话已吊销的也不行
--   （被移除的那台在 10 分钟残留窗口里不能反过来移除主人的设备）。
-- 顺序：先在 revoked_sessions 记下那台的会话 → 同一事务里删 auth.sessions（refresh token 跟着失效）→ 删这一 install_id 的布局行
--   （这个人没有别的设备行用着同一个 install_id 时）→ 删 devices 行（盐、推送订阅随外键删；墓碑由 write_tombstone() 写）。
-- session_id 为空的行（service role 建的旧行，第 103 条①）只删行、不碰 auth.sessions；会话在 auth.sessions 里却不属于本人
--   （正常不会出现）也只删行，不替别人的会话写吊销记录；会话已经不在了不用再记。
-- B1 实测：security definer 能删 auth.sessions 的行（第 101 条）；不行时走第三条路，这里改成只写 revoked_sessions
create function private.remove_device_impl(p_device uuid) returns void
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
    insert into private.revoked_sessions (session_id, user_id) values (dev.session_id, uid)
      on conflict (session_id) do nothing;
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
grant execute on function private.remove_device_impl(uuid) to authenticated;   -- B1 新迁移（0.31 第 23 条）  远程移除某一台设备（0.29 续第 98 条）

create function public.remove_device(p_device_id uuid) returns void
  language sql security invoker set search_path = '' as $$ select private.remove_device_impl(p_device_id) $$;
revoke execute on function public.remove_device(uuid) from public, anon, service_role;
grant execute on function public.remove_device(uuid) to authenticated;

-- ===== ③ 交接设备行（0.29 续第 104、112、119 条）：只给 service_role（account 函数验过两个令牌后经 PostgREST 的 rpc() 调） =====
-- 要求：那一行属于 p_user、当前绑着旧会话 p_old_session、旧会话还活着；新会话属于同一个人、还活着、没绑在别的设备行上。
-- 改 session_id 靠事务内的 lemo.rebind = 本行 id，加上请求角色 current_setting('role') = 'service_role'（devices_session_guard() 核对，第 112 条）；
--   直连数据库时 role 是 none，触发器把 session_id 保持原值，这里查到没改成就报 rebind_denied（第 119 条①：不放宽）。
-- 交接成功后按第 101 条吊销旧会话（写 revoked_sessions、删 auth.sessions）。限流（rebind:<user_id>:<UTC 日期>）由 account 函数经 take_rate 做
create function private.rebind_device_impl(p_user uuid, p_device uuid, p_old_session uuid, p_new_session uuid) returns void
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

  insert into private.revoked_sessions (session_id, user_id) values (p_old_session, p_user)
    on conflict (session_id) do nothing;
  delete from auth.sessions s where s.id = p_old_session and s.user_id = p_user;
end $$;
grant execute on function private.rebind_device_impl(uuid, uuid, uuid, uuid) to service_role;   -- B1 新迁移（0.31 第 23 条）  重新验证邮箱后把设备行交接给新会话（0.29 续第 104 条）

-- ===== ④ 没有设备行的会话（0.29 续第 111、118 条，R-191 已定 a） =====
-- 只回本人的两个数：不是当前会话、没有任何设备行绑着、不在 revoked_sessions、创建超过 2 分钟的会话个数，和它们里最近的活动时间；
--   不回会话 id、IP、UA。auth.sessions.refreshed_at 是不带时区的 timestamp（GoTrue 按 UTC 写），按 UTC 转
create function private.my_sessions_impl() returns table (orphan_count int, orphan_last_at timestamptz)
  language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
begin
  if not private.not_password_session() then raise exception 'session_revoked'; end if;   -- 0.36（依赖 S1 迁移）
  if uid is null or not private.account_usable(uid) then raise exception 'account_disabled'; end if;
  begin
    sid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then sid := null;
  end;
  if not private.session_alive(sid) then raise exception 'session_revoked'; end if;   -- 被移除 / 被退出的那台在 10 分钟残留窗口里不能再查
  return query
    select count(*)::int,
           max(coalesce(s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at))
      from auth.sessions s
     where s.user_id = uid
       and s.id <> sid
       and s.created_at < now() - interval '2 minutes'
       and not exists (select 1 from public.devices d where d.session_id = s.id)
       and not exists (select 1 from private.revoked_sessions r where r.session_id = s.id);
end $$;
grant execute on function private.my_sessions_impl() to authenticated;   -- B1 新迁移（0.31 第 23 条）  本人没有设备行的会话个数和最近时间（0.29 续第 111 条，R-191 已定）

create function public.my_sessions() returns table (orphan_count int, orphan_last_at timestamptz)
  language sql security invoker set search_path = '' as $$ select m.orphan_count, m.orphan_last_at from private.my_sessions_impl() m $$;
revoke execute on function public.my_sessions() from public, anon, service_role;
grant execute on function public.my_sessions() to authenticated;

-- ===== ⑤ 同意记录（3.3 D；第二轮安全 N1；0.38 第 2 条） =====
-- create or replace（属主和 0001 的执行权保留，这里不再 grant）。B1 起这个函数只有本文件这一份定义
--   （S1 迁移 20261029191000 不再改它，见那份文件的注释）。和 0001 的版本比，开头加了三句（3.3 通用规则、0.38 第 2 条、K1 安全审查）：
--   ① not_password_session()（依赖 S1 迁移，密码会话回 session_revoked）；
--   ② account_usable：0001 只在 update profiles 时滤 disabled_at，撤回分支照样给停用账号写 ai.enabled、删向量；
--   ③ session_alive：被移除 / 被退出的那台在 10 分钟残留窗口里不能撤回同意（撤回会删掉这个人全部向量）。
--   其余照 0001。以后再改这个函数，在比本文件更晚的迁移里连这三句一起写
create or replace function private.record_consent_impl(p_ver text, p_revoke boolean default false) returns void
  language plpgsql security definer set search_path = '' as $$
declare sid uuid;
begin
  if not private.not_password_session() then raise exception 'session_revoked'; end if;   -- 0.36：密码会话不能替用户同意 / 撤销 AI（依赖 S1 迁移）
  if (select auth.uid()) is null or not private.account_usable((select auth.uid())) then raise exception 'account_disabled'; end if;   -- B1：3.3 通用规则
  begin
    sid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then sid := null;
  end;
  if not private.session_alive(sid) then raise exception 'session_revoked'; end if;   -- B1：K1 安全审查必改 2
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

-- ===== ⑥ 每日清理加设备和会话三项（3.4；0.29 续第 98、101、108 条） =====
-- create or replace：0001 的各项逐字保留，在心跳之前加三项（同样按 left_ 分批）：
--   a. session_id 不为空、但会话已不在 auth.sessions 的设备行（“退出其他所有设备”、断网退出留下的；盐、布局行不删布局，第 109 条）；
--      session_id 为空的行不碰（第 103 条①）
--   b. 180 天没活动的设备行：先吊销会话（写 revoked_sessions、删 auth.sessions）再删行（第 108 条；和第 103 条冲突处以第 108 条为准，0.38 变更表第 14 条）。
--      “最后活动”取三者里最近的一个，三者都超过 180 天才删：
--        ① last_seen_at（客户端写的；比服务器时间快 1 天以上的不认，免得写个未来时间就永远不被清理）；
--        ② created_at（本文件 ⓪ 加的列，0.38 第 8 条；不用 synced_at：推送每次写 push_fail_count 都刷新它，死设备永远到不了 180 天）；
--        ③ 这台设备的会话在 auth.sessions 里的刷新时刻 coalesce(refreshed_at（按 UTC）, updated_at)（会话属于本人时才算）。
--      session_id 为空的行没有 ③，只看 ①②，180 天没活动照样删
--   c. revoked_sessions 里会话已不在 auth.sessions 的行（第 101 条：走第三条路时会话一直在，行就一直留着）
-- 第 109 条的“没人用的布局行 180 天后清掉”归 B6（TC-B6-15），不在这里
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
  delete from public.settings      where ctid in (select ctid from public.settings      where deleted_at < cut30 limit left_); get diagnostics k = row_count; left_ := left_ - k;
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
      insert into private.revoked_sessions (session_id, user_id) values (r.session_id, r.user_id) on conflict (session_id) do nothing;
      delete from auth.sessions s where s.id = r.session_id and s.user_id = r.user_id;
    end if;
    delete from public.devices d where d.id = r.id;
    left_ := left_ - 1;
  end loop;
  -- B1 c：会话已不在 auth.sessions 的吊销记录（第 101 条）
  delete from private.revoked_sessions rs where rs.ctid in (select y.ctid from private.revoked_sessions y
     where not exists (select 1 from auth.sessions s where s.id = y.session_id) limit left_);
  get diagnostics k = row_count; left_ := left_ - k;
  insert into private.heartbeat (name, at, detail)
    values ('cleanup', now(), jsonb_build_object('rows', p_limit - left_, 'ms', (extract(epoch from clock_timestamp() - t0) * 1000)::int))
    on conflict (name) do update set at = excluded.at, detail = excluded.detail;
  return p_limit - left_;
end $$;
