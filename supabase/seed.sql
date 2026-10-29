-- 本机、CI 专用的种子数据（supabase db reset 在全部迁移之后执行；config.toml [db.seed]）。
-- 只写 pg_cron 调函数要用的两条 Vault 密钥（架构 0.38 第 46 条、第 6 节「pg_cron 怎么带 CRON_SECRET 调函数」）：
--   cron_secret   ：固定的假值，写明「仅本机」，和 supabase/functions/.env.example 里的 CRON_SECRET 相同（至少 32 字节）；
--   functions_url ：指本机网关 kong（数据库容器里用容器网络的主机名 kong:8000 访问）。
-- 预览、正式的真值由负责人运行 tools/keys/set-cron-secret.ps1 设（两边一起设），不经过这个文件。
-- 不造业务数据：RLS 测试在自己的事务里造数据（_helpers.psql 的 tests.seed()），跑完回滚。
-- 写法和 set-cron-secret.ps1 放进剪贴板的 SQL 相同：不存在就 create，已存在就 update，重复执行不报错。

do $lemo$ begin
  if exists (select 1 from vault.secrets where name = 'cron_secret') then
    perform vault.update_secret((select id from vault.secrets where name = 'cron_secret'), 'LOCAL-ONLY-fake-cron-secret-not-for-preview-or-prod');
  else
    perform vault.create_secret('LOCAL-ONLY-fake-cron-secret-not-for-preview-or-prod', 'cron_secret');
  end if;
end $lemo$;

do $lemo$ begin
  if exists (select 1 from vault.secrets where name = 'functions_url') then
    perform vault.update_secret((select id from vault.secrets where name = 'functions_url'), 'http://kong:8000/functions/v1');
  else
    perform vault.create_secret('http://kong:8000/functions/v1', 'functions_url');
  end if;
end $lemo$;
