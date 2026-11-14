-- B4b-2：ai-embed 的定时任务（架构 5.13 第 6 点“哪些需要重算：队列”、第 6 节 ai-embed 行“cron，每 2 分钟一次”）。
-- 照 20261110120000_notes_ai_classify_cron.sql 的写法：
-- • 每 2 分钟调一次 ai-embed，带 x-cron-secret、x-region: ap-northeast-2（14.2 第 5 点）；
-- • timeout_milliseconds := 55000：一轮最多 20 个人，每人一次批量嵌入（ai-embed/core.ts 的 EMBED_TIMEOUT_MS 20 秒）加几次直连查询；
-- • 迁移里不写任何值：functions_url、cron_secret 两条在数据库 Vault（和 ai-classify 等共用），任务的 SQL 每次运行时读；
--   cron.job 里只存这段 SQL 文本，pg_net 不记请求头，密钥不落日志；
-- • Vault 里没设时 url 为 null、请求发不出，ai-embed 没有心跳（private.heartbeat 'ai-embed'），lemo-ops 告警——不会静默；
-- • 不加授权：ai-embed 只用 0007、0001～0004 已给 fn_ai 的授权（ai-embed/store.ts 文件头逐项列出）；
-- • URL 写成 check_backend F9 认得出的 … 'functions_url') || '/ai-embed'，config.toml 的 [functions.ai-embed] verify_jwt = false 由 F9 ① 核对。
-- 回滚：select cron.unschedule('ai-embed');

select cron.schedule('ai-embed', '*/2 * * * *',
  $$select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/ai-embed',
      headers := jsonb_build_object('content-type', 'application/json', 'x-region', 'ap-northeast-2',
                   'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body := '{}'::jsonb, timeout_milliseconds := 55000)$$);
