-- 20261031160000_ops_orphan_auth_users.sql：没有 profile 的 auth 用户数 private.orphan_auth_users()（接手清单 ORPHAN-alert；架构 0.38 第 29 条、3.3 C）。
-- 为什么：invite-signup 的 orphan_user（建了 auth 用户、补 profile 失败、删用户也失败）和 orphan_suspect（reused + 已存在，可能是上一版验证码晚到建出的用户）
--   原来只打到 Edge 函数日志，没人统计、不告警，日志保留时间也短。两种孤儿在库里都是同一个状态：auth.users 里有、public.profiles 里没有，
--   所以直接数库，不读日志。usage-report {part: heartbeat} 经 schema('private').rpc 调，返回体带 orphan_users；lemo-ops 大于 0 告警。
-- 口径：建号超过 10 分钟（created_at < now() - 10 分钟，正好 10 分钟前的不算）、profiles 没有这个 user_id 的行。
--   10 分钟 = pending_signups 的有效期：invite-signup 正在注册的那几秒（createUser 和补 profile 之间）不算；orphan_suspect 那个邮箱要等 pending 过期才停，
--   之后还在就该人工处理了。注销（account-purge）靠 deleteUser 级联删 profiles，auth 用户和 profile 一起没，不会算进来。
-- 只回个数和最近一个的建号时刻（没有时为 null），不回 id、邮箱：要查是谁，负责人按 invite-signup/core.ts 里 orphan_suspect 处的核对办法在 SQL Editor 查。
-- security definer：service_role 对 auth.users 没有 select 授权，由 postgres 拥有的定义者函数读；search_path 置空、lock_timeout 5s（同 20261031130000）。
-- 执行权：0001 的默认权限已收回 PUBLIC，这里只 grant 给 service_role（下面一句和 3.3 C、附录 A 标“B1 新迁移（ORPHAN-alert）”的行一字不差）。
-- auth.users 没有 created_at 索引（表归 supabase_auth_admin，这里不加），每 15 分钟扫一次全表、对 profiles 按主键反查；人少、表小，接受。
create function private.orphan_auth_users() returns table (orphans int, latest_at timestamptz)
  language sql stable security definer set search_path = '' set lock_timeout = '5s' as $$
  select count(*)::int, max(u.created_at)
    from auth.users u
   where u.created_at < now() - interval '10 minutes'
     and not exists (select 1 from public.profiles p where p.user_id = u.id)
$$;
grant execute on function private.orphan_auth_users() to service_role;   -- B1 新迁移（ORPHAN-alert）  usage-report heartbeat 数没有 profile 的 auth 用户（只回个数和最近时刻），lemo-ops 大于 0 告警（0.38 第 29 条）
