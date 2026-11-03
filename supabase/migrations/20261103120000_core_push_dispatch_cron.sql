-- B2：push-dispatch 的定时任务（架构 5.3、第 6 节“pg_cron 怎么带 CRON_SECRET 调函数”、0.49 第 3 条（D3）；B2 任务单 BE-1 ③、M2）。
-- 照 20261029171000_core_account_purge_cron.sql 的写法：
-- • 每分钟调一次 push-dispatch，带 x-cron-secret、x-region: ap-northeast-2（14.2 第 5 点）；
-- • **timeout_milliseconds := 25000**（D3：不照搬 account-purge 的 5000；函数一轮最长 20 秒墙钟，见 push-dispatch/core.ts 的 ROUND_BUDGET_MS）；
-- • 迁移里不写任何值：functions_url、cron_secret 两条在数据库 Vault（和 account-purge 共用），任务的 SQL 每次运行时从 vault.decrypted_secrets 读；
--   cron.job 里只存这段 SQL 文本，pg_net 的 net._http_response 不记请求头，密钥不落日志；
-- • Vault 里没设时 url 为 null、请求发不出，push-dispatch 没有心跳，lemo-ops 5 分钟告警（6.1）——不会静默；
-- • 任务以 postgres 跑；命令只经 pg_net 调函数、不直接碰 public / private 的表，挑可用账号在函数里（_shared/auth.ts 的 isUsable，经 private.account_usable）；
-- • URL 写成 check_backend F9 认得出的 … 'functions_url') || '/push-dispatch'，config.toml 的 [functions.push-dispatch] verify_jwt = false 由 F9 ① 核对。
-- pg_cron、pg_net 两个扩展在 0001_core.sql 里已经建了。

select cron.schedule('push-dispatch', '* * * * *',
  $$select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/push-dispatch',
      headers := jsonb_build_object('content-type', 'application/json', 'x-region', 'ap-northeast-2',
                   'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body := '{}'::jsonb, timeout_milliseconds := 25000)$$);
