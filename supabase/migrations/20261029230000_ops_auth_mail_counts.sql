-- B1 OPS-mail-src：验证码发信量 private.auth_mail_counts()（架构 0.38 第 12 条、15.6 第 4d 条 ①、3.3 C；B1 接手清单 OPS-mail-src 方案 A）
-- usage-report {part: heartbeat} 经 supabase-js 的 schema('private').rpc 调，返回体的 auth_mail.auth_1h 取这里的 auth_1h；lemo-ops 超过 20 封告警。
-- 只给 service_role：先收回 public、anon、authenticated，再只 grant service_role（下面两句和 3.3 C 标“B1 新迁移”的行一字不差）。
-- security definer：service_role 对 auth.audit_log_entries 没有授权，由 postgres 拥有的定义者函数读；只回两个计数，不回邮箱、IP、user_id。
--
-- 数哪个 action（10-29 在本机快照库 lemo-opssnap 实测，GoTrue 随 supabase CLI v2.120.0）：
--   ① 已注册、已确认的邮箱 POST /auth/v1/otp（signInWithOtp，create_user=false）→ 发出 1 封验证码，audit_log 记 1 行
--      payload->>'action' = 'user_recovery_requested'（log_type = 'user'）；
--   ② 60 秒内再请求一次 → 429 over_email_send_rate_limit，不发信，也不记；
--   ③ 没注册的邮箱 → 422 signup_disabled，不发信，不记；admin 建用户只记 user_signedup（不发信）。
--   所以只数 user_recovery_requested。注意（有意接受，回报里写明）：admin.generateLink({type: 'magiclink'})（invite-signup 用）
--   **不发信，但也记一行 user_recovery_requested**，payload 和真发信的一样、分不出来；所以 auth_1h 会把这一小时的邀请注册数一起算进去，
--   只会多不会少（告警线 20 封，邀请注册本身有每天的总量限流）。
-- 过去 1 小时 / 24 小时：created_at 晚于 now() 减 1 小时 / 24 小时（正好 1 小时前的那一行不算）；24 小时那个数给手动处理时看，lemo-ops 现在只用 auth_1h。
-- audit_log_entries 没有 created_at 索引（表归 supabase_auth_admin，这里不加），每 15 分钟扫一次全表；人少、表小，接受。
create function private.auth_mail_counts() returns table (auth_1h int, auth_24h int)
  language sql stable security definer set search_path = '' as $$
  select (count(*) filter (where e.created_at > now() - interval '1 hour'))::int,
         count(*)::int
    from auth.audit_log_entries e
   where e.created_at > now() - interval '24 hours'
     and e.payload->>'action' = 'user_recovery_requested'
$$;
revoke execute on function private.auth_mail_counts() from public, anon, authenticated;   -- B1 新迁移（0.38 第 12 条）  发信量只给服务器函数
grant execute on function private.auth_mail_counts() to service_role;   -- B1 新迁移（0.38 第 12 条）  usage-report 读过去 1 小时 / 24 小时的验证码发信数（15.6 第 4d 条 ①）
