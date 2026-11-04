-- B1 PURGE-cpu-budget 返工（B1 代码审查高 1，主持人 11-04 定）：account-purge 的补跑。
-- account-purge 每次运行按调用次数停手（core.ts 的 PURGE_WORK_OPS、REMIND_WORK_OPS），一轮做不完的、超了上限没发的提醒，
-- 交给 15 分钟后的补跑接着做，不用等到第二天。
-- • 时刻：03:30（首尔）那一次照旧由 20261029171000 的 'account-purge' 任务调（不改旧迁移）；这里加 03:45～05:30 每 15 分钟一次，
--   时区跟现有 cron 一致（pg_cron 按 UTC：首尔 03:45～05:30 = UTC 18:45～20:30）。一条 cron 表达式写不出“18:45 起到 20:30 止”，
--   所以分三条：18:45；19:00～19:45 每 15 分钟；20:00、20:15、20:30。合起来一天 9 次（含 03:30）。
-- • 每次调用都先发提醒、再删除，两段都幂等（发过的不再发、删过的再列是空的、认领 1 小时内互斥），多跑不会多删、不会重复提醒；
--   没有待删、待提醒的账号时，函数只做几次小查询就返回。cron 每 15 分钟一次、函数一次最长 110 秒墙钟，前后两次不会重叠。
-- • 命令和 20261029171000 一字不差（timeout_milliseconds := 5000：pg_net 超时后函数照样跑完，B1-left-pgnet-timeout 执行记录）：
--   迁移里不写任何值，functions_url、cron_secret 运行时从 vault.decrypted_secrets 读；命令不碰 public / private 的表，
--   所以不进 build/d1/whitelist.ts 的 CRON_WITHOUT_USABLE（D1 只查动用户表的任务）；URL 写成 … 'functions_url') || '/account-purge'，
--   config.toml 的 [functions.account-purge] verify_jwt = false 由 check_backend F9 核对（已有）。
-- • 心跳：每次运行都写 account-purge 心跳，lemo-ops 的 26 小时规则不变（多了补跑只会更新得更勤）。
-- pg_cron、pg_net 两个扩展在 0001_core.sql 里已经建了。

select cron.schedule('account-purge-catchup-1', '45 18 * * *',   -- 03:45 首尔
  $$select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/account-purge',
      headers := jsonb_build_object('content-type', 'application/json', 'x-region', 'ap-northeast-2',
                   'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

select cron.schedule('account-purge-catchup-2', '*/15 19 * * *',   -- 04:00、04:15、04:30、04:45 首尔
  $$select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/account-purge',
      headers := jsonb_build_object('content-type', 'application/json', 'x-region', 'ap-northeast-2',
                   'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

select cron.schedule('account-purge-catchup-3', '0,15,30 20 * * *',   -- 05:00、05:15、05:30 首尔
  $$select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/account-purge',
      headers := jsonb_build_object('content-type', 'application/json', 'x-region', 'ap-northeast-2',
                   'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body := '{}'::jsonb, timeout_milliseconds := 5000)$$);
