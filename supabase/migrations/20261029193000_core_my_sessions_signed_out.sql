-- B1 迁移：my_sessions() 多返回一列 signed_out_device_ids uuid[]（架构 4.1、0.38 第 38 条；B1 接手清单 K-dev-signedout）
-- 设置 › 设备要把“行还在、会话已不在”的设备标“已退出”（仍可点“移除”）。客户端读不到 auth.sessions，所以由 my_sessions_impl 顺带算出来。
-- 不建视图：读 auth.sessions 的视图只能是 definer 视图，绕过 RLS 又经 PostgREST 暴露；my_sessions_impl 本来就读 auth.sessions、开头自查。
-- 20261029192000 已过 K1 审查，但还没推到预览库（架构 0.38 第 8 条；首次 db push 见接手清单 S2、K10-locktimeout）。
--   按 0.38 第 38 条“K1 已过审，不回头改它”单独新建本迁移，和 192000 在同一次 db push 里按文件名顺序执行：
--   drop 后重建 private.my_sessions_impl 和 public.my_sessions（返回类型变了，create or replace 改不了返回列）。
--   签名仍没有参数；授权行文字和 3.3 C 一字不差，重建后照旧 grant。
--
-- signed_out_device_ids：本人 devices 里下面三种行的 id（按 id 排序；没有就是空数组，不是 null）：
--   ① session_id 为空（架构 4.1 原文就把它算“已退出”：从没绑上会话，或绑定前的旧行）；
--   ② session_id 不在 auth.sessions 里（会话被删：退出登录、“退出其他所有设备”、过期清理）；
--   ③ session_id 在 private.revoked_sessions 里（被远程移除吊销、auth.sessions 那一行还没删干净的残留窗口）。
--   软删除的行（deleted_at 非空）不列。只回设备 id，不回会话 id；只看 d.user_id = 本人，别人的设备不会出现。当前这台的会话还在（开头 session_alive 已查过），不会出现。
-- orphan_count、orphan_last_at 两列沿用 20261029192000（0.29 续第 111、118 条），只改一处：会话只绑着软删除的设备行时也算 orphan（d.deleted_at is null，和 signed_out 同一口径）。

-- 不写 if exists：照迁移的惯例（建函数一律不写 if not exists），这两个函数在 20261029192000 里一定已建，不在就该当场报错
drop function public.my_sessions();
drop function private.my_sessions_impl();

-- devices.session_id 的部分索引（K-dev-signedout 复审）：orphan 子查询的 not exists (… d.session_id = s.id)、
--   rebind_device_impl 的 session_in_use、devices_session_guard 等都按 session_id 找行，原来只能扫整表；空值的行不进索引
create index devices_session_id_nn on public.devices (session_id) where session_id is not null;

create function private.my_sessions_impl()
  returns table (orphan_count int, orphan_last_at timestamptz, signed_out_device_ids uuid[])
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
    select o.n, o.last_at, x.ids
      from (select count(*)::int as n,
                   max(coalesce(s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at)) as last_at
              from auth.sessions s
             where s.user_id = uid
               and s.id <> sid
               and s.created_at < now() - interval '2 minutes'
               and not exists (select 1 from public.devices d where d.session_id = s.id and d.deleted_at is null)   -- 只绑着软删除设备行的会话也算 orphan（和 signed_out 同一口径）
               and not exists (select 1 from private.revoked_sessions r where r.session_id = s.id)) o
     cross join
           (select coalesce(array_agg(d.id order by d.id), '{}'::uuid[]) as ids
              from public.devices d
             where d.user_id = uid
               and d.deleted_at is null
               and (d.session_id is null
                    or not exists (select 1 from auth.sessions s where s.id = d.session_id and s.user_id = uid)
                    or exists (select 1 from private.revoked_sessions r where r.session_id = d.session_id))) x;
end $$;
grant execute on function private.my_sessions_impl() to authenticated;   -- B1 新迁移（0.31 第 23 条）  本人没有设备行的会话个数和最近时间（0.29 续第 111 条，R-191 已定）

create function public.my_sessions()
  returns table (orphan_count int, orphan_last_at timestamptz, signed_out_device_ids uuid[])
  language sql security invoker set search_path = '' as $$
  select m.orphan_count, m.orphan_last_at, m.signed_out_device_ids from private.my_sessions_impl() m $$;
revoke execute on function public.my_sessions() from public, anon, service_role;
grant execute on function public.my_sessions() to authenticated;
