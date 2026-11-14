-- 20261115060000_core_api_tokens_revoke.sql：连接码随会话一起失效（后端安全审查第 1 条）。
-- 原来“退出全部设备”、改密码、管理员停用都只动会话，不碰 public.api_tokens（全部迁移里只有 0001 建表时出现过这张表）：
--   连接码不带会话，claude-intake 只看“没吊销、180 天内、账号能用”，人退出了、改了密码，旧连接码照样能往账号里写条目。
-- 改法：下面三处都顺带一句 update public.api_tokens set revoked_at = now() where user_id = … and revoked_at is null：
--   ① private.revoke_my_sessions_impl：只在 p_include_current = true（连本机一起，“退出全部设备”）时；false / null（“退出其他设备”）不动——
--      本机还登录着，连接码是本机设置页建的、本机也能在设置里逐个断开；
--   ② private.on_password_change：和吊销会话放在同一个 begin … exception 里（出错只记 pwrevoke-fail，不卡 GoTrue 改密码）；
--   ③ private.admin_set_disabled：只在停用（p_on = true）时；解除停用不复活连接码（要在设置里重新生成）。
-- 只改还没吊销的行（revoked_at is null）：已吊销的不刷新时间，也不撞 guard_token_revoke 的 token_already_revoked。
-- 函数体逐字照最新一版（revoke_my_sessions_impl 照 20261112090000，on_password_change 照 20261111120000，admin_set_disabled 照 0001），
--   各只多上面那一句；create or replace 保留属主和执行权。
-- 生成连接码时要求刚验过邮箱（otpFresh）这次不做：多一步操作，主持人定暂不做。
set local lock_timeout = '5s';

create or replace function private.revoke_my_sessions_impl(p_include_current boolean) returns integer
  language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid;
  n int := 0;
  r record;
begin
  sid := private.require_live_session();
  for r in select s.id from auth.sessions s
            where s.user_id = uid and (coalesce(p_include_current, false) or s.id <> sid) loop
    perform private.revoke_session(r.id, uid);
    n := n + 1;
  end loop;
  if coalesce(p_include_current, false) then update public.api_tokens set revoked_at = now() where user_id = uid and revoked_at is null; end if;
  return n;
end $$;

create or replace function private.on_password_change() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform private.revoke_session(s.id, new.id) from auth.sessions s where s.user_id = new.id;
    update public.api_tokens set revoked_at = now() where user_id = new.id and revoked_at is null;
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

create or replace function private.admin_set_disabled(p_user uuid, p_on boolean) returns void
  language plpgsql security definer set search_path = '' as $$
begin
  if p_on then
    update public.profiles set disabled_at = coalesce(disabled_at, now()), disabled_reason = 'admin' where user_id = p_user;
    update public.api_tokens set revoked_at = now() where user_id = p_user and revoked_at is null;
  elsif exists (select 1 from private.pending_deletions d where d.user_id = p_user) then
    update public.profiles set disabled_reason = 'deletion' where user_id = p_user;   -- 仍在注销冷静期
  else
    update public.profiles set disabled_at = null, disabled_reason = null where user_id = p_user;
  end if;
end $$;
