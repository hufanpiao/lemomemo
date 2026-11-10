-- B4：ai-classify 的定时任务（架构 5.2“pg_cron 每 2 分钟 → fn ai-classify（带 x-cron-secret）”、第 6 节、0.38 第 46 条；B4 任务单 S6）。
-- 照 20261103120000_core_push_dispatch_cron.sql 的写法：
-- • 每 2 分钟调一次 ai-classify，带 x-cron-secret、x-region: ap-northeast-2（14.2 第 5 点）；
-- • timeout_milliseconds := 55000：函数一轮最长 40 秒墙钟（ai-classify/core.ts 的 ROUND_BUDGET_MS），最后一个人的 AI 请求最多再 10 秒（CLASSIFY_TIMEOUT_MS）；
-- • 迁移里不写任何值：functions_url、cron_secret 两条在数据库 Vault（和 account-purge、push-dispatch 共用），任务的 SQL 每次运行时读；
--   cron.job 里只存这段 SQL 文本，pg_net 不记请求头，密钥不落日志；
-- • Vault 里没设时 url 为 null、请求发不出，ai-classify 没有心跳，lemo-ops 15 分钟告警（6.1）——不会静默；
-- • 任务以 postgres 跑；命令只经 pg_net 调函数，挑可用账号、查同意都在函数里；
-- • URL 写成 check_backend F9 认得出的 … 'functions_url') || '/ai-classify'，config.toml 的 [functions.ai-classify] verify_jwt = false 由 F9 ① 核对。

select cron.schedule('ai-classify', '*/2 * * * *',
  $$select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/ai-classify',
      headers := jsonb_build_object('content-type', 'application/json', 'x-region', 'ap-northeast-2',
                   'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body := '{}'::jsonb, timeout_milliseconds := 55000)$$);
