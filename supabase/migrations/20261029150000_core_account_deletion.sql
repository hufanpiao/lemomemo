-- 20261029150000_core_account_deletion.sql：B1 K3 注销冷静期的两个数据库函数（申请注销、恢复）
-- 依据：架构第 6 节 account delete 和“account-purge 怎么执行”（0.38 第 24 条，S9）、0.29 续第 101、131、134、138 条；
--   TC-B1-95、98、100、103、104、108。只给 service_role（account 函数经 supabase-js 的 schema('private').rpc 调），
--   anon、authenticated 没有执行权（0001 的全局默认权限 + 这里只 grant 一个角色）。
-- 为什么要两个 security definer 函数、不在函数里分几次 PostgREST 调用：
--   ① 申请注销要“在一个事务里”写 pending_deletions、停用 profile、吊销全部会话（写 revoked_sessions、删 auth.sessions，第 101 条那一套）；
--      service_role 对 auth.sessions、private.revoked_sessions 都没有授权，只能由 postgres 拥有的 definer 函数做（同 remove_device_impl）。
--   ② restore 要先 `select … for update` 锁住 pending_deletions 这一行再判断（第 138 条③），和 account-purge 的认领（单条 update）互斥：
--      account-purge 认领时等这把锁，restore 提交后这一行已不在，认领不到（TC-B1-108 ②）。PostgREST 一次请求做不到“先锁再判断再改两张表”。
-- account-purge 不用这里的函数：它只用 service role 已有的表授权和 auth.admin.deleteUser（0.38 第 24 条）。
-- 函数名不带 _impl：不是给 authenticated 经 public 包装调的那一类（3.3 通用规则“*_impl 开头查 not_password_session”管的是那一类）；
--   调用方 account 函数已经过 requireActiveUser（含密码会话、会话吊销检查），这里的 p_user 只来自验过的 JWT。

-- ===== ① 申请注销（account delete） =====
-- 管理员一律拒（admin_cannot_delete，安全审查高 1）；profile 不在或已停用拒（account_disabled / account_pending_deletion）；
-- 然后同一事务里：写 pending_deletions（purge_after = now() + 7 天，冷静期写死在这里，不由调用方传）→ 停用 profile（disabled_reason = 'deletion'）
-- → 这个人在 auth.sessions 里的全部会话记进 revoked_sessions → 删 auth.sessions（refresh token 跟着失效）。不删任何数据、不写 deleted_accounts。
-- 返回 purge_after（发第一封信要写这个时刻）。
-- 停用 profile 时 guard_profile_disabled 触发器看 current_setting('role')：调用方是 service_role，放行。
create function private.account_request_deletion(p_user uuid) returns timestamptz
  language plpgsql security definer set search_path = '' as $$
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
  insert into private.revoked_sessions (session_id, user_id)
    select s.id, s.user_id from auth.sessions s where s.user_id = p_user
    on conflict (session_id) do nothing;
  delete from auth.sessions s where s.user_id = p_user;
  return pa;
end $$;
grant execute on function private.account_request_deletion(uuid) to service_role;   -- B1 新迁移（0.38 第 24 条，K3）  account delete：申请注销、吊销全部会话（0.29 续第 131 条）

-- ===== ② 恢复（account restore） =====
-- 先锁 pending_deletions 这一行，再按顺序判断（第 131 条④、第 134 条④、第 138 条③）：
--   没有这一行 → not_pending；purge_started_at 不为空（account-purge 已认领）→ purge_started；purge_after 已到 → expired；
--   profile 的 disabled_reason 不是 deletion（冷静期里被管理员停用）→ account_disabled，什么都不改。
-- 都过了：删掉这一行，清空 disabled_at 和 disabled_reason，返回 ok。
-- otp 是否在 10 分钟内、每天 5 次（restore:<user_id>:<UTC 日期>）由 account 函数在调用前判断（要读 JWT 的 amr，SQL 这边没有）。
create function private.account_restore(p_user uuid) returns text
  language plpgsql security definer set search_path = '' as $$
declare
  d record;
  r text;
begin
  if p_user is null then raise exception 'bad_user' using errcode = '22023'; end if;
  select pd.purge_after, pd.purge_started_at into d from private.pending_deletions pd where pd.user_id = p_user for update;
  if not found then return 'not_pending'; end if;
  if d.purge_started_at is not null then return 'purge_started'; end if;
  if d.purge_after <= now() then return 'expired'; end if;
  select p.disabled_reason into r from public.profiles p where p.user_id = p_user for update;
  if r is distinct from 'deletion' then return 'account_disabled'; end if;
  delete from private.pending_deletions pd where pd.user_id = p_user;
  update public.profiles set disabled_at = null, disabled_reason = null where user_id = p_user;
  return 'ok';
end $$;
grant execute on function private.account_restore(uuid) to service_role;   -- B1 新迁移（0.38 第 24 条，K3）  account restore：冷静期里恢复，和 account-purge 的认领互斥（0.29 续第 131、134、138 条）
