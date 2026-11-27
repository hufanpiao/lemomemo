-- B1 K3：account-purge 的定时任务（架构第 6 节“pg_cron 怎么带 CRON_SECRET 调函数”，0.38 第 46 条；account-purge 是第一个，
-- 以后 push-dispatch、ai-classify、anniv-roll、backup-daily 等 cron 函数一律照这个写法）。
-- • 每天 03:30（首尔）= 18:30 UTC（pg_cron 按 UTC）调一次 account-purge，带 x-cron-secret、x-region: ap-northeast-2（14.2 第 5 点）。
-- • **迁移里不写任何值**：functions_url、cron_secret 两条放数据库 Vault（vault.secrets），任务的 SQL 每次运行时从 vault.decrypted_secrets 读。
--   cron.job 里存的只是下面这段 SQL 文本，不含密钥；pg_net 的 net._http_response 不记请求头，密钥不落日志。
-- • 值由负责人运行 tools/keys/set-cron-secret.ps1 设（预览、正式各一次，和函数侧的 CRON_SECRET 一起换）；本机用 supabase/seed.sql 的假值。
--   Vault 里没设这两条时 url 为 null、请求发不出，account-purge 没有心跳，lemo-ops 告警——不会静默。
-- • 任务以 postgres 跑，不授任何角色读 vault.decrypted_secrets。
-- • 不经 private.account_usable：它要处理的正是冷静期里的账号（whitelist.ts 的 CRON_WITHOUT_USABLE 已登记原因）。
-- • D1 核对 cron 命令里没有写死的长串（build/d1/checks.ts 第 12 段，违规样例 d1-fixtures/27_cron_hardcoded_secret.psql）。
-- pg_cron、pg_net 两个扩展在 0001_core.sql 里已经建了。

select cron.schedule('account-purge', '30 18 * * *',   -- 03:30 首尔 = 18:30 UTC
  $$select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/account-purge',
      headers := jsonb_build_object('content-type', 'application/json', 'x-region', 'ap-northeast-2',
                   'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body := '{}'::jsonb, timeout_milliseconds := 5000)$$);
