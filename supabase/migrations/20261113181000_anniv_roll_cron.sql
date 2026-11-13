-- B5 S13：anniv-roll 的定时任务（架构 5.4“倒数日到期后”、第 6 节 anniv-roll 行“cron，每天 00:10（UTC）”、0.38 第 46 条；B5 任务单 S13）。
-- 照 20261110120000_notes_ai_classify_cron.sql 的写法：
-- • 每天 00:10 UTC 调一次 anniv-roll，带 x-cron-secret、x-region: ap-northeast-2（14.2 第 5 点）；
-- • timeout_milliseconds := 55000：一轮最多 1000 行（anniv-roll/core.ts 的 BATCH），每行一次带条件的 update；
-- • 迁移里不写任何值：functions_url、cron_secret 两条在数据库 Vault（和 account-purge、push-dispatch、ai-classify 共用），任务的 SQL 每次运行时读；
--   cron.job 里只存这段 SQL 文本，pg_net 不记请求头，密钥不落日志；
-- • Vault 里没设时 url 为 null、请求发不出，anniv-roll 没有心跳——不会静默（usage-report 列心跳）；
-- • 任务以 postgres 跑；命令只经 pg_net 调函数、不直接碰表，挑可用账号在函数里（_shared/auth.ts 的 isUsable，经 private.account_usable）；
-- • URL 写成 check_backend F9 认得出的 … 'functions_url') || '/anniv-roll'，config.toml 的 [functions.anniv-roll] verify_jwt = false 由 F9 ① 核对。

select cron.schedule('anniv-roll', '10 0 * * *',
  $$select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/anniv-roll',
      headers := jsonb_build_object('content-type', 'application/json', 'x-region', 'ap-northeast-2',
                   'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body := '{}'::jsonb, timeout_milliseconds := 55000)$$);
